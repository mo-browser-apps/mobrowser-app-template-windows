import {
  signingMaterialSchema,
  windowsSigningMaterialSchema,
  type SigningMaterial,
  type WindowsSigningMaterial,
} from '../common/model.js';
import type { SigningProject, SigningProvider } from './signing-provider.js';

const requiredMacEnvironmentVariables = [
  'MACOS_CODESIGN_IDENTITY',
  'MACOS_TEAM_ID',
  'MACOS_APPLE_ID',
  'MACOS_APPLE_PASSWORD',
  'MACOS_SIGNING_P12_PATH',
  'MACOS_SIGNING_P12_PASSWORD',
] as const;

const requiredWindowsEnvironmentVariables = [
  'AZURE_SIGNING_ENDPOINT',
  'AZURE_SIGNING_ACCOUNT_NAME',
  'AZURE_SUBSCRIPTION_ID',
] as const;

/** Runtime-only local provider. A remote authenticated provider can implement the same contract. */
export class EnvSigningProvider implements SigningProvider {
  public constructor(private readonly environment: NodeJS.ProcessEnv) {}

  /** @deprecated Use getMacSigningMaterial through the SigningProvider contract. */
  public async getSigningMaterial(project: SigningProject): Promise<SigningMaterial> {
    return this.getMacSigningMaterial(project);
  }

  public async getMacSigningMaterial(project: SigningProject): Promise<SigningMaterial> {
    const missing = requiredMacEnvironmentVariables.filter((name) =>
      isBlank(this.environment[name]),
    );
    if (missing.length > 0) {
      throw new Error(
        `EnvSigningProvider requires these environment variables: ${missing.join(', ')}`,
      );
    }
    return signingMaterialSchema.parse({
      projectId: project.id,
      codesignIdentity: this.environment.MACOS_CODESIGN_IDENTITY,
      teamId: this.environment.MACOS_TEAM_ID,
      appleId: this.environment.MACOS_APPLE_ID,
      appleAppSpecificPassword: this.environment.MACOS_APPLE_PASSWORD,
      signingP12Path: this.environment.MACOS_SIGNING_P12_PATH,
      p12Password: this.environment.MACOS_SIGNING_P12_PASSWORD,
    });
  }

  public async getWindowsSigningMaterial(project: SigningProject): Promise<WindowsSigningMaterial> {
    const missing: string[] = requiredWindowsEnvironmentVariables.filter((name) =>
      isBlank(this.environment[name]),
    );
    const profileName =
      this.environment.AZURE_SIGNING_PROFILE_NAME ??
      this.environment.AZURE_CERTIFICATE_PROFILE_NAME;
    if (isBlank(profileName)) {
      missing.push('AZURE_SIGNING_PROFILE_NAME');
    }
    if (missing.length > 0) {
      throw new Error(
        `EnvSigningProvider requires these environment variables: ${missing.join(', ')}`,
      );
    }
    return windowsSigningMaterialSchema.parse({
      projectId: project.id,
      endpoint: this.environment.AZURE_SIGNING_ENDPOINT,
      accountName: this.environment.AZURE_SIGNING_ACCOUNT_NAME,
      certificateProfileName: profileName,
      subscriptionId: this.environment.AZURE_SUBSCRIPTION_ID,
    });
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}
