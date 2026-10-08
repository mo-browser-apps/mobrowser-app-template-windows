import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  macOSBundleSchema,
  moBrowserConfigSchema,
  windowsBundleSchema,
  type MacOSBundle,
  type MoBrowserConfig,
  type WindowsBundle,
} from './model.js';

export async function loadMoBrowserConfig(projectDirectory: string): Promise<MoBrowserConfig> {
  const configPath = resolve(projectDirectory, 'mobrowser.conf.json');
  const text = await readFile(configPath, 'utf8');
  return moBrowserConfigSchema.parse(JSON.parse(text));
}

/** Returns the configured, platform-specific application identifier used for provider authorization. */
export function deriveProjectId(config: MoBrowserConfig, platform: 'macos' | 'windows'): string {
  if (platform === 'macos') {
    return parseMacOSBundle(config).bundleID;
  }

  const packageId = parseWindowsBundle(config).installer?.exe?.packageId;
  if (packageId === undefined) {
    throw new Error(
      'mobrowser.conf.json must contain app.bundle.Windows.installer.exe.packageId for provider authorization.',
    );
  }
  return packageId;
}

/** Resolves a project root for local execution without using it as provider identity. */
export async function resolveProjectDirectory(projectDirectory: string): Promise<string> {
  return realpath(resolve(projectDirectory));
}

/** Ensures macOS signing configuration is supplied by the selected provider. */
export function assertProviderManagedMacConfiguration(config: MoBrowserConfig): void {
  const macOS = parseMacOSBundle(config);
  const requiredPlaceholders: Record<
    'codesignIdentity' | 'teamID' | 'appleID' | 'password',
    string
  > = {
    codesignIdentity: '${MACOS_CODESIGN_IDENTITY}',
    teamID: '${MACOS_TEAM_ID}',
    appleID: '${MACOS_APPLE_ID}',
    password: '${MACOS_APPLE_PASSWORD}',
  };

  for (const [field, expected] of Object.entries(requiredPlaceholders)) {
    if (macOS[field as keyof typeof macOS] !== expected) {
      throw new Error(
        `mobrowser.conf.json must set macOS.${field} to ${expected} for provider-managed signing.`,
      );
    }
  }
}

/** Azure Artifact Signing is applied after MoBrowser builds the Windows bundle. */
export function assertWindowsBundleConfiguration(config: MoBrowserConfig): void {
  const windows = parseWindowsBundle(config);
  if (windows.signCommand !== undefined && windows.signCommand !== '') {
    throw new Error(
      'mobrowser.conf.json must leave Windows.signCommand empty or omit it; mocontrol-cli is the sole Windows signing workflow.',
    );
  }
}

function parseMacOSBundle(config: MoBrowserConfig): MacOSBundle {
  const value = config.app.bundle.macOS;
  if (value === undefined) {
    throw new Error('mobrowser.conf.json must contain app.bundle.macOS for a macOS release.');
  }
  const parsed = macOSBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidPlatformBundleError('macOS', parsed.error.issues);
  }
  return parsed.data;
}

function parseWindowsBundle(config: MoBrowserConfig): WindowsBundle {
  const value = config.app.bundle.Windows;
  if (value === undefined) {
    throw new Error('mobrowser.conf.json must contain app.bundle.Windows for a Windows release.');
  }
  const parsed = windowsBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidPlatformBundleError('Windows', parsed.error.issues);
  }
  return parsed.data;
}

function invalidPlatformBundleError(
  platform: 'macOS' | 'Windows',
  issues: Array<{ path: PropertyKey[]; message: string }>,
): Error {
  const detail = issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? platform : `${platform}.${issue.path.join('.')}`}: ${issue.message}`,
    )
    .join('; ');
  return new Error(`mobrowser.conf.json app.bundle.${platform} is invalid: ${detail}`);
}
