import { release as operatingSystemRelease } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  assertNoMountedProjectPackagingDmgs,
  findNewDirectArtifact,
  macBuildOutputDirectory,
  removePreviousMacBuildOutput,
} from '../../mac-artifacts.js';
import { errorMessage, runMacCommand, terminateActiveMacCommandTrees } from '../../mac-command.js';
import {
  assertSigningIdentityAvailable,
  createTemporarySigningKeychain,
  recoverInterruptedTemporaryKeychains,
} from '../../mac-keychain.js';
import { registerReleaseInterruptionHandler } from '../../common/release-interruption.js';
import { assertExpectedMacSigningIdentity, assertMacTools } from '../../mac-signing.js';
import type { SigningMaterial } from '../../common/model.js';

/** Coordinates the macOS release workflow using focused keychain, artifact, and signing services. */
export async function executeMacRelease(
  projectDirectory: string,
  material: SigningMaterial,
): Promise<string> {
  const unregisterInterruption = registerReleaseInterruptionHandler((signal) =>
    terminateActiveMacCommandTrees(signal),
  );
  try {
    assertMacExecutionEnvironment();
    await assertMacTools();
    await recoverInterruptedTemporaryKeychains();
    const projectRoot = resolve(projectDirectory);
    const outputDirectory = macBuildOutputDirectory(projectRoot);
    await assertNoMountedProjectPackagingDmgs(projectRoot);
    await removePreviousMacBuildOutput(projectRoot);
    const temporaryKeychain = await createTemporarySigningKeychain(material);
    let releaseError: unknown;

    try {
      await assertSigningIdentityAvailable(material.codesignIdentity);

      const buildStartedAt = Date.now();
      await runMacCommand('npm', ['run', 'build'], {
        cwd: projectRoot,
        env: buildEnvironment(material),
      });
      const appPath = await findNewDirectArtifact(
        join(outputDirectory, 'bin'),
        (path) => path.endsWith('.app'),
        buildStartedAt,
      );
      if (appPath === undefined) {
        throw new Error(`No newly built app bundle was found under ${outputDirectory}.`);
      }

      await runMacCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
      const signatureDetails = await runMacCommand('codesign', ['-dvvv', appPath], {
        captureOutput: true,
      });
      assertExpectedMacSigningIdentity(
        `${signatureDetails.stdout}\n${signatureDetails.stderr}`,
        material,
      );
      await runMacCommand('xcrun', ['stapler', 'validate', appPath]);
      await runMacCommand('spctl', [
        '--assess',
        '--type',
        'exec',
        '--context',
        'context:primary-signature',
        '--verbose=4',
        appPath,
      ]);

      const packStartedAt = Date.now();
      await runMacCommand('npm', ['run', 'pack'], {
        cwd: projectRoot,
        env: buildEnvironment(material),
      });
      const dmgPath = await findNewDirectArtifact(
        join(outputDirectory, 'pack'),
        (path) => path.endsWith('.dmg') && !basename(path).startsWith('rw.'),
        packStartedAt,
      );
      if (dmgPath === undefined) {
        throw new Error(`No newly packaged DMG was found under ${outputDirectory}.`);
      }
      return dmgPath;
    } catch (error) {
      releaseError = error;
      throw error;
    } finally {
      try {
        await temporaryKeychain.dispose();
      } catch (cleanupError) {
        if (releaseError === undefined) {
          throw cleanupError;
        }
        console.error(
          `Warning: could not fully remove the temporary signing keychain: ${errorMessage(cleanupError)}`,
        );
      }
    }
  } finally {
    unregisterInterruption();
  }
}

export type MacExecutionEnvironmentOptions = {
  platform?: NodeJS.Platform;
  architecture?: string;
  operatingSystemRelease?: string;
};

/** Returns why this host cannot run the supported MōBrowser macOS toolchain. */
export function getMacExecutionEnvironmentError({
  platform = process.platform,
  architecture = process.arch,
  operatingSystemRelease: release = operatingSystemRelease(),
}: MacExecutionEnvironmentOptions = {}): string | undefined {
  if (platform !== 'darwin') {
    return `Real macOS signing can run only on macOS; current platform is ${platform}.`;
  }
  if (architecture !== 'arm64') {
    return `MōBrowser macOS releases require Apple Silicon (arm64); current architecture is ${architecture}.`;
  }
  const darwinMajorVersion = Number.parseInt(release.split('.')[0] ?? '', 10);
  if (!Number.isInteger(darwinMajorVersion)) {
    return `Could not determine the macOS version from Darwin release ${release}.`;
  }
  if (darwinMajorVersion < 23) {
    return `MōBrowser macOS releases require macOS 14 or later; Darwin release ${release} is unsupported.`;
  }
  return undefined;
}

export function assertMacExecutionEnvironment(options: MacExecutionEnvironmentOptions = {}): void {
  const error = getMacExecutionEnvironmentError(options);
  if (error !== undefined) {
    throw new Error(error);
  }
}

function buildEnvironment(material: SigningMaterial): NodeJS.ProcessEnv {
  return {
    ...createMinimalMacBuildEnvironment(process.env),
    MACOS_CODESIGN_IDENTITY: material.codesignIdentity,
    MACOS_TEAM_ID: material.teamId,
    MACOS_APPLE_ID: material.appleId,
    MACOS_APPLE_PASSWORD: material.appleAppSpecificPassword,
  };
}

/** Only runtime values necessary to launch npm and the macOS build tools. */
export function createMinimalMacBuildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'USER',
    'LOGNAME',
    'SHELL',
  ]) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}
