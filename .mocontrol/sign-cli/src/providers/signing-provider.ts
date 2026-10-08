import type { SigningMaterial, WindowsSigningMaterial } from '../common/model.js';

export type SigningProject = {
  /** Stable application identifier used for authorization. */
  id: string;
  /** Canonical local root retained only as execution context. */
  rootDirectory: string;
};

/** Supplies authorized signing material for one project release. */
export interface SigningProvider {
  getMacSigningMaterial(project: SigningProject): Promise<SigningMaterial>;
  getWindowsSigningMaterial(project: SigningProject): Promise<WindowsSigningMaterial>;
}
