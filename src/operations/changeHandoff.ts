import type { WorkerSession } from "../core/types.js";
import { acceptedStructuredResultForAgent } from "../workers/resultGateway.js";
import { loadOperation } from "./state.js";

export interface DurableAgentEvidence<T> {
  payload: T;
  artifact: string;
  sha256: string;
}

export async function requireDurableChangeHandoff<T>(
  root: string,
  label: string,
  session: WorkerSession,
  schema: { parse(value: unknown): T },
  controlRoot = root,
  expected: { operationId?: string; contract?: string; phase?: string } = {}
): Promise<DurableAgentEvidence<T>> {
  if (session.exitCode !== 0) throw new Error(`${label}_FAILED: ${session.stderr || session.stdout}`);
  if (!session.id) throw new Error(`${label}_RESULT_ID_MISSING: structured handoff requires a durable agent session id.`);
  const accepted = await acceptedStructuredResultForAgent<T>(controlRoot, session.id, {
    ...expected,
    requireBoundProvenance: true,
    verifyCurrentCandidate: true
  });
  if (!accepted) {
    // R15-F9: a durable contract-delivery rejection (for example CANDIDATE_WORKSPACE_MISMATCH)
    // must not be masked by the generic missing-artifact classification. The owning failure code
    // is durable on the session participant record written by the finalization path; surface it
    // as the terminal error prefix while keeping the typed missing-artifact rejection.
    const owningFailure = await durableContractDeliveryFailure(controlRoot, expected.operationId, session.id);
    throw new Error(owningFailure
      ? `${owningFailure}: ${label}_RESULT_ARTIFACT_MISSING: agent completed without an accepted structured result artifact.`
      : `${label}_RESULT_ARTIFACT_MISSING: agent completed without an accepted structured result artifact.`);
  }
  let payload: T;
  try { payload = schema.parse(accepted.payload); }
  catch (error) { throw new Error(`${label}_RESULT_INVALID: ${String(error)}`); }
  return { payload, artifact: accepted.artifact, sha256: accepted.sha256 };
}

/**
 * The owning contract-delivery failure code persisted for a bounded session. Finalization records
 * the exact structured-result rejection (for example `CANDIDATE_WORKSPACE_MISMATCH: …`) on the
 * session participant record; this reads that durable evidence without weakening any gate.
 */
async function durableContractDeliveryFailure(controlRoot: string, operationId: string | undefined, sessionId: string): Promise<string | undefined> {
  if (!operationId) return undefined;
  const operation = await loadOperation(controlRoot, operationId).catch(() => undefined);
  const error = operation?.participants?.[sessionId]?.error;
  if (typeof error !== "string" || !error.trim()) return undefined;
  const code = error.trim().split(":")[0].trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(code) ? code : error.trim().slice(0, 240);
}
