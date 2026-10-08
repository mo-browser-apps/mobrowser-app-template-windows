import type { Command } from 'commander';

import type { DoctorCheck } from '../doctor.js';
import {
  runMacDoctor,
  runMacSigningDoctor,
  runProjectNpmDoctor,
  runWindowsDoctor,
  runWindowsSigningDoctor,
} from '../doctor.js';
import {
  assertProviderManagedMacConfiguration,
  assertWindowsBundleConfiguration,
  deriveProjectId,
  loadMoBrowserConfig,
  resolveProjectDirectory,
} from '../common/project.js';
import { assertReleasePlatform } from '../core/release.js';
import { loadRemoteSigningContext } from '../remote-signing-context.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run the read-only preflight checks required by the release workflow')
    .requiredOption('--project <directory>', 'MoBrowser project directory')
    .option('--platform <platform>', 'platform: macos or windows', 'macos')
    .action(async ({ project, platform }: { project: string; platform: string }) => {
      assertReleasePlatform(platform);
      const checks: DoctorCheck[] = platform === 'macos' ? runMacDoctor() : runWindowsDoctor();

      let projectRoot: string | undefined;
      let projectId: string | undefined;
      try {
        projectRoot = await resolveProjectDirectory(project);
        const config = await loadMoBrowserConfig(projectRoot);
        if (platform === 'macos') {
          assertProviderManagedMacConfiguration(config);
        } else {
          assertWindowsBundleConfiguration(config);
        }
        projectId = deriveProjectId(config, platform);
        checks.push({
          name: 'project configuration',
          ok: true,
          detail: `${platform} configuration is release-ready`,
        });
      } catch (error) {
        checks.push({ name: 'project configuration', ok: false, detail: errorMessage(error) });
      }

      if (projectRoot !== undefined) {
        checks.push(...(await runProjectNpmDoctor(projectRoot, platform)));
      }

      if (projectRoot !== undefined && projectId !== undefined) {
        try {
          const signingProject = { id: projectId, rootDirectory: projectRoot };
          const { provider, environment } = await loadRemoteSigningContext(
            signingProject,
            platform,
          );
          if (platform === 'macos') {
            const material = await provider.getMacSigningMaterial(signingProject);
            checks.push({
              name: 'signing server',
              ok: true,
              detail: 'authenticated credentials received',
            });
            checks.push(...(await runMacSigningDoctor(material)));
          } else {
            const material = await provider.getWindowsSigningMaterial(signingProject);
            checks.push({
              name: 'signing server',
              ok: true,
              detail: 'authenticated credentials received',
            });
            checks.push(...(await runWindowsSigningDoctor(material, environment)));
          }
        } catch (error) {
          checks.push({ name: 'signing server', ok: false, detail: errorMessage(error) });
        }
      }

      for (const check of checks) {
        console.log(`${check.ok ? 'OK' : 'MISSING'} ${check.name}: ${check.detail}`);
      }
      if (!checks.every((check) => check.ok)) {
        process.exitCode = 1;
      }
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
