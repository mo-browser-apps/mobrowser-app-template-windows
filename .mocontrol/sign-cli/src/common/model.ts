import { z } from 'zod';

export const macOSBundleSchema = z.object({
  bundleID: z.string().min(1),
  codesignIdentity: z.string().min(1),
  teamID: z.string().min(1),
  appleID: z.string().min(1),
  password: z.string().min(1),
});

export const windowsBundleSchema = z
  .object({
    signCommand: z.string().optional(),
    installer: z
      .object({
        exe: z
          .object({
            packageId: z.string().min(1),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type MacOSBundle = z.infer<typeof macOSBundleSchema>;
export type WindowsBundle = z.infer<typeof windowsBundleSchema>;

/**
 * Parse only the platform-neutral project envelope here. The selected
 * platform bundle is validated separately so an unused platform's incomplete
 * signing configuration cannot block a release.
 */
export const moBrowserConfigSchema = z
  .object({
    app: z
      .object({
        bundle: z
          .object({
            macOS: z.unknown().optional(),
            Windows: z.unknown().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type MoBrowserConfig = z.infer<typeof moBrowserConfigSchema>;

export const signingMaterialSchema = z.object({
  projectId: z.string().min(1),
  codesignIdentity: z.string().min(1),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  appleId: z.string().email(),
  appleAppSpecificPassword: z.string().min(1),
  signingP12Path: z.string().min(1),
  p12Password: z.string().min(1),
});

export type SigningMaterial = z.infer<typeof signingMaterialSchema>;

const artifactSigningEndpointHost = /^[a-z0-9-]+\.codesigning\.azure\.net$/i;

/** Returns the canonical Artifact Signing origin and rejects non-service URLs. */
export function normalizeArtifactSigningEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Artifact Signing endpoint must be a valid HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !artifactSigningEndpointHost.test(parsed.hostname) ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'Artifact Signing endpoint must be an HTTPS origin under codesigning.azure.net.',
    );
  }
  return parsed.origin.toLowerCase();
}

const artifactSigningEndpointSchema = z
  .string()
  .min(1)
  .superRefine((endpoint, context) => {
    try {
      normalizeArtifactSigningEndpoint(endpoint);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const windowsSigningMaterialSchema = z.object({
  projectId: z.string().min(1),
  endpoint: artifactSigningEndpointSchema,
  accountName: z.string().min(1),
  certificateProfileName: z.string().min(1),
  subscriptionId: z.string().min(1),
});

export type WindowsSigningMaterial = z.infer<typeof windowsSigningMaterialSchema>;
