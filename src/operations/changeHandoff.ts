import type { WorkerSession } from "../core/types.js";
import { acceptedStructuredResultForAgent } from "../workers/resultGateway.js";

export interface DurableAgentEvidence<T> {
  payload: T;
  artifact: string;
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
  const accepted = await acceptedStructuredResultForAgent<T>(controlRoot, session.id, expected);
  if (!accepted) throw new Error(`${label}_RESULT_ARTIFACT_MISSING: agent completed without an accepted structured result artifact.`);
  let payload: T;
  try { payload = schema.parse(accepted.payload); }
  catch (error) { throw new Error(`${label}_RESULT_INVALID: ${String(error)}`); }
  return { payload, artifact: accepted.artifact };
}
