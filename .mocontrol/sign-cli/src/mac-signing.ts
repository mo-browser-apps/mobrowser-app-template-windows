import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SigningMaterial } from './model.js';
import { runMacCommand } from './mac-command.js';

const bundledCertificateDirectory = fileURLToPath(
  new URL('../assets/certificates/', import.meta.url),
);

const developerIdIntermediates = [
  {
    fileName: 'DeveloperIDG2CA.cer',
    issuerMarker: 'OU=G2',
    sha256: 'f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a',
  },
  {
    fileName: 'DeveloperIDCA.cer',
    issuerMarker: 'OU=Apple Certification Authority',
    sha256: '7afc9d01a62f03a2de9637936d4afe68090d2de18d03f29c88cfb0b1ba63587f',
  },
] as const;

/** Verifies that a valid signature belongs to the authorized app and Developer ID identity. */
export function assertExpectedMacSigningIdentity(
  details: string,
  material: Pick<SigningMaterial, 'projectId' | 'codesignIdentity' | 'teamId'>,
): void {
  const reportedLines = new Set(details.split(/\r?\n/).map((line) => line.trim()));
  const expectedLines = [
    `Identifier=${material.projectId}`,
    `Authority=${material.codesignIdentity}`,
    'Authority=Developer ID Certification Authority',
    `TeamIdentifier=${material.teamId}`,
  ];
  const missing = expectedLines.filter((line) => !reportedLines.has(line));
  if (missing.length > 0) {
    throw new Error(
      `Signed app does not have the expected application identifier, Developer ID certificate chain, and Team ID: missing ${missing.join(', ')}.`,
    );
  }
}

/** Chooses a bundled Apple intermediate based on the imported leaf certificate. */
export function selectDeveloperIdIntermediate(
  issuer: string,
): (typeof developerIdIntermediates)[number] {
  const intermediate = developerIdIntermediates.find(
    (candidate) =>
      issuer.includes('CN=Developer ID Certification Authority') &&
      issuer.includes(candidate.issuerMarker),
  );
  if (intermediate === undefined) {
    throw new Error(
      `Unsupported Developer ID certificate issuer: ${issuer}. Update the bundled Apple intermediate certificates.`,
    );
  }
  return intermediate;
}

export async function resolveBundledDeveloperIdIntermediate(issuer: string): Promise<string> {
  const intermediate = selectDeveloperIdIntermediate(issuer);
  const path = join(bundledCertificateDirectory, intermediate.fileName);
  const contents = await readFile(path);
  const actualHash = createHash('sha256').update(contents).digest('hex');
  if (actualHash !== intermediate.sha256) {
    throw new Error(
      `Bundled Apple intermediate certificate failed its SHA-256 check: ${intermediate.fileName}`,
    );
  }
  return path;
}

export async function assertMacTools(): Promise<void> {
  for (const command of [
    'security',
    'openssl',
    'npm',
    'codesign',
    'spctl',
    'xcrun',
    'hdiutil',
    'plutil',
  ]) {
    await runMacCommand('which', [command]);
  }
  await runMacCommand('xcrun', ['--find', 'notarytool']);
  await runMacCommand('xcrun', ['--find', 'stapler']);
}
