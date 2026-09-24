import path from "node:path";
import { assertResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { loadOperation, currentControllerEpoch } from "../operations/state.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import { assertDecisionBindingMatchesRequest, assertDecisionRequestV1, HumanDecisionLedgerV2 } from "../security/humanDecision.js";
import { runtimeProjectId } from "../runtime/index.js";

interface ProductChoiceSubmissionV1 {
  operationId: string;
  requestId: string;
  choiceId: string;
  reason?: string;
}

export class ProductChoiceConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "ProductChoiceConflictError"; }
}

export async function recordControlCenterDecision(root: string, ledger: HumanDecisionLedgerV2, value: unknown, actorId: string): Promise<Record<string, unknown>> {
  const input = parseProductChoiceSubmission(value);
  const operation = await loadOperation(root, input.operationId);
  if (operation.root !== path.resolve(root)) throw new Error("product choice operation is bound to another project root.");
  if (operation.status !== "RUNNING" || operation.phase !== "HUMAN_REQUIRED") throw new ProductChoiceConflictError("DECISION_REQUEST_STATE_INVALID: only a running HUMAN_REQUIRED operation can accept a product choice.");
  const request = operation.decisionRequest && assertDecisionRequestV1(operation.decisionRequest);
  const continuation = operation.continuation;
  if (!request || !continuation || continuation.state !== "WAITING"
    || request.requestId !== input.requestId || continuation.requestId !== input.requestId
    || continuation.resumeTarget !== "SPEC_AUTHORING" || continuation.reason !== "PRODUCT_CHOICE") {
    throw new ProductChoiceConflictError("DECISION_REQUEST_STALE: no matching current product-choice continuation is awaiting a decision.");
  }
  const choice = request.choices.find((item) => item.choiceId === input.choiceId);
  if (!choice) throw new ProductChoiceConflictError("DECISION_CHOICE_INVALID: selected choice is not one of the current request's bounded options.");
  const now = new Date();
  if (Date.parse(request.expiresAt) <= now.getTime()) throw new ProductChoiceConflictError("DECISION_REQUEST_EXPIRED: the product-choice request has expired.");

  const candidate = operation.candidateRevision;
  const policy = operation.resolvedOperationPolicy;
  if (!candidate || candidate.projectId !== runtimeProjectId(root) || !policy || !operation.controller?.tokenDigest
    || !Number.isSafeInteger(operation.operationExecutionRevision)) {
    throw new Error("DECISION_AUTHORITY_REQUIRED: product choice requires the current operation, candidate, execution revision, frozen policy, and controller epoch.");
  }
  assertResolvedOperationPolicyV1(policy);
  const binding = {
    operationId: operation.id,
    candidate,
    operationExecutionRevision: operation.operationExecutionRevision!,
    policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(operation)
  };
  if (policy.operationId !== operation.id || policy.projectId !== candidate.projectId
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.operationExecutionRevision !== operation.operationExecutionRevision
    || policy.controllerEpoch !== currentControllerEpoch(operation)) {
    throw new ProductChoiceConflictError("DECISION_BINDING_STALE: current policy does not match the operation, candidate, revision, or controller epoch.");
  }
  assertDecisionBindingMatchesRequest(request, binding);
  if (continuation.operationId !== operation.id || !candidateRevisionsEqual(continuation.candidate, candidate)
    || continuation.operationExecutionRevision !== operation.operationExecutionRevision
    || continuation.policyDigest !== policy.digest || continuation.controllerEpoch !== currentControllerEpoch(operation)) {
    throw new ProductChoiceConflictError("DECISION_CONTINUATION_STALE: saved continuation does not match the current operation authority.");
  }

  let decision: Awaited<ReturnType<HumanDecisionLedgerV2["recordProductChoice"]>>;
  try {
    decision = await ledger.recordProductChoice({
      ...binding,
      kind: "CHOOSE",
      purpose: { kind: "PRODUCT_CHOICE", requestId: request.requestId, choiceId: choice.choiceId },
      actorId,
      reason: input.reason?.trim() || `Paired Control Center selected '${choice.choiceId}'.`,
      expiresAt: request.expiresAt
    }, request.requestId);
  } catch (error) {
    if (error instanceof Error && /already been submitted or replayed|already been consumed/i.test(error.message)) throw new ProductChoiceConflictError(error.message);
    throw error;
  }
  return {
    version: 1,
    accepted: true,
    decisionId: decision.decisionId,
    operationId: operation.id,
    requestId: request.requestId,
    choiceId: choice.choiceId,
    candidateRevision: candidate.revision
  };
}

function parseProductChoiceSubmission(value: unknown): ProductChoiceSubmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product choice submission must be an object.");
  const input = value as Record<string, unknown>;
  const supported = new Set(["operationId", "requestId", "choiceId", "reason"]);
  const extra = Object.keys(input).filter((key) => !supported.has(key));
  if (extra.length) throw new Error(`product choice submission contains unsupported fields: ${extra.join(", ")}.`);
  for (const field of ["operationId", "requestId", "choiceId"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) throw new Error(`product choice submission requires ${field}.`);
  }
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 2_000)) throw new Error("product choice reason must be a string no longer than 2000 characters.");
  return {
    operationId: (input.operationId as string).trim(),
    requestId: (input.requestId as string).trim(),
    choiceId: (input.choiceId as string).trim(),
    ...(typeof input.reason === "string" ? { reason: input.reason } : {})
  };
}
