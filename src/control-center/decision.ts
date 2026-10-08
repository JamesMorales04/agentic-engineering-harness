import path from "node:path";
import { assertResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import { loadOperation, currentControllerEpoch } from "../operations/state.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import { assertDecisionBindingMatchesRequest, assertDecisionRequestV1, HumanDecisionLedgerV2 } from "../security/humanDecision.js";
import { runtimeProjectId } from "../runtime/index.js";
import { requestOwnerHardProtectionExemption } from "../candidates/repairOwnerExemption.js";

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

export interface ControlCenterExemptionSubmissionV1 {
  operationId: string;
  purpose: "HARD_PROTECTION_EXEMPTION";
  paths: string[];
  reason: string;
  expiresAt?: string;
}

export async function recordControlCenterDecision(root: string, ledger: HumanDecisionLedgerV2, value: unknown, actorId: string): Promise<Record<string, unknown>> {
  // Trusted-issuance routing (B2): HARD_PROTECTION_EXEMPTION purpose routes
  // ONLY through the authenticated paired session to
  // requestOwnerHardProtectionExemption, with actorId bound from the SESSION.
  // Product-choice submissions follow the existing HUMAN_REQUIRED path.
  if (isExemptionSubmission(value)) {
    return recordControlCenterExemptionRequest(root, value, actorId);
  }
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
  assertResolvedOperationPolicyV2(policy);
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

/**
 * Trusted-issuance detector (B2, DETERMINISTIC): an exemption submission is
 * an object whose `purpose` is the HARD_PROTECTION_EXEMPTION discriminator.
 * Anything else falls through to the product-choice parser (which rejects
 * unknown fields fail-closed, so exemption fields can never be mistaken for
 * a product choice).
 */
function isExemptionSubmission(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const purpose = record["purpose"];
  return purpose === "HARD_PROTECTION_EXEMPTION"
    || (typeof purpose === "object" && purpose !== null && !Array.isArray(purpose)
      && (purpose as Record<string, unknown>)["kind"] === "HARD_PROTECTION_EXEMPTION");
}

function parseExemptionSubmission(value: unknown): ControlCenterExemptionSubmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("exemption submission must be an object.");
  const input = value as Record<string, unknown>;
  // Session binding (never caller-supplied): any actor field in the body is a
  // forgery attempt — the actor always comes from the paired session.
  const forbiddenActorFields = ["actorId", "actor", "decidedActor", "decidedBy"];
  for (const field of forbiddenActorFields) {
    if (field in input) throw new Error("exemption submission must not carry a caller-supplied actor; the actor is bound from the paired Control Center session.");
  }
  const supported = new Set(["operationId", "purpose", "paths", "reason", "expiresAt"]);
  const extra = Object.keys(input).filter((key) => !supported.has(key));
  if (extra.length) throw new Error(`exemption submission contains unsupported fields: ${extra.join(", ")}.`);
  const operationId = input["operationId"];
  if (typeof operationId !== "string" || !operationId.trim()) throw new Error("exemption submission requires operationId.");
  const purpose = input["purpose"];
  const purposeOk = purpose === "HARD_PROTECTION_EXEMPTION"
    || (typeof purpose === "object" && purpose !== null && !Array.isArray(purpose)
      && (purpose as Record<string, unknown>)["kind"] === "HARD_PROTECTION_EXEMPTION"
      && Object.keys(purpose as Record<string, unknown>).length === 1);
  if (!purposeOk) throw new Error("exemption submission requires purpose 'HARD_PROTECTION_EXEMPTION'.");
  const paths = input["paths"];
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 || !paths.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error("exemption submission requires 1 to 8 exact file paths.");
  }
  const reason = input["reason"];
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2_000) throw new Error("exemption submission requires a non-empty reason no longer than 2000 characters.");
  const expiresAt = input["expiresAt"];
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
    throw new Error("exemption submission expiresAt must be a valid instant.");
  }
  return {
    operationId: (operationId as string).trim(),
    purpose: "HARD_PROTECTION_EXEMPTION",
    paths: (paths as string[]).map((entry) => (entry as string).trim()),
    reason: (reason as string),
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
}

function requirePairedSessionActor(actorId: string): string {
  // Paired Control Center sessions mint `human:control-center:<hash>` (see
  // server.ts pair()). Only that prefix proves the request arrived over the
  // authenticated paired session with secret-cookie + CSRF. Any other
  // human:* (including human:owner:* or human:forged) via this path is a
  // direct/unauthenticated call and is refused.
  if (typeof actorId !== "string" || !actorId.startsWith("human:control-center:")) {
    throw new Error("exemption issuance requires an authenticated paired Control Center session actor (human:control-center:*); direct or unauthenticated calls cannot create an exemption request.");
  }
  return actorId;
}

/**
 * Trusted issuance (B2, HUMAN + DETERMINISTIC): the ONLY production route to
 * an owner hard-protection exemption request. The actor is bound from the
 * authenticated paired session (server-derived `human:control-center:*`),
 * never from caller-supplied body fields. Routes to
 * requestOwnerHardProtectionExemption (intent); authority still requires the
 * controller-token-anchored MAC grant. Ledger `record` stays
 * non-authoritative and is never used here. No CLI exists for this path.
 */
export async function recordControlCenterExemptionRequest(
  root: string,
  value: unknown,
  sessionActorId: string,
): Promise<Record<string, unknown>> {
  const actorId = requirePairedSessionActor(sessionActorId);
  const input = parseExemptionSubmission(value);
  if (input.operationId && path.isAbsolute(input.operationId)) throw new Error("exemption submission operationId must not be absolute.");
  const { decision, exemptionId, binding } = await requestOwnerHardProtectionExemption({
    root,
    operationId: input.operationId,
    paths: input.paths,
    reason: input.reason,
    actorId,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
  return {
    version: 1,
    accepted: true,
    exemptionId,
    decisionId: decision.decisionId,
    operationId: decision.operationId,
    candidateRevision: binding.candidate.revision,
  };
}
