import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { machine } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WindowsSigningMaterial } from '../../common/model.js';
import {
  registerReleaseInterruptionHandler,
  throwIfReleaseInterrupted,
} from '../../common/release-interruption.js';

type AzureEnvironment = NodeJS.ProcessEnv;

export type AzureCertificateAuthentication = {
  kind: 'certificate';
  clientId: string;
  tenantId: string;
  certificatePath: string;
};

export type AzureClientSecretAuthentication = {
  kind: 'client-secret';
  clientId: string;
  tenantId: string;
  clientSecret: string;
};

export type AzureServicePrincipalAuthentication =
  AzureCertificateAuthentication | AzureClientSecretAuthentication;

/**
 * Runs the single PowerShell release workflow bundled with this CLI. The
 * target project supplies its MoBrowser configuration; signing values are
 * passed as explicit process arguments, never through a dotenv file.
 */
export async function executeWindowsRelease(
  projectDirectory: string,
  material: WindowsSigningMaterial,
  environment: AzureEnvironment,
): Promise<void> {
  assertWindowsExecutionEnvironment();
  const projectRoot = resolve(projectDirectory);
  const releaseScript = getBundledWindowsScriptPath();
  await assertFile(releaseScript, 'Bundled Windows release script');
  await runPowerShell(
    buildWindowsReleaseArguments(releaseScript, projectRoot, material, environment),
    projectRoot,
    environment,
  );
}

/** Resolves the one Windows release workflow shipped with this CLI. */
export function getBundledWindowsScriptPath(): string {
  return fileURLToPath(new URL('../../../scripts/win/sign-mobrowser-release.ps1', import.meta.url));
}

export function assertWindowsExecutionEnvironment(): void {
  const error = getWindowsExecutionEnvironmentError();
  if (error !== undefined) {
    throw new Error(error);
  }
}

export type WindowsExecutionEnvironmentOptions = {
  platform?: NodeJS.Platform;
  processArchitecture?: string;
  operatingSystemArchitecture?: string;
};

/** Returns why this host cannot run the x64 Windows signing toolchain. */
export function getWindowsExecutionEnvironmentError({
  platform = process.platform,
  processArchitecture = process.arch,
  operatingSystemArchitecture = machine(),
}: WindowsExecutionEnvironmentOptions = {}): string | undefined {
  if (platform !== 'win32') {
    return `Real Windows signing can run only on Windows; current platform is ${platform}.`;
  }
  if (processArchitecture !== 'x64') {
    return `MōBrowser Windows releases require a 64-bit x64 Node.js process; current architecture is ${processArchitecture}.`;
  }
  if (!new Set(['x64', 'x86_64', 'amd64']).has(operatingSystemArchitecture.toLowerCase())) {
    return `MōBrowser Windows releases require x64 Windows; current OS architecture is ${operatingSystemArchitecture}.`;
  }
  return undefined;
}

/**
 * Builds explicit PowerShell parameters for the complete Windows workflow.
 * The client secret remains in the child environment rather than appearing in
 * a PowerShell argument; the script removes it before npm scripts run.
 */
export function buildWindowsReleaseArguments(
  releaseScript: string,
  projectRoot: string,
  material: WindowsSigningMaterial,
  environment: AzureEnvironment,
): string[] {
  const argumentsList = [
    '-NoProfile',
    '-File',
    releaseScript,
    '-ProjectRoot',
    projectRoot,
    '-SigningEndpoint',
    material.endpoint,
    '-SigningAccountName',
    material.accountName,
    '-SigningProfileName',
    material.certificateProfileName,
    '-ExpectedPackageId',
    material.projectId,
    '-SubscriptionId',
    material.subscriptionId,
  ];
  const authentication = getAzureServicePrincipalAuthentication(environment);
  if (authentication === undefined) {
    return argumentsList;
  }
  const authenticationArguments = [
    ...argumentsList,
    '-AzureClientId',
    authentication.clientId,
    '-AzureTenantId',
    authentication.tenantId,
  ];
  return authentication.kind === 'certificate'
    ? [...authenticationArguments, '-AzureClientCertificatePath', authentication.certificatePath]
    : authenticationArguments;
}

/** Returns a complete service-principal login override, or the existing Azure CLI session. */
export function getAzureServicePrincipalAuthentication(
  environment: AzureEnvironment,
): AzureServicePrincipalAuthentication | undefined {
  const clientId = environment.AZURE_CLIENT_ID;
  const tenantId = environment.AZURE_TENANT_ID;
  const certificatePath = environment.AZURE_CLIENT_CERTIFICATE_PATH;
  const clientSecret = environment.AZURE_CLIENT_SECRET;
  const authenticationValues = [
    ['AZURE_CLIENT_ID', clientId],
    ['AZURE_TENANT_ID', tenantId],
    ['AZURE_CLIENT_CERTIFICATE_PATH', certificatePath],
    ['AZURE_CLIENT_SECRET', clientSecret],
  ] as const;
  const configured = authenticationValues.filter(([, value]) => !isBlank(value));
  if (configured.length === 0) {
    return undefined;
  }
  if (!isBlank(certificatePath) && !isBlank(clientSecret)) {
    throw new Error(
      'Azure service-principal login accepts exactly one credential: AZURE_CLIENT_CERTIFICATE_PATH or AZURE_CLIENT_SECRET.',
    );
  }
  const credentialName = !isBlank(certificatePath)
    ? 'AZURE_CLIENT_CERTIFICATE_PATH'
    : 'AZURE_CLIENT_SECRET';
  const credential = !isBlank(certificatePath) ? certificatePath : clientSecret;
  const required = [
    ['AZURE_CLIENT_ID', clientId],
    ['AZURE_TENANT_ID', tenantId],
    [credentialName, credential],
  ] as const;
  const missing = required.filter(([, value]) => isBlank(value)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Azure service-principal login requires AZURE_CLIENT_ID, AZURE_TENANT_ID, and ${credentialName} ` +
        `as an all-or-none group. Missing: ${missing.join(', ')}.`,
    );
  }
  return credentialName === 'AZURE_CLIENT_CERTIFICATE_PATH'
    ? {
        kind: 'certificate',
        clientId: clientId!,
        tenantId: tenantId!,
        certificatePath: certificatePath!,
      }
    : {
        kind: 'client-secret',
        clientId: clientId!,
        tenantId: tenantId!,
        clientSecret: clientSecret!,
      };
}

/** Backward-compatible certificate-only view of the configured authentication. */
export function getAzureCertificateAuthentication(
  environment: AzureEnvironment,
): AzureCertificateAuthentication | undefined {
  const authentication = getAzureServicePrincipalAuthentication(environment);
  return authentication?.kind === 'certificate' ? authentication : undefined;
}

async function assertFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} was not found: ${path}`);
  }
}

async function runPowerShell(
  args: string[],
  cwd: string,
  environment: AzureEnvironment,
): Promise<void> {
  await run('powershell.exe', args, {
    cwd,
    env: createMinimalWindowsChildEnvironment(environment),
  });
}

/**
 * Runtime values required by PowerShell, npm, NuGet, and Azure CLI. The
 * client secret is retained only long enough for PowerShell to authenticate,
 * then removed before npm lifecycle scripts run.
 */
export function createMinimalWindowsChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  const exactNames = new Set(
    [
      'APPDATA',
      'ComSpec',
      'HOME',
      'HOMEDRIVE',
      'HOMEPATH',
      'LOCALAPPDATA',
      'NUMBER_OF_PROCESSORS',
      'OS',
      'Path',
      'PATHEXT',
      'PROCESSOR_ARCHITECTURE',
      'ProgramData',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramW6432',
      'SystemRoot',
      'TEMP',
      'TMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
      'ALL_PROXY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'AZURE_CONFIG_DIR',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'GIT_SSL_CAPATH',
      'AZURE_CLIENT_SECRET',
      'NODE_AUTH_TOKEN',
      'NODE_EXTRA_CA_CERTS',
      'NPM_TOKEN',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
      'SSH_AUTH_SOCK',
    ].map((name) => name.toUpperCase()),
  );
  const allowedPrefixes = ['AZURE_CORE_', 'DOTNET_', 'NPM_CONFIG_'];

  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (
      !exactNames.has(normalizedName) &&
      !allowedPrefixes.some((prefix) => normalizedName.startsWith(prefix))
    ) {
      continue;
    }
    if (value !== undefined) {
      childEnvironment[name] = value;
    }
  }
  return childEnvironment;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

async function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  throwIfReleaseInterrupted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    const unregisterInterruption = registerReleaseInterruptionHandler((signal) =>
      terminateWindowsProcessTree(child, signal),
    );
    let settled = false;
    child.on('error', (error) => {
      unregisterInterruption();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      unregisterInterruption();
      if (settled) {
        return;
      }
      settled = true;
      try {
        throwIfReleaseInterrupted();
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`${command} failed with exit code ${code ?? 'unknown'}.`));
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Gives PowerShell a chance to unwind, then guarantees its process tree is stopped. */
export async function terminateWindowsProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  gracefulTimeoutMs = 2_000,
  forceTimeoutMs = 5_000,
): Promise<void> {
  if (child.pid === undefined || hasChildExited(child)) {
    return;
  }

  // Console signals normally reach both Node and PowerShell. Waiting first lets
  // PowerShell execute its finally blocks and restore Azure CLI state.
  if (await waitForChildExit(child, gracefulTimeoutMs)) {
    return;
  }

  if (process.platform === 'win32') {
    await runTreeKiller('taskkill.exe', ['/pid', String(child.pid), '/t', '/f']);
  } else {
    try {
      child.kill(signal);
    } catch (error) {
      if (!hasChildExited(child)) {
        throw error;
      }
    }
  }

  if (!(await waitForChildExit(child, forceTimeoutMs))) {
    throw new Error(`Could not terminate Windows release process tree ${child.pid}.`);
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child)) {
    return true;
  }
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off('close', onClose);
      resolvePromise(hasChildExited(child));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once('close', onClose);
  });
}

async function runTreeKiller(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const killer = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    killer.once('error', reject);
    killer.once('close', (code) => {
      if (code === 0 || code === 128) {
        resolvePromise();
      } else {
        reject(new Error(`${command} failed with exit code ${code ?? 'unknown'}.`));
      }
    });
  });
}
