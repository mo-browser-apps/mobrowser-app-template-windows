import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

export const DEFAULT_SIGNING_SERVER_URL = 'http://127.0.0.1:8787';

const authSessionSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(1),
  subject: z.string().min(1),
  expiresAt: z.string().datetime(),
});
const authMetadataSchema = authSessionSchema.omit({ token: true });

export type AuthSession = z.infer<typeof authSessionSchema>;

export type AuthSecretStore = {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

export function authFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredDirectory = environment.MOCONTROL_CONFIG_DIR;
  return join(configuredDirectory?.trim() || join(homedir(), '.mocontrol'), 'auth.json');
}

export async function saveAuthSession(
  session: AuthSession,
  environment: NodeJS.ProcessEnv = process.env,
  secretStore: AuthSecretStore = systemSecretStore,
): Promise<void> {
  const parsed = authSessionSchema.parse({
    ...session,
    serverUrl: normalizeServerUrl(session.serverUrl),
  });
  const path = authFilePath(environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const previousAccount = await readExistingAccount(path);
  if (previousAccount !== undefined) {
    await secretStore.delete(previousAccount);
  }
  await secretStore.set(parsed.serverUrl, parsed.token);
  try {
    const metadata = authMetadataSchema.parse(parsed);
    await writeFile(path, `${JSON.stringify(metadata, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(path, 0o600);
  } catch (error) {
    await secretStore.delete(parsed.serverUrl);
    throw error;
  }
}

export async function loadAuthSession(
  environment: NodeJS.ProcessEnv = process.env,
  secretStore: AuthSecretStore = systemSecretStore,
): Promise<AuthSession> {
  const path = authFilePath(environment);
  try {
    const parsed = authMetadataSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const serverUrl = normalizeServerUrl(parsed.serverUrl);
    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      await secretStore.delete(serverUrl);
      await rm(path, { force: true });
      throw new AuthStoreError('The saved MoControl session has expired. Log in again.');
    }
    const token = await secretStore.get(serverUrl);
    if (token === null || token === '') {
      throw new AuthStoreError(
        'The MoControl session token is missing from the operating-system credential store. Log in again.',
      );
    }
    return { ...parsed, serverUrl, token };
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error('Not logged in. Run mocontrol-cli auth login first.');
    }
    if (error instanceof AuthStoreError) {
      throw error;
    }
    throw new Error(`Could not read the saved MoControl login at ${path}. Log in again.`);
  }
}

export async function removeAuthSession(
  environment: NodeJS.ProcessEnv = process.env,
  secretStore: AuthSecretStore = systemSecretStore,
): Promise<void> {
  const path = authFilePath(environment);
  try {
    const metadata = authMetadataSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    await secretStore.delete(normalizeServerUrl(metadata.serverUrl));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(
        'Could not remove the saved MoControl token from the operating-system credential store.',
      );
    }
  } finally {
    await rm(path, { force: true });
  }
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The server must be a valid URL.');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'The server must use HTTPS; HTTP is allowed only for a loopback development server.',
    );
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'The server URL must be an origin without credentials, a path, query, or fragment.',
    );
  }
  return url.origin;
}

class AuthStoreError extends Error {}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readExistingAccount(path: string): Promise<string | undefined> {
  try {
    const metadata = authMetadataSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    return normalizeServerUrl(metadata.serverUrl);
  } catch {
    return undefined;
  }
}

const systemSecretStore: AuthSecretStore = {
  async get(account) {
    const keytar = (await import('@github/keytar')).default;
    return keytar.getPassword('mocontrol-cli', account);
  },
  async set(account, secret) {
    const keytar = (await import('@github/keytar')).default;
    await keytar.setPassword('mocontrol-cli', account, secret);
  },
  async delete(account) {
    const keytar = (await import('@github/keytar')).default;
    return keytar.deletePassword('mocontrol-cli', account);
  },
};
