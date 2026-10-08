import crypto from "node:crypto";
import path from "node:path";
import { AehError } from "../core/errors.js";
import { sha256Canonical } from "../core/digest.js";
import { assertResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import {
  controllerTokenFromEnvironment,
  currentControllerEpoch,
  isTerminalOperation,
  loadOperation,
  resolveOperationStateRoot,
  updateOperationMetadata,
  type OperationRecordV2,
} from "../operations/state.js";
import { isManagedBoundedAgent } from "../operations/executionContext.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import {
  HumanDecisionLedgerV2,
  assertDecisionV2,
  type HumanDecisionBindingV2,
  type HumanDecisionV2,
} from "../security/humanDecision.js";
import {
  computeOwnerExemptionMac,
  type OwnerHardProtectionExemptionGrantV1,
} from "../security/ownerExemption.js";
import {
  isExactRepairScopeFilePath,
  isSafeRepairScopePath,
  normalizeRepairScopePath,
} from "./repairScope.js";

/** Re-exported authority gates (implemented alongside the amendment gates to
 * avoid a candidates-layer import cycle; see src/candidates/repairScope.ts). */
export {
  applyOwnerExemptedRepairScopeAmendment,
  findCoveringOwnerHardProtectionExemption,
  verifyOwnerHardProtectionExemption,
} from "./repairScope.js";

/**
 * Owner-scoped hard-protection exemption: human-surface issuance (intent) +
 * controller-token-gated anchoring (authority).
 *
 * Mechanism classification (decision-mechanism invariant): DETERMINISTIC +
 * HUMAN authority. Human intent enters only through this human-surface
 * request path; authority is granted only by the controller-held token MAC
 * anchor. Model reasoning grants nothing at any step.
 *
 * - `requestOwnerHardProtectionExemption` records intent as a ledger
 *   APPROVE/HARD_PROTECTION_EXEMPTION decision. It refuses managed bounded
 *   agents outright (confused-deputy refusal: a participant must never steer
 *   an exemption, even by invoking issuance), and requires a `human:*` actor.
 *   The ledger record alone authorizes NOTHING.
 * - `anchorOwnerHardProtectionExemption` mints the unforgeable grant: it runs
 *   inside a controller-token-gated operation mutation, binds the live
 *   operationId + controller epoch + exact paths + ledger decision digest
 *   under HMAC-SHA256(controllerToken). A shell caller without the token
 *   cannot forge the MAC (tokens never reach managed children: fresh-built
 *   managed envs, allowlisted direct envs, managed-child env scrubbing).
 *
 * Production wiring: the human acts through the paired Control Center (or an
 * owner-local controller-mediated surface) which supplies the human actor;
 * the controller process (token holder) anchors. The gates — not the
 * transport — provide the human-surface-only guarantee.
 */

export function resolveOwnerExemptionLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(root), ".harness", "security", "human-decisions.json"));
}

function liveExemptionBinding(operation: OperationRecordV2, action: string): HumanDecisionBindingV2 {
  const candidate = operation.candidateRevision;
  const policy = operation.resolvedOperationPolicy;
  if (!candidate || !policy || !Number.isSafeInteger(operation.operationExecutionRevision)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_AUTHORITY_REQUIRED: ${action} requires the current candidate, execution revision, and frozen policy.`);
  }
  assertResolvedOperationPolicyV2(policy);
  if (policy.operationId !== operation.id || policy.operationExecutionRevision !== operation.operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(operation) || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_POLICY_STALE: ${action} does not match the current operation, candidate, execution revision, project, and epoch.`);
  }
  return {
    operationId: operation.id,
    candidate,
    operationExecutionRevision: operation.operationExecutionRevision!,
    policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(operation),
  };
}

/**
 * Normalize + bound exemption paths. Exact named files only (no globs);
 * new-file paths are allowed (declared upfront — existence is never
 * required). Agent/blocifier input must never flow here: paths come only
 * from the human-surface caller.
 */
export function normalizeOwnerExemptionPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 exact file paths.");
  }
  const normalized: string[] = [];
  for (const entry of paths) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${String(entry)}' is not a safe repository-relative path.`);
    }
    if (!isExactRepairScopeFilePath(raw)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${raw}' is not an exact file path; scope exemptions allow exact paths only (no wildcards).`);
    }
    const filePath = normalizeRepairScopePath(raw);
    if (!filePath || !isSafeRepairScopePath(filePath) || !isExactRepairScopeFilePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${raw}' is not an exact safe file path.`);
    }
    normalized.push(filePath);
  }
  const sorted = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  if (!sorted.length || sorted.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 unique exact file paths.");
  }
  return sorted;
}

function requireHumanActor(actorId: string): string {
  if (typeof actorId !== "string" || !actorId.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_NOT_HUMAN: an exemption requires a human actor.");
  }
  const actor = actorId.trim();
  if (!actor.startsWith("human:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_NOT_HUMAN: only a paired or direct human authority may issue a hard-protection exemption.");
  }
  return actor;
}

export async function requestOwnerHardProtectionExemption(input: {
  root: string;
  operationId: string;
  paths: readonly string[];
  reason: string;
  actorId: string;
  expiresAt?: string | Date;
}): Promise<{ decision: HumanDecisionV2; exemptionId: string; binding: HumanDecisionBindingV2 }> {
  // Confused-deputy refusal (HYBRID gate, deterministic enforcement): issuance
  // is human-surface-only. A Harness-spawned bounded participant — which always
  // carries AEH_MANAGED_AGENT=1 — can never issue, request, or steer an
  // exemption, even when it can invoke this function.
  if (isManagedBoundedAgent()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_AGENT_FORBIDDEN: Harness-spawned bounded agents cannot issue hard-protection exemptions; issuance is human-surface-only.");
  }
  const actorId = requireHumanActor(input.actorId);
  if (typeof input.reason !== "string" || !input.reason.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_REASON_REQUIRED: an exemption requires a non-empty human reason.");
  }
  const operation = await loadOperation(input.root, input.operationId);
  if (isTerminalOperation(operation.status)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: a terminal operation cannot receive a hard-protection exemption.");
  }
  const binding = liveExemptionBinding(operation, "exemption issuance");
  const paths = normalizeOwnerExemptionPaths(input.paths);
  const exemptionId = `exemption:${crypto.randomUUID()}`;
  const now = new Date();
  const ledger = resolveOwnerExemptionLedger(input.root);
  const decision = await ledger.record({
    ...binding,
    purpose: { kind: "HARD_PROTECTION_EXEMPTION", exemptionId, paths },
    kind: "APPROVE",
    actorId,
    reason: input.reason.trim(),
    createdAt: now,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
  return { decision, exemptionId, binding };
}

export async function anchorOwnerHardProtectionExemption(input: {
  root: string;
  operationId: string;
  decisionId: string;
}): Promise<OwnerHardProtectionExemptionGrantV1> {
  if (isManagedBoundedAgent()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_AGENT_FORBIDDEN: Harness-spawned bounded agents cannot anchor hard-protection exemptions; anchoring is controller-owned.");
  }
  const ledger = resolveOwnerExemptionLedger(input.root);
  const stored = await ledger.find(input.decisionId);
  if (!stored) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNKNOWN_DECISION: no ledger HumanDecision matches this exemption anchor request.");
  }
  const decision = assertDecisionV2(stored);
  if (decision.kind !== "APPROVE" || decision.purpose.kind !== "HARD_PROTECTION_EXEMPTION") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PURPOSE_MISMATCH: anchoring requires an APPROVE hard-protection-exemption HumanDecision.");
  }
  const now = new Date();
  if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= now.getTime()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_EXPIRED: the exemption intent has expired before anchoring.");
  }
  const operation = await loadOperation(input.root, input.operationId);
  if (isTerminalOperation(operation.status)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: a terminal operation cannot anchor a hard-protection exemption.");
  }
  const live = liveExemptionBinding(operation, "exemption anchoring");
  const decisionBinding: HumanDecisionBindingV2 = {
    operationId: decision.operationId,
    candidate: decision.candidate,
    operationExecutionRevision: decision.operationExecutionRevision,
    policyDigest: decision.policyDigest,
    controllerEpoch: decision.controllerEpoch,
  };
  if (decisionBinding.operationId !== live.operationId || !candidateRevisionsEqual(decisionBinding.candidate, live.candidate)
    || decisionBinding.operationExecutionRevision !== live.operationExecutionRevision
    || decisionBinding.policyDigest !== live.policyDigest || decisionBinding.controllerEpoch !== live.controllerEpoch) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the exemption intent does not match the current operation, candidate, execution revision, policy, or controller epoch.");
  }
  const token = controllerTokenFromEnvironment();
  if (!token) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNANCHORED: anchoring requires the live controller token.");
  }
  const createdAt = now.toISOString();
  const body = {
    version: 1 as const,
    kind: "OWNER_HARD_PROTECTION_EXEMPTION" as const,
    mechanism: "DETERMINISTIC" as const,
    exemptionId: decision.purpose.exemptionId,
    operationId: live.operationId,
    controllerEpoch: live.controllerEpoch,
    candidateRevision: live.candidate.revision,
    candidateIdentityDigest: live.candidate.identityDigest,
    policyDigest: live.policyDigest,
    operationExecutionRevision: live.operationExecutionRevision,
    paths: decision.purpose.paths,
    decisionId: decision.decisionId,
    decisionDigest: sha256Canonical(decision),
    decidedActor: decision.actorId,
    decisionReason: decision.reason.trim(),
    createdAt,
    ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
  };
  const grant: OwnerHardProtectionExemptionGrantV1 = { ...body, mac: computeOwnerExemptionMac(token, body) };
  // Controller-token-gated durable anchor: updateOperationMetadata routes
  // through mutateOperation, which demands the current epoch + token for this
  // event type. A shell caller without the token cannot reach the write.
  await updateOperationMetadata(input.root, input.operationId, (current) => {
    if (isTerminalOperation(current.status)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: the operation reached a terminal state before the exemption anchored.");
    }
    const currentBinding = liveExemptionBinding(current, "exemption anchor commit");
    if (currentBinding.operationId !== live.operationId || !candidateRevisionsEqual(currentBinding.candidate, live.candidate)
      || currentBinding.operationExecutionRevision !== live.operationExecutionRevision
      || currentBinding.policyDigest !== live.policyDigest || currentBinding.controllerEpoch !== live.controllerEpoch) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: operation identity changed before the exemption anchor committed.");
    }
    return { ownerExemptions: { ...(current.ownerExemptions ?? {}), [grant.exemptionId]: grant } };
  }, { touchRevision: true, eventType: "operation.owner-exemption.anchored" });
  const anchored = await loadOperation(input.root, input.operationId);
  const persisted = anchored.ownerExemptions?.[grant.exemptionId];
  if (!persisted || persisted.mac !== grant.mac) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNANCHORED: the exemption grant did not persist; the operation may have reached a terminal state.");
  }
  return persisted;
}
