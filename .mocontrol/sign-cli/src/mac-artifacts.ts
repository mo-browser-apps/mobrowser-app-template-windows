import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { runMacCommand } from './mac-command.js';

type DiskImageInfo = {
  images?: Array<{
    'image-path'?: string;
    'image-type'?: string;
    'system-entities'?: Array<{ 'dev-entry'?: string }>;
  }>;
};

export type MountedProjectDmg = {
  device: string;
  imagePath: string;
};

export async function assertNoMountedProjectPackagingDmgs(projectRoot: string): Promise<void> {
  const info = await runMacCommand('hdiutil', ['info', '-plist'], { captureOutput: true });
  const json = await runMacCommand('plutil', ['-convert', 'json', '-o', '-', '-'], {
    captureOutput: true,
    input: info.stdout,
  });
  const mounted = findMountedProjectPackagingDmgs(json.stdout, projectRoot);
  if (mounted.length === 0) {
    return;
  }

  const commands = mounted.map(({ device }) => `  hdiutil detach ${device}`).join('\n');
  const images = mounted.map(({ device, imagePath }) => `  ${device}  ${imagePath}`).join('\n');
  throw new Error(
    `A previous packaging attempt left mounted DMG(s) for this project:\n${images}\n\nDetach them, then run the release again:\n${commands}`,
  );
}

/** Finds only read/write DMGs produced by this project's macOS packaging step. */
export function findMountedProjectPackagingDmgs(
  hdiutilInfoJson: string,
  projectRoot: string,
): MountedProjectDmg[] {
  const info = JSON.parse(hdiutilInfoJson) as DiskImageInfo;
  const buildDirectory = join(resolve(projectRoot), 'build', 'dist');
  const mounted: MountedProjectDmg[] = [];

  for (const image of info.images ?? []) {
    const imagePath = image['image-path'];
    if (
      imagePath === undefined ||
      image['image-type'] !== 'read/write' ||
      !isPathWithin(imagePath, buildDirectory) ||
      !basename(imagePath).startsWith('rw.') ||
      !imagePath.endsWith('.dmg')
    ) {
      continue;
    }
    const device = image['system-entities']
      ?.map((entity) => entity['dev-entry'])
      .find((entry): entry is string => entry !== undefined && /^\/dev\/disk\d+$/.test(entry));
    if (device !== undefined) {
      mounted.push({ device, imagePath });
    }
  }
  return mounted;
}

/** Removes only this Mac's previous architecture-specific build output. */
export async function removePreviousMacBuildOutput(
  projectRoot: string,
  architecture = process.arch,
): Promise<void> {
  await rm(macBuildOutputDirectory(projectRoot, architecture), { force: true, recursive: true });
}

export function macBuildOutputDirectory(projectRoot: string, architecture = process.arch): string {
  return join(resolve(projectRoot), 'build', 'dist', macOutputDirectoryName(architecture));
}

export function macOutputDirectoryName(architecture: string): 'mac-arm64' | 'mac-x64' {
  if (architecture === 'arm64') {
    return 'mac-arm64';
  }
  if (architecture === 'x64') {
    return 'mac-x64';
  }
  throw new Error(`Unsupported macOS build architecture: ${architecture}.`);
}

export async function findNewArtifact(
  root: string,
  predicate: (path: string) => boolean,
  createdAfter: number,
): Promise<string | undefined> {
  const artifacts = await findNewArtifacts(root, predicate, createdAfter);
  return requireSingleArtifact(root, artifacts);
}

/** Finds exactly one new artifact directly under root without entering bundles. */
export async function findNewDirectArtifact(
  root: string,
  predicate: (path: string) => boolean,
  createdAfter: number,
): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const artifacts: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (predicate(path) && (await stat(path)).mtimeMs >= createdAfter - 1_000) {
      artifacts.push(path);
    }
  }
  return requireSingleArtifact(root, artifacts);
}

function requireSingleArtifact(root: string, artifacts: string[]): string | undefined {
  if (artifacts.length > 1) {
    throw new Error(
      `Expected exactly one new artifact under ${root}, but found ${artifacts.length}:\n${artifacts.map((path) => `  ${path}`).join('\n')}`,
    );
  }
  return artifacts[0];
}

/** Finds all matching new artifacts in a stable path order. */
export async function findNewArtifacts(
  root: string,
  predicate: (path: string) => boolean,
  createdAfter: number,
): Promise<string[]> {
  const artifacts: string[] = [];
  await collectNewArtifacts(root, predicate, createdAfter, artifacts);
  return artifacts.sort((left, right) => left.localeCompare(right));
}

async function collectNewArtifacts(
  root: string,
  predicate: (path: string) => boolean,
  createdAfter: number,
  artifacts: string[],
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (predicate(path) && (await stat(path)).mtimeMs >= createdAfter - 1_000) {
        artifacts.push(path);
      }
      await collectNewArtifacts(path, predicate, createdAfter, artifacts);
    } else if (predicate(path) && (await stat(path)).mtimeMs >= createdAfter - 1_000) {
      artifacts.push(path);
    }
  }
}

function isPathWithin(path: string, directory: string): boolean {
  const pathRelativeToDirectory = relative(directory, resolve(path));
  return (
    pathRelativeToDirectory !== '' &&
    !pathRelativeToDirectory.startsWith('..') &&
    !pathRelativeToDirectory.startsWith('../')
  );
}
