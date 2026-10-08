import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export type ReleaseLock = {
  dispose: () => Promise<void>;
};

type ReleaseLockOwner = {
  token: string;
  pid: number;
  hostname: string;
  projectRoot: string;
  platform: 'macos' | 'windows';
  scope?: 'project' | 'macos-global' | 'windows-global';
  startedAt: string;
};

type ReleaseLockOptions = {
  lockRoot?: string;
};

const macSigningResourceKey = 'mobrowser-sign:macos-signing-global:v1';
const windowsSigningResourceKey = 'mobrowser-sign:windows-signing-global:v1';

/**
 * Acquires one project-wide release lock. A prepared directory is renamed into
 * place so contenders never observe a lock without its ownership record.
 */
export async function acquireReleaseLock(
  projectRoot: string,
  platform: 'macos' | 'windows',
  options: ReleaseLockOptions = {},
): Promise<ReleaseLock> {
  return acquireScopedReleaseLock(projectRoot, platform, 'project', projectRoot, options);
}

/**
 * Serializes macOS releases for one OS user. Temporary-keychain recovery and
 * the user keychain search list are shared resources across projects.
 */
export async function acquireMacSigningLock(
  projectRoot: string,
  options: ReleaseLockOptions = {},
): Promise<ReleaseLock> {
  return acquireScopedReleaseLock(
    projectRoot,
    'macos',
    'macos-global',
    macSigningResourceKey,
    options,
  );
}

/**
 * Serializes Windows releases for one OS user. Azure CLI state and the cached
 * Artifact Signing toolchain are user-wide resources shared across projects.
 */
export async function acquireWindowsSigningLock(
  projectRoot: string,
  options: ReleaseLockOptions = {},
): Promise<ReleaseLock> {
  return acquireScopedReleaseLock(
    projectRoot,
    'windows',
    'windows-global',
    windowsSigningResourceKey,
    options,
  );
}

async function acquireScopedReleaseLock(
  projectRoot: string,
  platform: 'macos' | 'windows',
  scope: 'project' | 'macos-global' | 'windows-global',
  resourceKey: string,
  options: ReleaseLockOptions,
): Promise<ReleaseLock> {
  const lockRoot = options.lockRoot ?? join(tmpdir(), 'mobrowser-sign', 'release-locks');
  const projectKey = createHash('sha256').update(resourceKey).digest('hex');
  const lockDirectory = join(lockRoot, `${projectKey}.lock`);
  const token = randomUUID();
  const candidateDirectory = join(lockRoot, `${projectKey}.${token}.candidate`);
  const owner: ReleaseLockOwner = {
    token,
    pid: process.pid,
    hostname: hostname(),
    projectRoot,
    platform,
    scope,
    startedAt: new Date().toISOString(),
  };

  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await writeFile(join(candidateDirectory, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    let acquired = false;
    let lastRenameError: unknown;
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try {
        await rename(candidateDirectory, lockDirectory);
        acquired = true;
      } catch (error) {
        lastRenameError = error;
        const existingOwner = await readReleaseLockOwner(lockDirectory);
        if (existingOwner !== undefined) {
          throw releaseAlreadyRunningError(lockDirectory, existingOwner);
        }
        // The previous owner may have removed the lock between rename failing
        // and its ownership record being read. Retry that transient window.
        if (attempt < 2) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      }
    }
    if (!acquired) {
      throw lastRenameError;
    }
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }

  return {
    dispose: onceAsync(async () => {
      const currentOwner = await readReleaseLockOwner(lockDirectory);
      if (currentOwner === undefined) {
        return;
      }
      if (currentOwner.token !== token) {
        throw new Error(
          `Refusing to remove a release lock now owned by another process: ${lockDirectory}`,
        );
      }
      await rm(lockDirectory, { recursive: true, force: true });
    }),
  };
}

async function readReleaseLockOwner(lockDirectory: string): Promise<ReleaseLockOwner | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isReleaseLockOwner(parsed)) {
    return undefined;
  }
  return parsed;
}

function isReleaseLockOwner(value: unknown): value is ReleaseLockOwner {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const owner = value as Partial<ReleaseLockOwner>;
  return (
    typeof owner.token === 'string' &&
    Number.isInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.hostname === 'string' &&
    typeof owner.projectRoot === 'string' &&
    (owner.platform === 'macos' || owner.platform === 'windows') &&
    (owner.scope === undefined ||
      owner.scope === 'project' ||
      owner.scope === 'macos-global' ||
      owner.scope === 'windows-global') &&
    typeof owner.startedAt === 'string'
  );
}

function releaseAlreadyRunningError(lockDirectory: string, owner: ReleaseLockOwner): Error {
  const processState =
    owner.hostname === hostname()
      ? isProcessAlive(owner.pid)
        ? 'running'
        : 'not running'
      : `on host ${owner.hostname}`;
  const recovery =
    processState === 'not running'
      ? ` The recorded process is not running; after confirming no release is active, remove ${lockDirectory}.`
      : '';
  const releaseDescription =
    owner.scope === 'macos-global'
      ? `Another macOS signing release for ${owner.projectRoot}`
      : owner.scope === 'windows-global'
        ? `Another Windows signing release for ${owner.projectRoot}`
        : `Another release for ${owner.projectRoot}`;
  return new Error(
    `${releaseDescription} is already ${processState} ` +
      `(PID ${owner.pid}, platform ${owner.platform}, started ${owner.startedAt}).${recovery}`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => {
    active ??= action();
    return active;
  };
}
