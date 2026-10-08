// Backward-compatible public entrypoint. Platform coordination lives in core/mac.
export * from './core/mac/executor.js';
export {
  findMountedProjectPackagingDmgs,
  findNewArtifact,
  findNewArtifacts,
  findNewDirectArtifact,
  macBuildOutputDirectory,
  macOutputDirectoryName,
  removePreviousMacBuildOutput,
} from './mac-artifacts.js';
export { recoverInterruptedTemporaryKeychains } from './mac-keychain.js';
export {
  assertExpectedMacSigningIdentity,
  resolveBundledDeveloperIdIntermediate,
  selectDeveloperIdIntermediate,
} from './mac-signing.js';
