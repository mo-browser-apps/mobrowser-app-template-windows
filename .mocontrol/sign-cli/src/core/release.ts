import {
  assertProviderManagedMacConfiguration,
  assertWindowsBundleConfiguration,
  deriveProjectId,
  loadMoBrowserConfig,
  resolveProjectDirectory,
} from '../common/project.js';
import {
  acquireMacSigningLock,
  acquireReleaseLock,
  acquireWindowsSigningLock,
} from '../common/release-lock.js';
import {
  installReleaseInterruptionHandlers,
  throwIfReleaseInterrupted,
} from '../common/release-interruption.js';
import { executeMacRelease } from './mac/index.js';
import { executeWindowsRelease } from './windows/index.js';
import type { SigningProvider } from '../providers/signing-provider.js';

export type ReleasePlatform = 'macos' | 'windows';

export type ReleaseExecutors = {
  executeMacRelease: typeof executeMacRelease;
  executeWindowsRelease: typeof executeWindowsRelease;
};

export type ReleaseResult = { platform: 'macos'; artifactPath: string } | { platform: 'windows' };

export type ReleaseSigningContext = {
  provider: SigningProvider;
  environment: NodeJS.ProcessEnv;
};

export type ReleaseSigningContextLoader = (
  project: { id: string; rootDirectory: string },
  platform: ReleasePlatform,
) => Promise<ReleaseSigningContext>;

/** Coordinates a release, loading signing configuration only after acquiring its locks. */
export class ReleaseService {
  public constructor(
    private readonly loadSigningContext: ReleaseSigningContextLoader,
    private readonly executors: ReleaseExecutors = { executeMacRelease, executeWindowsRelease },
  ) {}

  public async release(
    projectDirectory: string,
    platform: ReleasePlatform,
  ): Promise<ReleaseResult> {
    const removeInterruptionHandlers = installReleaseInterruptionHandlers();
    try {
      throwIfReleaseInterrupted();
      const projectRoot = await resolveProjectDirectory(projectDirectory);
      throwIfReleaseInterrupted();
      const releaseLock = await acquireReleaseLock(projectRoot, platform);
      try {
        throwIfReleaseInterrupted();
        const config = await loadMoBrowserConfig(projectRoot);
        throwIfReleaseInterrupted();
        const project = {
          id: deriveProjectId(config, platform),
          rootDirectory: projectRoot,
        };
        if (platform === 'macos') {
          assertProviderManagedMacConfiguration(config);
          const macSigningLock = await acquireMacSigningLock(projectRoot);
          try {
            throwIfReleaseInterrupted();
            const { provider } = await this.loadSigningContext(project, platform);
            throwIfReleaseInterrupted();
            const material = await provider.getMacSigningMaterial(project);
            throwIfReleaseInterrupted();
            return {
              platform: 'macos',
              artifactPath: await this.executors.executeMacRelease(project.rootDirectory, material),
            };
          } finally {
            await macSigningLock.dispose();
            throwIfReleaseInterrupted();
          }
        }

        assertWindowsBundleConfiguration(config);
        const windowsSigningLock = await acquireWindowsSigningLock(projectRoot);
        try {
          throwIfReleaseInterrupted();
          const { provider, environment } = await this.loadSigningContext(project, platform);
          throwIfReleaseInterrupted();
          const material = await provider.getWindowsSigningMaterial(project);
          throwIfReleaseInterrupted();
          await this.executors.executeWindowsRelease(project.rootDirectory, material, environment);
          return { platform: 'windows' };
        } finally {
          await windowsSigningLock.dispose();
          throwIfReleaseInterrupted();
        }
      } finally {
        await releaseLock.dispose();
        throwIfReleaseInterrupted();
      }
    } finally {
      removeInterruptionHandlers();
    }
  }
}

export function assertReleasePlatform(platform: string): asserts platform is ReleasePlatform {
  if (platform !== 'macos' && platform !== 'windows') {
    throw new Error(`Unknown platform: ${platform}. Choose macos or windows.`);
  }
}
