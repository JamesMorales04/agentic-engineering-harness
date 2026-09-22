import path from "node:path";
import { loadOperation } from "../operations/state.js";
import { HumanDecisionLedgerV1, humanDecisionKindValues } from "../security/humanDecision.js";
import { runtimeProjectId } from "../runtime/index.js";

export async function recordControlCenterDecision(root: string, ledger: HumanDecisionLedgerV1, value: unknown): Promise<Record<string, unknown>> {
  if (!value || typeof value !== "object") throw new Error("human decision must be an object.");
  const input = value as Record<string, unknown>;
  const operationId = typeof input.operationId === "string" ? input.operationId.trim() : "";
  if (!operationId) throw new Error("human decision requires operationId.");
  const operation = await loadOperation(root, operationId);
  if (operation.root !== path.resolve(root)) throw new Error("human decision operation is bound to another project root.");
  if (operation.status === "SUCCEEDED" || operation.status === "FAILED" || operation.status === "CANCELLED") throw new Error("human decision cannot mutate a terminal operation.");
  const candidate = operation.candidateRevision;
  if (!candidate || candidate.projectId !== runtimeProjectId(root)) throw new Error("human decision has no current candidate bound to this project.");
  if (typeof input.kind !== "string" || !humanDecisionKindValues.includes(input.kind as (typeof humanDecisionKindValues)[number])) throw new Error("human decision kind is invalid.");
  const decision = await ledger.record({
    operationId,
    candidate,
    kind: input.kind as (typeof humanDecisionKindValues)[number],
    actorId: typeof input.actorId === "string" ? input.actorId : "",
    reason: typeof input.reason === "string" ? input.reason : "",
    expiresAt: typeof input.expiresAt === "string" ? input.expiresAt : undefined
  });
  return { accepted: true, decisionId: decision.decisionId, operationId, candidateRevision: candidate.revision };
}
