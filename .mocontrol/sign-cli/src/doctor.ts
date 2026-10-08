import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { type SigningMaterial, type WindowsSigningMaterial } from './common/model.js';
import { getMacExecutionEnvironmentError } from './core/mac/executor.js';
import {
  createMinimalWindowsChildEnvironment,
  getAzureServicePrincipalAuthentication,
  getWindowsExecutionEnvironmentError,
} from './core/windows/executor.js';
import { resolveBundledDeveloperIdIntermediate } from './mac-signing.js';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type DoctorCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; input?: string },
) => DoctorCommandResult;

const macCommands = [
  'npm',
  'security',
  'openssl',
  'codesign',
  'spctl',
  'xcrun',
  'hdiutil',
  'plutil',
];

export function runMacDoctor(): DoctorCheck[] {
  const checks = macCommands.map(createCommandCheck);

  if (process.platform === 'darwin' && checks.find((check) => check.name === 'xcrun')?.ok) {
    for (const tool of ['notarytool', 'stapler']) {
      const result = spawnSync('xcrun', ['--find', tool], { encoding: 'utf8' });
      checks.push({
        name: `xcrun ${tool}`,
        ok: result.status === 0,
        detail: result.status === 0 ? result.stdout.trim() : 'Xcode command-line tool unavailable',
      });
    }
  }

  return checks;
}

export function runWindowsDoctor(): DoctorCheck[] {
  const checks = ['npm', 'az', 'powershell.exe'].map(createCommandCheck);
  checks.push(checkDotNet8X64Runtime());
  checks.push(checkVisualCppX64Runtime());
  return checks;
}

type DotNet8X64RuntimeCheckOptions = {
  platform?: NodeJS.Platform;
  processArchitecture?: string;
  operatingSystemArchitecture?: string;
  environment?: NodeJS.ProcessEnv;
};

/** Mirrors the Windows release script's 64-bit OS and ProgramFiles runtime check. */
export function checkDotNet8X64Runtime({
  platform = process.platform,
  processArchitecture = process.arch,
  operatingSystemArchitecture,
  environment = process.env,
}: DotNet8X64RuntimeCheckOptions = {}): DoctorCheck {
  const name = '.NET 8 x64 Runtime';
  const hostError = getWindowsExecutionEnvironmentError({
    platform,
    processArchitecture,
    ...(operatingSystemArchitecture === undefined ? {} : { operatingSystemArchitecture }),
  });
  if (hostError !== undefined) {
    return { name, ok: false, detail: hostError };
  }

  const programFiles = windowsEnvironmentValue(environment, 'ProgramFiles');
  if (programFiles === undefined || programFiles.trim() === '') {
    return { name, ok: false, detail: 'ProgramFiles is not configured' };
  }
  const runtimeDirectory = join(programFiles, 'dotnet', 'shared', 'Microsoft.NETCore.App');
  try {
    const hasNet8X64 = readdirSync(runtimeDirectory, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && /^8\.\d+\.\d+$/.test(entry.name),
    );
    return {
      name,
      ok: hasNet8X64,
      detail: hasNet8X64
        ? `.NET 8 x64 Runtime detected under ${runtimeDirectory}`
        : `.NET 8 x64 Runtime not found under ${runtimeDirectory}`,
    };
  } catch {
    return { name, ok: false, detail: `.NET 8 x64 Runtime not found under ${runtimeDirectory}` };
  }
}

/** Checks the x64 VC++ runtime required by the Artifact Signing dlib. */
export function checkVisualCppX64Runtime(
  platform: NodeJS.Platform = process.platform,
  commandRunner: DoctorCommandRunner = runDoctorCommand,
): DoctorCheck {
  const name = 'Visual C++ 2015-2022 x64 Runtime';
  if (platform !== 'win32') {
    return { name, ok: false, detail: `current platform is ${platform}` };
  }
  const result = commandRunner('reg.exe', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    '/v',
    'Installed',
  ]);
  const installed = result.status === 0 && /\bInstalled\s+REG_DWORD\s+0x1\b/i.test(result.stdout);
  return {
    name,
    ok: installed,
    detail: installed
      ? 'Visual C++ 2015-2022 x64 Runtime is installed'
      : commandFailureDetail(result, 'Visual C++ 2015-2022 x64 Runtime is not installed'),
  };
}

/** Validates the npm files and scripts that the selected release executor invokes. */
export async function runProjectNpmDoctor(
  projectRoot: string,
  platform: 'macos' | 'windows',
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const packagePath = join(projectRoot, 'package.json');
  let packageJson: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
    if (!isRecord(parsed)) {
      throw new Error('package.json must contain a JSON object');
    }
    packageJson = parsed;
    checks.push({
      name: 'package.json',
      ok: true,
      detail: `valid npm package manifest: ${packagePath}`,
    });
  } catch (error) {
    checks.push({
      name: 'package.json',
      ok: false,
      detail: `could not read a valid ${packagePath}: ${errorMessage(error)}`,
    });
  }

  const scripts =
    packageJson === undefined || !isRecord(packageJson.scripts) ? undefined : packageJson.scripts;
  const missingScripts = ['build', 'pack'].filter(
    (name) => typeof scripts?.[name] !== 'string' || scripts[name].trim() === '',
  );
  checks.push({
    name: 'npm release scripts',
    ok: missingScripts.length === 0,
    detail:
      missingScripts.length === 0
        ? 'package.json defines non-empty build and pack scripts'
        : `package.json must define non-empty scripts: ${missingScripts.join(', ')}`,
  });

  if (platform === 'windows') {
    checks.push(await windowsNpmLockfileCheck(projectRoot));
  }
  return checks;
}

async function windowsNpmLockfileCheck(projectRoot: string): Promise<DoctorCheck> {
  const lockfileNames = ['npm-shrinkwrap.json', 'package-lock.json'];
  const lockfilePath = (
    await Promise.all(
      lockfileNames.map(async (name) => {
        const path = join(projectRoot, name);
        return (await isReadableFile(path)) ? path : undefined;
      }),
    )
  ).find((path) => path !== undefined);
  if (lockfilePath === undefined) {
    return {
      name: 'npm ci lockfile',
      ok: false,
      detail: `Windows release requires ${lockfileNames.join(' or ')} for npm ci`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(lockfilePath, 'utf8'));
    if (
      !isRecord(parsed) ||
      !Number.isInteger(parsed.lockfileVersion) ||
      (parsed.lockfileVersion as number) < 1
    ) {
      throw new Error('lockfileVersion must be an integer greater than or equal to 1');
    }
    return { name: 'npm ci lockfile', ok: true, detail: `valid lockfile: ${lockfilePath}` };
  } catch (error) {
    return {
      name: 'npm ci lockfile',
      ok: false,
      detail: `could not read a valid ${lockfilePath}: ${errorMessage(error)}`,
    };
  }
}

/** Runs the non-mutating credential and Azure resource checks used by a Windows release. */
export async function runWindowsSigningDoctor(
  material: WindowsSigningMaterial,
  environment: NodeJS.ProcessEnv,
  commandRunner: DoctorCommandRunner = runDoctorCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    {
      name: 'Windows host',
      ok: platform === 'win32',
      detail: platform === 'win32' ? 'running on Windows' : `current platform is ${platform}`,
    },
  ];
  if (platform !== 'win32') {
    return checks;
  }

  let servicePrincipalAuthentication: ReturnType<typeof getAzureServicePrincipalAuthentication>;
  try {
    servicePrincipalAuthentication = getAzureServicePrincipalAuthentication(environment);
    checks.push({
      name: 'Azure authentication configuration',
      ok: true,
      detail:
        servicePrincipalAuthentication === undefined
          ? 'using the existing Azure CLI session'
          : `using isolated ${servicePrincipalAuthentication.kind} authentication`,
    });
  } catch (error) {
    checks.push({
      name: 'Azure authentication configuration',
      ok: false,
      detail: errorMessage(error),
    });
    return checks;
  }

  let isolatedAzureConfigDirectory: string | undefined;
  try {
    const azureEnvironment: NodeJS.ProcessEnv = {
      ...createMinimalWindowsChildEnvironment(environment),
      AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
    };
    if (servicePrincipalAuthentication?.kind === 'certificate') {
      const certificateIsFile = await isReadableFile(
        servicePrincipalAuthentication.certificatePath,
      );
      checks.push({
        name: 'Azure client certificate',
        ok: certificateIsFile,
        detail: certificateIsFile
          ? `readable file: ${servicePrincipalAuthentication.certificatePath}`
          : `not a readable file: ${servicePrincipalAuthentication.certificatePath}`,
      });
      if (!certificateIsFile) {
        return checks;
      }

      isolatedAzureConfigDirectory = await mkdtemp(join(tmpdir(), 'mobrowser-sign-doctor-azure-'));
      azureEnvironment.AZURE_CONFIG_DIR = isolatedAzureConfigDirectory;
      const login = commandRunner(
        'az',
        [
          'login',
          '--service-principal',
          '--username',
          servicePrincipalAuthentication.clientId,
          '--certificate',
          servicePrincipalAuthentication.certificatePath,
          '--tenant',
          servicePrincipalAuthentication.tenantId,
          '--output',
          'none',
          '--only-show-errors',
        ],
        { env: azureEnvironment },
      );
      checks.push(
        commandResultCheck(
          'Azure certificate login',
          login,
          'certificate credentials authenticated in an isolated Azure CLI profile',
        ),
      );
      if (login.status !== 0) {
        return checks;
      }
    } else if (servicePrincipalAuthentication?.kind === 'client-secret') {
      isolatedAzureConfigDirectory = await mkdtemp(join(tmpdir(), 'mobrowser-sign-doctor-azure-'));
      azureEnvironment.AZURE_CONFIG_DIR = isolatedAzureConfigDirectory;
      const login = commandRunner(
        'az',
        [
          'login',
          '--service-principal',
          '--username',
          servicePrincipalAuthentication.clientId,
          `--password=${servicePrincipalAuthentication.clientSecret}`,
          '--tenant',
          servicePrincipalAuthentication.tenantId,
          '--output',
          'none',
          '--only-show-errors',
        ],
        { env: azureEnvironment },
      );
      checks.push(
        commandResultCheck(
          'Azure client-secret login',
          login,
          'client-secret credentials authenticated in an isolated Azure CLI profile',
        ),
      );
      if (login.status !== 0) {
        return checks;
      }
    }

    const subscriptionAuthentication = commandRunner(
      'az',
      [
        'account',
        'get-access-token',
        '--subscription',
        material.subscriptionId,
        '--resource',
        'https://management.azure.com/',
        '--output',
        'none',
        '--only-show-errors',
      ],
      { env: azureEnvironment },
    );
    checks.push(
      commandResultCheck(
        'Azure subscription authentication',
        subscriptionAuthentication,
        `authenticated for subscription ${material.subscriptionId}`,
      ),
    );
    if (subscriptionAuthentication.status !== 0) {
      return checks;
    }

    return checks;
  } finally {
    if (isolatedAzureConfigDirectory !== undefined) {
      await rm(isolatedAzureConfigDirectory, { force: true, recursive: true });
    }
  }
}

/** Evaluates one Azure data action against effective permission sets. */
export function hasAzureDataActionPermission(
  permissionSets: unknown,
  requiredAction: string,
): boolean {
  if (!Array.isArray(permissionSets)) {
    return false;
  }
  return permissionSets.some((permissionSet) => {
    if (!isRecord(permissionSet)) {
      return false;
    }
    const allowed = stringArray(permissionSet.dataActions).some((pattern) =>
      azureActionPatternMatches(pattern, requiredAction),
    );
    const excluded = stringArray(permissionSet.notDataActions).some((pattern) =>
      azureActionPatternMatches(pattern, requiredAction),
    );
    return allowed && !excluded;
  });
}

function azureActionPatternMatches(pattern: string, action: string): boolean {
  const expression = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(action);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Runs non-mutating P12 checks used by a macOS release. */
export async function runMacSigningDoctor(
  material: SigningMaterial,
  commandRunner: DoctorCommandRunner = runDoctorCommand,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  operatingSystemRelease?: string,
): Promise<DoctorCheck[]> {
  const hostError = getMacExecutionEnvironmentError({
    platform,
    architecture,
    operatingSystemRelease,
  });
  const checks: DoctorCheck[] = [
    {
      name: 'macOS host',
      ok: hostError === undefined,
      detail: hostError ?? 'running on macOS 14 or later on Apple Silicon (arm64)',
    },
  ];
  const p12IsFile = await isReadableFile(material.signingP12Path);
  checks.push({
    name: 'Developer ID P12',
    ok: p12IsFile,
    detail: p12IsFile
      ? `readable file: ${material.signingP12Path}`
      : `not a readable file: ${material.signingP12Path}`,
  });
  if (hostError !== undefined || !p12IsFile) {
    return checks;
  }

  const certificate = runMacPkcs12DoctorCommand(commandRunner, material, ['-clcerts', '-nokeys']);
  const certificatePem = extractPemBlock(certificate.stdout, 'CERTIFICATE');
  const hasCertificate = certificate.status === 0 && certificatePem !== undefined;
  checks.push({
    name: 'Developer ID P12 certificate',
    ok: hasCertificate,
    detail: hasCertificate
      ? 'P12 password is valid and a leaf certificate is present'
      : commandFailureDetail(
          certificate,
          'P12 does not contain a leaf certificate or the export password is invalid',
        ),
  });
  if (!hasCertificate) {
    return checks;
  }

  const issuer = commandRunner('openssl', ['x509', '-noout', '-issuer', '-nameopt', 'RFC2253'], {
    input: certificatePem,
  });
  let intermediatePath: string | undefined;
  if (issuer.status === 0) {
    try {
      intermediatePath = await resolveBundledDeveloperIdIntermediate(issuer.stdout.trim());
    } catch (error) {
      checks.push({ name: 'Developer ID intermediate', ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({
      name: 'Developer ID intermediate',
      ok: false,
      detail: commandFailureDetail(issuer, 'could not read the P12 leaf certificate issuer'),
    });
  }
  if (intermediatePath === undefined) {
    return checks;
  }
  checks.push({
    name: 'Developer ID intermediate',
    ok: true,
    detail: `certificate issuer is supported and the bundled intermediate passed SHA-256 verification: ${intermediatePath}`,
  });

  const privateKey = runMacPkcs12DoctorCommand(commandRunner, material, ['-nocerts', '-nodes']);
  const privateKeyPem = extractPrivateKeyPem(privateKey.stdout);
  const hasPrivateKey = privateKey.status === 0 && privateKeyPem !== undefined;
  checks.push({
    name: 'Developer ID P12 private key',
    ok: hasPrivateKey,
    detail: hasPrivateKey
      ? 'P12 contains a private key'
      : commandFailureDetail(privateKey, 'P12 does not contain a private key'),
  });
  if (!hasPrivateKey) {
    return checks;
  }

  const subject = commandRunner('openssl', ['x509', '-noout', '-subject', '-nameopt', 'RFC2253'], {
    input: certificatePem,
  });
  const attributes =
    subject.status === 0 ? parseRfc2253Subject(subject.stdout) : new Map<string, string[]>();
  const identityMatches = attributes.get('CN')?.includes(material.codesignIdentity) === true;
  const teamMatches = attributes.get('OU')?.includes(material.teamId) === true;
  const identityIsExpected = subject.status === 0 && identityMatches && teamMatches;
  checks.push({
    name: 'Developer ID certificate identity',
    ok: identityIsExpected,
    detail: identityIsExpected
      ? `certificate matches ${material.codesignIdentity} and Team ID ${material.teamId}`
      : subject.status === 0
        ? `certificate must have CN=${material.codesignIdentity} and OU=${material.teamId}`
        : commandFailureDetail(subject, 'could not read the P12 leaf certificate subject'),
  });
  if (!identityIsExpected) {
    return checks;
  }

  const certificatePublicKey = commandRunner('openssl', ['x509', '-pubkey', '-noout'], {
    input: certificatePem,
  });
  const privatePublicKey = commandRunner('openssl', ['pkey', '-pubout'], { input: privateKeyPem });
  const certificateKey = normalizePemPublicKey(certificatePublicKey);
  const privateKeyPublic = normalizePemPublicKey(privatePublicKey);
  const keyPairMatches = certificateKey !== undefined && certificateKey === privateKeyPublic;
  checks.push({
    name: 'Developer ID certificate key pair',
    ok: keyPairMatches,
    detail: keyPairMatches
      ? 'P12 private key matches its leaf certificate'
      : commandFailureDetail(
          certificatePublicKey.status !== 0 ? certificatePublicKey : privatePublicKey,
          'P12 private key does not match its leaf certificate',
        ),
  });
  return checks;
}

/** Retries only the OpenSSL 3 legacy-cipher error used by older P12 exports. */
function runMacPkcs12DoctorCommand(
  commandRunner: DoctorCommandRunner,
  material: Pick<SigningMaterial, 'signingP12Path' | 'p12Password'>,
  outputArguments: string[],
): DoctorCommandResult {
  const argumentsList = [
    'pkcs12',
    '-in',
    material.signingP12Path,
    '-passin',
    'stdin',
    ...outputArguments,
  ];
  const result = commandRunner('openssl', argumentsList, { input: material.p12Password });
  if (!requiresOpenSslLegacyProvider(result)) {
    return result;
  }
  return commandRunner(
    'openssl',
    ['pkcs12', '-legacy', '-in', material.signingP12Path, '-passin', 'stdin', ...outputArguments],
    {
      input: material.p12Password,
    },
  );
}

function requiresOpenSslLegacyProvider(result: DoctorCommandResult): boolean {
  if (result.status === 0) {
    return false;
  }
  return /inner_evp_generic_fetch|(?:RC2|RC4|DES).*unsupported|unsupported.*(?:RC2|RC4|DES)/i.test(
    `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ''}`,
  );
}

function parseRfc2253Subject(output: string): Map<string, string[]> {
  const subject = output.trim().replace(/^subject\s*=\s*/i, '');
  const attributes = new Map<string, string[]>();
  for (const component of splitUnescaped(subject, new Set([',', '+']))) {
    const separator = findUnescaped(component, '=');
    if (separator === -1) {
      continue;
    }
    const name = component.slice(0, separator).trim().toUpperCase();
    const value = decodeRfc2253Value(component.slice(separator + 1));
    attributes.set(name, [...(attributes.get(name) ?? []), value]);
  }
  return attributes;
}

function splitUnescaped(value: string, separators: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (separators.has(character)) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function findUnescaped(value: string, target: string): number {
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === target) {
      return index;
    }
  }
  return -1;
}

function decodeRfc2253Value(value: string): string {
  return value
    .replace(/(?:\\[0-9A-Fa-f]{2})+/g, (encoded) =>
      Buffer.from(encoded.replaceAll('\\', ''), 'hex').toString('utf8'),
    )
    .replace(/\\(.)/g, '$1');
}

function extractPemBlock(value: string, label: string): string | undefined {
  const marker = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.match(new RegExp(`-----BEGIN ${marker}-----[\\s\\S]*?-----END ${marker}-----`))?.[0];
}

function extractPrivateKeyPem(value: string): string | undefined {
  const match = value.match(/-----BEGIN ((?:[A-Z]+ )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/);
  return match?.[0];
}

function normalizePemPublicKey(result: DoctorCommandResult): string | undefined {
  if (result.status !== 0 || !result.stdout.includes('-----BEGIN PUBLIC KEY-----')) {
    return undefined;
  }
  return result.stdout.replace(/\s/g, '');
}

function createCommandCheck(command: string): DoctorCheck {
  const ok = commandExists(command);
  return {
    name: command,
    ok,
    detail: ok ? 'found on PATH' : 'not found on PATH',
  };
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore' }).status === 0;
}

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  expectedName: string,
): string | undefined {
  const normalizedExpectedName = expectedName.toUpperCase();
  return Object.entries(environment).find(
    ([name]) => name.toUpperCase() === normalizedExpectedName,
  )?.[1];
}

function runDoctorCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): DoctorCommandResult {
  const executable = resolveDoctorCommand(command, args);
  const result = spawnSync(executable.command, executable.args, {
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/** Node cannot execute Azure CLI's standard az.cmd shim directly on Windows. */
function resolveDoctorCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== 'win32' || command.toLowerCase() !== 'az') {
    return { command, args };
  }

  const azCommand = spawnSync('where.exe', ['az.cmd'], { encoding: 'utf8', windowsHide: true });
  const azCmdPath =
    typeof azCommand.stdout === 'string'
      ? azCommand.stdout
          .split(/\r?\n/)
          .find((path) => path.trim() !== '')
          ?.trim()
      : undefined;
  if (azCmdPath !== undefined) {
    const pythonPath = resolve(dirname(azCmdPath), '..', 'python.exe');
    if (existsSync(pythonPath)) {
      return { command: pythonPath, args: ['-IBm', 'azure.cli', ...args] };
    }
  }

  return { command: 'az.exe', args };
}

function commandResultCheck(
  name: string,
  result: DoctorCommandResult,
  successDetail: string,
): DoctorCheck {
  return {
    name,
    ok: result.status === 0,
    detail: result.status === 0 ? successDetail : commandFailureDetail(result, `${name} failed`),
  };
}

function commandFailureDetail(result: DoctorCommandResult, fallback: string): string {
  if (result.error !== undefined) {
    return result.error.message;
  }
  const detail = result.stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .at(-1);
  return detail ?? fallback;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
