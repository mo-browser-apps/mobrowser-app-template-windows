import { randomBytes } from 'node:crypto';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createMacKeychainRecoveryRecord,
  listMacKeychainRecoveryRecords,
  removeMacKeychainRecoveryRecord,
  type MacKeychainRecoveryRecord,
} from './mac-keychain-recovery.js';
import { errorMessage, runMacCommand } from './mac-command.js';
import type { SigningMaterial } from './model.js';
import { resolveBundledDeveloperIdIntermediate } from './mac-signing.js';

export type TemporaryKeychain = {
  dispose: () => Promise<void>;
};

/** Creates and installs an isolated signing keychain for one release. */
export async function createTemporarySigningKeychain(
  material: Pick<SigningMaterial, 'signingP12Path' | 'p12Password' | 'codesignIdentity'>,
): Promise<TemporaryKeychain> {
  await access(material.signingP12Path);

  const directory = await mkdtemp(join(tmpdir(), 'mobrowser-sign-keychain-'));
  const keychain = join(directory, 'signing.keychain-db');
  const password = randomBytes(32).toString('base64url');
  const recoveryRecord = await createMacKeychainRecoveryRecord(keychain, directory);
  let keychainCreated = false;

  try {
    await runMacCommand('security', ['create-keychain', '-p', password, keychain]);
    keychainCreated = true;
    await runMacCommand('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    await runMacCommand('security', ['unlock-keychain', '-p', password, keychain]);
    await runMacCommand('security', [
      'import',
      material.signingP12Path,
      '-k',
      keychain,
      '-P',
      material.p12Password,
      '-T',
      '/usr/bin/codesign',
    ]);
    const issuer = await getSigningCertificateIssuer(keychain, material.codesignIdentity);
    const intermediate = await resolveBundledDeveloperIdIntermediate(issuer);
    await runMacCommand('security', ['import', intermediate, '-k', keychain]);
    await runMacCommand('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    const currentSearchList = await runMacCommand('security', ['list-keychains', '-d', 'user'], {
      captureOutput: true,
    });
    const searchList = await withoutKeychain(parseKeychainList(currentSearchList.stdout), keychain);
    await runMacCommand('security', [
      'list-keychains',
      '-d',
      'user',
      '-s',
      keychain,
      ...searchList,
    ]);

    return {
      dispose: onceAsync(() =>
        disposeTemporaryKeychain({ directory, keychain, keychainCreated, recoveryRecord }),
      ),
    };
  } catch (error) {
    await disposeTemporaryKeychain({ directory, keychain, keychainCreated, recoveryRecord }).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function assertSigningIdentityAvailable(codesignIdentity: string): Promise<void> {
  const identities = await runMacCommand('security', ['find-identity', '-v', '-p', 'codesigning'], {
    captureOutput: true,
  });
  if (!`${identities.stdout}\n${identities.stderr}`.includes(codesignIdentity)) {
    throw new Error(
      `The temporary signing keychain does not contain the expected identity: ${codesignIdentity}. Check MACOS_SIGNING_P12_PATH and MACOS_SIGNING_P12_PASSWORD.`,
    );
  }
}

export async function recoverInterruptedTemporaryKeychains(): Promise<void> {
  for (const recoveryRecord of await listMacKeychainRecoveryRecords()) {
    await disposeTemporaryKeychain({
      directory: recoveryRecord.temporaryDirectory,
      keychain: recoveryRecord.keychain,
      recoveryRecord,
    });
    console.log(`Recovered interrupted temporary signing keychain: ${recoveryRecord.keychain}`);
  }
}

type TemporaryKeychainCleanup = {
  directory: string;
  keychain: string;
  keychainCreated?: boolean;
  recoveryRecord: MacKeychainRecoveryRecord;
};

async function disposeTemporaryKeychain({
  directory,
  keychain,
  keychainCreated = true,
  recoveryRecord,
}: TemporaryKeychainCleanup): Promise<void> {
  const errors: unknown[] = [];
  try {
    await removeTemporaryKeychainFromSearchList(keychain);
  } catch (error) {
    errors.push(error);
  }
  if (keychainCreated && (await pathExists(keychain))) {
    try {
      await runMacCleanupCommand('security', ['delete-keychain', keychain]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new Error(errors.map(errorMessage).join('; '));
  }
  await removeMacKeychainRecoveryRecord(recoveryRecord);
}

async function removeTemporaryKeychainFromSearchList(keychain: string): Promise<void> {
  const current = parseKeychainList(
    (
      await runMacCleanupCommand('security', ['list-keychains', '-d', 'user'], {
        captureOutput: true,
      })
    ).stdout,
  );
  const updated = await withoutKeychain(current, keychain);
  if (updated.length === current.length) {
    return;
  }
  if (updated.length === 0) {
    throw new Error(
      'Refusing to leave the user keychain search list empty during temporary-keychain cleanup.',
    );
  }
  await runMacCleanupCommand('security', ['list-keychains', '-d', 'user', '-s', ...updated]);
}

/** Cleanup must remain available after the release interruption flag is set. */
function runMacCleanupCommand(
  command: string,
  args: string[],
  options: { captureOutput?: boolean } = {},
) {
  return runMacCommand(command, args, { ...options, allowDuringInterruption: true });
}

async function getSigningCertificateIssuer(keychain: string, identity: string): Promise<string> {
  const certificate = await runMacCommand(
    'security',
    ['find-certificate', '-c', identity, '-p', keychain],
    { captureOutput: true },
  );
  const issuer = await runMacCommand(
    'openssl',
    ['x509', '-noout', '-issuer', '-nameopt', 'RFC2253'],
    {
      captureOutput: true,
      input: certificate.stdout,
    },
  );
  return issuer.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withoutKeychain(keychains: string[], keychain: string): Promise<string[]> {
  const expected = await canonicalPath(keychain);
  const matches = await Promise.all(
    keychains.map(async (candidate) => (await canonicalPath(candidate)) === expected),
  );
  return keychains.filter((_, index) => !matches[index]);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function parseKeychainList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter((line) => line.length > 0);
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => {
    active ??= action();
    return active;
  };
}
