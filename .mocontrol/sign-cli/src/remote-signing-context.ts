import { z } from 'zod';

import type { AuthSession } from './auth-store.js';
import { loadAuthSession } from './auth-store.js';
import type { ReleasePlatform, ReleaseSigningContext } from './core/release.js';
import { createReleaseExecutionEnvironment } from './env-provider.js';
import { EnvSigningProvider } from './providers/env-signing-provider.js';
import type { SigningProject } from './providers/signing-provider.js';

export const signingProtocolVersion = '1';
export const signingProtocolHeader = 'x-mocontrol-signing-protocol';

const deviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(32),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const deviceTokenResponseSchema = z.object({
  access_token: z.string().min(32),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  subject: z.string().min(1),
});
const leaseResponseSchema = z.object({
  leaseToken: z.string().min(32),
  projectId: z.string().min(1),
  platform: z.enum(['macos', 'windows']),
  expiresAt: z.string().datetime(),
});
const credentialsResponseSchema = z.object({
  projectId: z.string().min(1),
  platform: z.enum(['macos', 'windows']),
  credentials: z.record(z.string()),
});

export async function loadRemoteSigningContext(
  project: SigningProject,
  platform: ReleasePlatform,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseSigningContext> {
  const session = await loadAuthSession(processEnvironment);
  const credentials = await fetchSigningCredentials(session, project.id, platform);
  return {
    provider: new EnvSigningProvider(credentials),
    environment: createReleaseExecutionEnvironment(processEnvironment, credentials),
  };
}

export async function fetchSigningCredentials(
  session: AuthSession,
  projectId: string,
  platform: ReleasePlatform,
  fetcher: typeof fetch = fetch,
): Promise<NodeJS.ProcessEnv> {
  assertSessionCurrent(session);
  const leaseResponse = await protocolFetch(fetcher, `${session.serverUrl}/v1/signing/leases`, {
    method: 'POST',
    headers: authorizedHeaders(session.token),
    body: JSON.stringify({ projectId, platform }),
  });
  if (!leaseResponse.ok) {
    throw new Error(
      await safeServerError(leaseResponse, 'The signing server rejected the lease request.'),
    );
  }
  const lease = leaseResponseSchema.parse(await leaseResponse.json());
  if (lease.projectId !== projectId || lease.platform !== platform) {
    throw new Error('The signing server returned a lease for a different project or platform.');
  }

  const credentialResponse = await protocolFetch(
    fetcher,
    `${session.serverUrl}/v1/signing/credentials`,
    {
      method: 'POST',
      headers: authorizedHeaders(lease.leaseToken),
      body: JSON.stringify({ projectId, platform }),
    },
  );
  if (!credentialResponse.ok) {
    throw new Error(
      await safeServerError(
        credentialResponse,
        'The signing server rejected the credential request.',
      ),
    );
  }
  const body = credentialsResponseSchema.parse(await credentialResponse.json());
  if (body.projectId !== projectId || body.platform !== platform) {
    throw new Error('The signing server returned credentials for a different project or platform.');
  }
  return body.credentials;
}

export type DeviceAuthorization = z.infer<typeof deviceAuthorizationResponseSchema>;

export async function startDeviceAuthorization(
  serverUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await protocolFetch(fetcher, `${serverUrl}/v1/auth/device/authorizations`, {
    method: 'POST',
    headers: protocolHeaders(),
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(await safeServerError(response, 'Could not start login.'));
  }
  return deviceAuthorizationResponseSchema.parse(await response.json());
}

export async function waitForDeviceSession(
  serverUrl: string,
  authorization: DeviceAuthorization,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<AuthSession> {
  const deadline = Date.now() + authorization.expires_in * 1_000;
  while (Date.now() < deadline) {
    const response = await protocolFetch(fetcher, `${serverUrl}/v1/auth/device/tokens`, {
      method: 'POST',
      headers: protocolHeaders(),
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: authorization.device_code,
      }),
    });
    if (response.ok) {
      const result = deviceTokenResponseSchema.parse(await response.json());
      return {
        serverUrl,
        token: result.access_token,
        subject: result.subject,
        expiresAt: new Date(Date.now() + result.expires_in * 1_000).toISOString(),
      };
    }
    if ((await serverErrorCode(response)) !== 'authorization_pending') {
      throw new Error(await safeServerError(response, 'Login failed.'));
    }
    await wait(authorization.interval * 1_000);
  }
  throw new Error('Login timed out before it was approved. Run mocontrol-cli auth login again.');
}

export async function revokeSession(
  session: AuthSession,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await protocolFetch(fetcher, `${session.serverUrl}/v1/auth/session`, {
    method: 'DELETE',
    headers: authorizedHeaders(session.token),
  });
  if (!response.ok) {
    throw new Error(await safeServerError(response, 'Server-side logout failed.'));
  }
}

function assertSessionCurrent(session: AuthSession): void {
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error('The MoControl session has expired. Log in again.');
  }
}

function protocolHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', [signingProtocolHeader]: signingProtocolVersion };
}

function authorizedHeaders(token: string): Record<string, string> {
  return { ...protocolHeaders(), authorization: `Bearer ${token}` };
}

async function protocolFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetcher(url, init);
  if (response.headers.get(signingProtocolHeader) !== signingProtocolVersion) {
    throw new Error('The server does not support the CLI signing protocol version.');
  }
  return response;
}

async function safeServerError(response: Response, fallback: string): Promise<string> {
  try {
    const result = z.object({ error: z.string().min(1) }).parse(await response.json());
    return result.error;
  } catch {
    return `${fallback} HTTP ${response.status}.`;
  }
}

async function serverErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json();
    return z.object({ error: z.string() }).parse(body).error;
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
