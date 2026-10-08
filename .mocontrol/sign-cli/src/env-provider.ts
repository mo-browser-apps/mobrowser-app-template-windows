import { readFile } from 'node:fs/promises';

export { EnvSigningProvider } from './providers/env-signing-provider.js';
export type { SigningProject, SigningProvider } from './providers/signing-provider.js';

type Env = NodeJS.ProcessEnv;

const executionEnvironmentSigningOverrides = [
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_SECRET',
] as const;

/** An explicitly selected env file is the source of truth for its own keys. */
export function mergeEnvFileWithProcessEnvironment(
  envFile: Env | undefined,
  processEnvironment: Env,
): Env {
  return { ...processEnvironment, ...envFile };
}

/**
 * Keeps provider env files from replacing runtime executables, trust stores,
 * proxies, or package-manager settings. Only the optional certificate-login
 * values are shared with the Windows signing executor.
 */
export function createReleaseExecutionEnvironment(
  processEnvironment: Env,
  signingEnvironment: Env,
): Env {
  const environment = { ...processEnvironment };
  for (const name of executionEnvironmentSigningOverrides) {
    const value = signingEnvironment[name];
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

/** Parses local runtime configuration without echoing secret values in errors. */
export async function loadEnvFile(path: string): Promise<Env> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const values: Env = {};
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid .env entry at line ${index + 1} in ${path}.`);
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}
