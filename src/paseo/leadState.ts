/**
 * Durable managed-lead session state (leaf module, no runtime imports).
 *
 * lead-session.json written by `aeh start` is the authority for which Paseo
 * session is the managed Lead for a control root. This module holds only the
 * state shape and version constants so deterministic verifiers
 * (operations/leadBinding.ts) can read them without importing the heavy
 * `paseo/start` launch path.
 */
export const PASEO_BOOTSTRAP_VERSION = 14;

export interface PaseoLeadState {
  version: 2;
  bootstrapVersion: number;
  aehVersion: string;
  aehCommand: string;
  projectRoot: string;
  projectName: string;
  agentId: string;
  title: string;
  leadAgent: string;
  provider: string;
  model: string;
  createdAt: string;
  generation?: number;
  handoffPath?: string;
}
