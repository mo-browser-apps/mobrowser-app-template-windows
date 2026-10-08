import { spawn } from 'node:child_process';

import type { Command } from 'commander';

import {
  DEFAULT_SIGNING_SERVER_URL,
  loadAuthSession,
  normalizeServerUrl,
  removeAuthSession,
  saveAuthSession,
} from '../auth-store.js';
import {
  revokeSession,
  startDeviceAuthorization,
  waitForDeviceSession,
} from '../remote-signing-context.js';

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage the signing-server login');

  auth
    .command('login')
    .description('Log in through the local browser approval page')
    .option('--server <url>', 'override the MoControl server URL', DEFAULT_SIGNING_SERVER_URL)
    .option('--no-open', 'do not open the local approval page automatically')
    .action(async ({ server, open }: { server: string; open?: boolean }) => {
      const serverUrl = normalizeServerUrl(server);
      const authorization = await startDeviceAuthorization(serverUrl);
      console.log(`Approve this login in your browser: ${authorization.verification_uri_complete}`);
      console.log(`Code: ${authorization.user_code}`);
      if (open !== false) openBrowser(authorization.verification_uri_complete);
      const session = await waitForDeviceSession(serverUrl, authorization);
      await saveAuthSession(session);
      console.log(
        `Logged in to ${session.serverUrl} as ${session.subject}; session expires ${session.expiresAt}.`,
      );
    });

  auth
    .command('status')
    .description('Show the current signing-server login')
    .action(async () => {
      const session = await loadAuthSession();
      console.log(
        `Logged in to ${session.serverUrl} as ${session.subject}; session expires ${session.expiresAt}.`,
      );
    });

  auth
    .command('logout')
    .description('Remove the saved signing-server login')
    .action(async () => {
      const session = await loadAuthSession();
      let revocationError: unknown;
      try {
        await revokeSession(session);
      } catch (error) {
        revocationError = error;
      } finally {
        await removeAuthSession();
      }
      if (revocationError !== undefined) {
        throw new Error(
          `Local login removed, but server-side revocation failed: ${errorMessage(revocationError)}`,
        );
      }
      console.log('Logged out.');
    });
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argumentsForPlatform = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, argumentsForPlatform, { detached: true, stdio: 'ignore' });
  child.once('error', () => undefined);
  child.unref();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
