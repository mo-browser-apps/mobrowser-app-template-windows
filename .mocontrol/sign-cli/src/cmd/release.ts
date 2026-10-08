import type { Command } from 'commander';

import { ReleaseService, assertReleasePlatform } from '../core/release.js';
import { loadRemoteSigningContext } from '../remote-signing-context.js';
import { EnvSigningProvider } from '../providers/env-signing-provider.js';

export function registerReleaseCommand(program: Command): void {
  program
    .command('sign')
    .alias('release')
    .description('Build, sign, verify, and package a macOS or Windows release')
    .requiredOption('--project <directory>', 'MoBrowser project directory')
    .option('--platform <platform>', 'release platform: macos or windows', 'macos')
    .option('--signing-provider <provider>', 'signing provider: remote or env', 'remote')
    .action(
      async ({
        project,
        platform,
        signingProvider,
      }: {
        project: string;
        platform: string;
        signingProvider: string;
      }) => {
        assertReleasePlatform(platform);
        if (signingProvider !== 'remote' && signingProvider !== 'env')
          throw new Error('Choose remote or env signing provider.');
        const loader =
          signingProvider === 'env'
            ? async () => ({
                provider: new EnvSigningProvider(process.env),
                environment: process.env,
              })
            : loadRemoteSigningContext;
        const result = await new ReleaseService(loader).release(project, platform);
        if (result.platform === 'macos') {
          console.log(`Notarized app packaged as DMG: ${result.artifactPath}`);
        } else {
          console.log('Windows release was built, signed, verified, and packaged.');
        }
      },
    );
}
