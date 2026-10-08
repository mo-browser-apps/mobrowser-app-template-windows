import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const recordVersion = 1;
const recordDirectory = join(
  homedir(),
  'Library',
  'Application Support',
  'mobrowser-sign',
  'keychain-recovery',
);

export type MacKeychainRecoveryRecord = {
  path: string;
  keychain: string;
  temporaryDirectory: string;
};

type StoredRecord = {
  version: number;
  keychain: string;
  temporaryDirectory: string;
};

/**
 * Records the temporary keychain before it is created. The record survives a
 * forced termination but contains no certificate or password material.
 */
export async function createMacKeychainRecoveryRecord(
  keychain: string,
  temporaryDirectory: string,
  recoveryDirectory = recordDirectory,
): Promise<MacKeychainRecoveryRecord> {
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
  await chmod(recoveryDirectory, 0o700);

  const recordPath = join(recoveryDirectory, `${randomUUID()}.json`);
  const stored: StoredRecord = {
    version: recordVersion,
    keychain,
    temporaryDirectory,
  };
  await writeFile(recordPath, `${JSON.stringify(stored)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return { path: recordPath, keychain, temporaryDirectory };
}

/** Lists only well-formed records for keychains created by this CLI. */
export async function listMacKeychainRecoveryRecords(
  recoveryDirectory = recordDirectory,
): Promise<MacKeychainRecoveryRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(recoveryDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const records: MacKeychainRecoveryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const path = join(recoveryDirectory, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      // A release may be interrupted while this record is being written. Leave
      // the unknown file in place, but do not let it block recovery of valid
      // temporary keychains or a future release.
      continue;
    }
    if (!isStoredRecord(parsed)) {
      continue;
    }
    records.push({
      path,
      keychain: parsed.keychain,
      temporaryDirectory: parsed.temporaryDirectory,
    });
  }
  return records;
}

export async function removeMacKeychainRecoveryRecord(
  record: MacKeychainRecoveryRecord,
): Promise<void> {
  await rm(record.path, { force: true });
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Partial<StoredRecord>).version !== recordVersion ||
    typeof (value as Partial<StoredRecord>).keychain !== 'string' ||
    typeof (value as Partial<StoredRecord>).temporaryDirectory !== 'string'
  ) {
    return false;
  }

  const temporaryDirectory = resolve((value as StoredRecord).temporaryDirectory);
  const expectedKeychain = join(temporaryDirectory, 'signing.keychain-db');
  const temporaryPrefix = join(resolve(tmpdir()), 'mobrowser-sign-keychain-');
  return (
    temporaryDirectory.startsWith(temporaryPrefix) &&
    resolve((value as StoredRecord).keychain) === expectedKeychain
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
