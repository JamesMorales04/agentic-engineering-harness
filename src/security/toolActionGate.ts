import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import type { ExecutionBlueprint } from "../architecture/participantPlan.js";
import { assertExecutionBlueprintV2, assertResolvedOperationPolicyV1, type HumanDecisionRequirementV1, type ResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { candidateRevisionsEqual, assertCandidateRevisionV1, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { currentOperationContext, controllerEpochFromEnvironment, currentControllerEpoch, loadOperation, resolveOperationStateRoot, assertCurrentControllerOwner, assertControllerEpoch, type OperationRecordV2 } from "../operations/state.js";
import { isCanonicalRole, roleProfile, type CanonicalRole } from "../participants/index.js";
import { assertExecutionAuthority, type ExecutionAuthorityV1 } from "./executionLease.js";
import { TOOL_ACTION_KINDS_V1, type ToolActionKindV1 } from "./actionKinds.js";
import { HumanDecisionLedgerV2 } from "./humanDecision.js";

export { TOOL_ACTION_KINDS_V1 } from "./actionKinds.js";
export type { ToolActionKindV1 } from "./actionKinds.js";
export type ToolActionImpactV1 = "LOCAL_REPOSITORY_MUTATION" | "LOCAL_RESOURCE_CREATION" | "EXTERNAL_RECONCILABLE" | "EXTERNAL_NON_IDEMPOTENT" | "EXTERNAL_PUBLICATION";
export type ToolActionOutcomeV1 = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export type ToolActionAuthorityEvidenceV1 =
  | { kind: "execution-authority"; authority: ExecutionAuthorityV1 }
  | { kind: "execution-blueprint"; blueprint: ExecutionBlueprint }
  | { kind: "controller-authority"; operationId: string; controllerEpoch: number };

export interface ToolActionRequestV1 {
  root: string;
  operationId: string;
  participantId: string;
  /** Required for participant/blueprint authority; omitted for the deterministic controller actor. */
  role?: CanonicalRole;
  candidate: CandidateRevisionV1;
  actionKey: string;
  action: ToolActionKindV1;
  payload: unknown;
  authority: ToolActionAuthorityEvidenceV1;
  now?: Date;
}

/** Deterministic actor id of the fenced controller that owns an operation. */
export function controllerActorId(operationId: string): string {
  return `controller:${sha256Utf8(operationId).slice(0, 24)}`;
}

export interface ActionIntentV1 {
  version: 2;
  intentId: string;
  actionKey: string;
  operationId: string;
  participantId: string;
  role?: CanonicalRole;
  candidate: CandidateRevisionV1;
  operationExecutionRevision: number;
  policyDigest: string;
  action: ToolActionKindV1;
  impact: ToolActionImpactV1;
  controllerEpoch: number;
  payloadDigest: string;
  authorityBindingDigest: string;
  requestDigest: string;
  createdAt: string;
}

export interface ActionReceiptV1 {
  version: 2;
  receiptId: string;
  intentId: string;
  operationId: string;
  participantId: string;
  candidateDigest: string;
  operationExecutionRevision: number;
  policyDigest: string;
  action: ToolActionKindV1;
  controllerEpoch: number;
  reconciledUnderEpoch?: number;
  outcome: ToolActionOutcomeV1;
  resultDigest: string;
  receiptDigest: string;
  recordedAt: string;
}

export type ToolActionGateResultV1 =
  | { decision: "EXECUTE_ONCE"; intent: ActionIntentV1 }
  | { decision: "ALREADY_COMPLETED"; intent: ActionIntentV1; receipt: ActionReceiptV1 };

const ACTION_IMPACTS: Readonly<Record<ToolActionKindV1, ToolActionImpactV1>> = {
  "git.branch.create": "LOCAL_REPOSITORY_MUTATION",
  "git.commit": "LOCAL_REPOSITORY_MUTATION",
  "git.push": "EXTERNAL_PUBLICATION",
  "github.issue.create": "EXTERNAL_NON_IDEMPOTENT",
  "github.branch.create": "EXTERNAL_RECONCILABLE",
  "github.pull-request.create": "EXTERNAL_RECONCILABLE",
  "paseo.workspace.create": "LOCAL_RESOURCE_CREATION"
};

/** Stable deterministic classification; callers cannot downgrade an action's impact. */
export function classifyToolActionImpact(action: ToolActionKindV1): ToolActionImpactV1 {
  return ACTION_IMPACTS[action];
}

/**
 * Persist one stable intent before a side effect. Repeating the same request
 * returns its receipt or fails closed while the earlier attempt is unresolved.
 */
export async function authorizeToolAction(request: ToolActionRequestV1): Promise<ToolActionGateResultV1> {
  const operation = await loadOperation(resolveOperationStateRoot(request.root), request.operationId);
  const files = actionFiles(request.root, request.operationId, request.actionKey);
  assertControllerEpoch(operation, controllerEpochFromEnvironment(), "tool action authorization");
  const suppliedEpoch = authorityEpoch(request.authority);
  if (suppliedEpoch !== currentControllerEpoch(operation)) throw new Error(`TOOL_ACTION_CONTROLLER_FENCED: action authority cites epoch ${suppliedEpoch}, but the operation is owned by controller epoch ${currentControllerEpoch(operation)}.`);

  const prior = await readJson<ActionIntentV1>(files.intentFile);
  if (prior) {
    assertStoredIntent(prior);
    if (prior.operationId !== request.operationId || prior.action !== request.action || prior.payloadDigest !== sha256Canonical(request.payload) || !candidateRevisionsEqual(prior.candidate, request.candidate)) {
      throw new Error("TOOL_ACTION_INTENT_CONFLICT: action key is already bound to a different operation, candidate, action, or effect.");
    }
    const policy = currentResolvedPolicy(operation, request);
    if (operation.status !== "RUNNING" || prior.operationExecutionRevision !== operation.operationExecutionRevision
      || prior.policyDigest !== policy.digest || prior.controllerEpoch !== currentControllerEpoch(operation)) {
      throw new Error("TOOL_ACTION_POLICY_STALE: prior action intent does not match the current operation, candidate, policy, execution revision, and epoch.");
    }
    const receipt = await readJson<ActionReceiptV1>(files.receiptFile);
    if (receipt) {
      assertStoredReceipt(receipt, prior);
      if (prior.participantId !== request.participantId || prior.role !== request.role) throw new Error("TOOL_ACTION_ACTOR_MISMATCH: completed action receipt is bound to a different actor.");
      await assertCurrentActionAuthority(request, prior.impact, operation, policy, false);
      return { decision: "ALREADY_COMPLETED", intent: prior, receipt };
    }
    if (request.authority?.kind !== "controller-authority" || request.role !== undefined || request.participantId !== controllerActorId(request.operationId)) {
      throw new Error("TOOL_ACTION_RECONCILIATION_AUTHORITY_REQUIRED: unresolved effects may be reconciled only by the current controller owner.");
    }
    assertCurrentControllerOwner(operation, "tool action reconciliation");
    if (operation.status !== "RUNNING" || !operation.candidateRevision || !candidateRevisionsEqual(operation.candidateRevision, prior.candidate)
      || request.authority.operationId !== operation.id || request.authority.controllerEpoch !== currentControllerEpoch(operation)) {
      throw new Error("TOOL_ACTION_RECONCILIATION_STALE: controller, operation, and candidate must be current to reconcile an unresolved effect.");
    }
    throw new Error("TOOL_ACTION_RECONCILIATION_REQUIRED: a prior intent has no receipt; reconcile its external effect before retrying.");
  }
  const orphanReceipt = await readJson<ActionReceiptV1>(files.receiptFile);
  if (orphanReceipt) throw new Error("TOOL_ACTION_RECEIPT_ORPHANED: a receipt exists without its ActionIntent; reconcile the durable state before retrying.");

  const policy = currentResolvedPolicy(operation, request);
  const identity = createActionIdentity(request, policy);
  await assertCurrentActionAuthority(request, identity.impact, operation, policy);
  const intent: ActionIntentV1 = {
    version: 2 as const,
    intentId: identity.intentId,
    actionKey: request.actionKey,
    operationId: request.operationId,
    participantId: request.participantId,
    role: request.role,
    candidate: request.candidate,
    action: request.action,
    impact: identity.impact,
    operationExecutionRevision: identity.operationExecutionRevision,
    policyDigest: identity.policyDigest,
    controllerEpoch: identity.controllerEpoch,
    payloadDigest: identity.payloadDigest,
    authorityBindingDigest: identity.authorityBindingDigest,
    requestDigest: identity.requestDigest,
    createdAt: (request.now ?? new Date()).toISOString()
  };
  await fs.mkdir(path.dirname(files.intentFile), { recursive: true });
  try {
    await fs.writeFile(files.intentFile, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { decision: "EXECUTE_ONCE", intent };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readJson<ActionIntentV1>(files.intentFile);
    if (!raced) throw new Error("TOOL_ACTION_INTENT_CORRUPT: concurrent intent could not be read.");
    assertStoredIntent(raced);
    if (raced.requestDigest !== identity.requestDigest) throw new Error("TOOL_ACTION_INTENT_CONFLICT: action key was concurrently claimed with a different request.");
    const receipt = await readJson<ActionReceiptV1>(files.receiptFile);
    if (receipt) {
      assertStoredReceipt(receipt, raced);
      return { decision: "ALREADY_COMPLETED", intent: raced, receipt };
    }
    throw new Error("TOOL_ACTION_RECONCILIATION_REQUIRED: a concurrent attempt claimed this action; reconcile before retrying.");
  }
}

/** Load and validate one persisted ActionIntent without authorizing a new action. */
export async function loadActionIntent(root: string, operationId: string, actionKey: string): Promise<ActionIntentV1 | undefined> {
  const files = actionFiles(root, operationId, actionKey);
  const intent = await readJson<ActionIntentV1>(files.intentFile);
  if (!intent) return undefined;
  assertStoredIntent(intent);
  return intent;
}

/** Load and validate one persisted ActionReceipt without authorizing a new action. */
export async function loadActionReceipt(root: string, operationId: string, actionKey: string): Promise<ActionReceiptV1 | undefined> {
  const files = actionFiles(root, operationId, actionKey);
  const intent = await readJson<ActionIntentV1>(files.intentFile);
  const receipt = await readJson<ActionReceiptV1>(files.receiptFile);
  if (!receipt) return undefined;
  if (!intent) throw new Error("TOOL_ACTION_RECEIPT_CORRUPT: receipt exists without its persisted intent.");
  assertStoredIntent(intent);
  assertStoredReceipt(receipt, intent);
  return receipt;
}

/** List current operation intents that have no durable or reconciled receipt. */
export async function listUnresolvedToolActionIntents(root: string, operationId: string): Promise<ActionIntentV1[]> {
  const operationKey = sha256Utf8(operationId).slice(0, 32);
  const directory = path.resolve(resolveOperationStateRoot(root), ".harness", "security", "tool-actions", operationKey);
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const unresolved: ActionIntentV1[] = [];
  for (const name of names.filter((item) => item.endsWith(".intent.json")).sort()) {
    const intent = await readJson<ActionIntentV1>(path.join(directory, name));
    if (!intent) throw new Error("TOOL_ACTION_INTENT_CORRUPT: action directory contains an unreadable intent.");
    assertStoredIntent(intent);
    if (intent.operationId !== operationId) throw new Error("TOOL_ACTION_INTENT_CORRUPT: action directory contains an intent for another operation.");
    const receipt = await readJson<ActionReceiptV1>(path.join(directory, name.replace(/\.intent\.json$/, ".receipt.json")));
    if (!receipt) unresolved.push(intent);
    else assertStoredReceipt(receipt, intent);
  }
  return unresolved;
}

/** Record the deterministic outcome after the caller has attempted the side effect. */
export async function recordToolActionReceipt(  root: string,
  intent: ActionIntentV1,
  outcome: ToolActionOutcomeV1,
  resultEvidence: unknown,
  now = new Date()
): Promise<ActionReceiptV1> {
  assertStoredIntent(intent);
  const current = currentOperationContext();
  if (!current.id || current.id !== intent.operationId) throw new Error("TOOL_ACTION_OPERATION_MISMATCH: a receipt must be recorded inside its matching managed operation context.");
  const files = actionFiles(root, intent.operationId, intent.actionKey);
  const operation = await loadOperation(resolveOperationStateRoot(root), intent.operationId);
  assertCurrentControllerOwner(operation, "tool action receipt");
  const currentPolicy = operation.resolvedOperationPolicy;
  if (!currentPolicy) throw new Error("TOOL_ACTION_POLICY_REQUIRED: action receipts require the current frozen ResolvedOperationPolicy.");
  assertResolvedOperationPolicyV1(currentPolicy);
  if (currentPolicy.digest !== intent.policyDigest || operation.operationExecutionRevision !== intent.operationExecutionRevision || currentControllerEpoch(operation) !== intent.controllerEpoch || !operation.candidateRevision || !candidateRevisionsEqual(operation.candidateRevision, intent.candidate)) {
    throw new Error("TOOL_ACTION_POLICY_STALE: action receipt no longer matches the current policy, candidate, execution revision, and epoch.");
  }
  const stored = await readJson<ActionIntentV1>(files.intentFile);
  if (!stored) throw new Error("TOOL_ACTION_INTENT_REQUIRED: cannot record a receipt without a persisted intent.");
  assertStoredIntent(stored);
  if (stored.intentId !== intent.intentId || stored.requestDigest !== intent.requestDigest) throw new Error("TOOL_ACTION_INTENT_MISMATCH: receipt does not match the persisted intent.");
  return persistActionReceipt(root, stored, outcome, resultEvidence, now);
}

/** Record observation-only reconciliation under a newly current controller epoch. */
export async function recordReconciledToolActionReceipt(root: string, intent: ActionIntentV1, outcome: ToolActionOutcomeV1, resultEvidence: unknown, now = new Date()): Promise<ActionReceiptV1> {
  assertStoredIntent(intent);
  const current = currentOperationContext();
  if (!current.id || current.id !== intent.operationId) throw new Error("TOOL_ACTION_OPERATION_MISMATCH: reconciliation must run inside its matching managed operation context.");
  const operation = await loadOperation(resolveOperationStateRoot(root), intent.operationId);
  assertCurrentControllerOwner(operation, "tool action reconciliation receipt");
  if (operation.status !== "RUNNING" || !operation.candidateRevision || !candidateRevisionsEqual(operation.candidateRevision, intent.candidate)) {
    throw new Error("TOOL_ACTION_RECONCILIATION_STALE: action reconciliation requires the active operation's same current candidate.");
  }
  if (!operation.resolvedOperationPolicy) throw new Error("TOOL_ACTION_POLICY_REQUIRED: action reconciliation requires the current frozen ResolvedOperationPolicy.");
  assertResolvedOperationPolicyV1(operation.resolvedOperationPolicy);
  if (operation.resolvedOperationPolicy.operationId !== operation.id
    || operation.resolvedOperationPolicy.operationExecutionRevision !== operation.operationExecutionRevision
    || operation.resolvedOperationPolicy.candidateRevision !== operation.candidateRevision.revision
    || operation.resolvedOperationPolicy.candidateDigest !== operation.candidateRevision.identityDigest
    || operation.resolvedOperationPolicy.controllerEpoch !== currentControllerEpoch(operation)
    || (operation.candidateRevision.projectId && operation.resolvedOperationPolicy.projectId !== operation.candidateRevision.projectId)) {
    throw new Error("TOOL_ACTION_POLICY_STALE: reconciliation policy does not match the current operation, candidate, execution revision, project, and epoch.");
  }
  const files = actionFiles(root, intent.operationId, intent.actionKey);
  const stored = await readJson<ActionIntentV1>(files.intentFile);
  if (!stored) throw new Error("TOOL_ACTION_INTENT_REQUIRED: cannot reconcile without a persisted ActionIntent.");
  assertStoredIntent(stored);
  if (stored.intentId !== intent.intentId || stored.requestDigest !== intent.requestDigest) throw new Error("TOOL_ACTION_INTENT_MISMATCH: reconciliation does not match the persisted intent.");
  return persistActionReceipt(root, stored, outcome, resultEvidence, now, currentControllerEpoch(operation));
}

async function persistActionReceipt(root: string, stored: ActionIntentV1, outcome: ToolActionOutcomeV1, resultEvidence: unknown, now: Date, reconciledUnderEpoch?: number): Promise<ActionReceiptV1> {
  const resultDigest = sha256Canonical(resultEvidence);
  const receiptIdentity = {
    version: 2 as const,
    intentId: stored.intentId,
    operationId: stored.operationId,
    participantId: stored.participantId,
    candidateDigest: stored.candidate.identityDigest,
    operationExecutionRevision: stored.operationExecutionRevision,
    policyDigest: stored.policyDigest,
    action: stored.action,
    controllerEpoch: stored.controllerEpoch,
    ...(reconciledUnderEpoch === undefined ? {} : { reconciledUnderEpoch }),
    outcome,
    resultDigest
  };
  const receiptDigest = sha256Canonical(receiptIdentity);
  const receipt: ActionReceiptV1 = { ...receiptIdentity, receiptId: `action-receipt:${receiptDigest}`, receiptDigest, recordedAt: now.toISOString() };
  const files = actionFiles(root, stored.operationId, stored.actionKey);
  try {
    await fs.writeFile(files.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = await readJson<ActionReceiptV1>(files.receiptFile);
    if (!prior) throw new Error("TOOL_ACTION_RECEIPT_CORRUPT: existing receipt could not be read.");
    assertStoredReceipt(prior, stored);
    if (prior.receiptDigest !== receiptDigest) throw new Error("TOOL_ACTION_RECEIPT_CONFLICT: intent already has a different outcome receipt.");
    return prior;
  }
}

async function assertCurrentActionAuthority(request: ToolActionRequestV1, impact: ToolActionImpactV1, operation: OperationRecordV2, policy: ResolvedOperationPolicyV1, consumeHumanDecision = true): Promise<void> {
  if (!request.operationId.trim() || !request.participantId.trim() || !request.actionKey.trim()) throw new Error("TOOL_ACTION_IDENTITY_REQUIRED: operation, participant, and action key are required.");
  assertCandidateRevisionV1(request.candidate);
  if (request.candidate.operationId !== request.operationId) throw new Error("TOOL_ACTION_CANDIDATE_MISMATCH: action candidate belongs to another operation.");

  const current = currentOperationContext();
  if (!current.id || current.id !== request.operationId) throw new Error("TOOL_ACTION_OPERATION_MISMATCH: action must run inside its matching managed operation context.");
  if (operation.status !== "RUNNING") throw new Error(`TOOL_ACTION_OPERATION_NOT_ACTIVE: operation status is ${operation.status}.`);
  if (!operation.candidateRevision || !candidateRevisionsEqual(operation.candidateRevision, request.candidate)) throw new Error("TOOL_ACTION_CANDIDATE_STALE: action is not bound to the current candidate revision.");

  const operationEpoch = currentControllerEpoch(operation);
  const evidence = request.authority;
  if (!evidence || typeof evidence !== "object") throw new Error("TOOL_ACTION_AUTHORITY_REQUIRED: blueprint or execution authority lease is required.");
  const controllerEvidence = evidence.kind === "controller-authority";
  if (!controllerEvidence) {
    if (!request.role || !isCanonicalRole(request.role)) throw new Error(`TOOL_ACTION_ROLE_UNREGISTERED: '${String(request.role)}' is not a canonical role.`);
    const profile = roleProfile(request.role);
    const leadBound = operation.lead?.agentId === request.participantId;
    const participant = operation.participants[request.participantId];
    if (leadBound) {
      if (request.role !== "Lead/Director") throw new Error("TOOL_ACTION_ROLE_MISMATCH: bound operation lead must use the Lead/Director role.");
      if (participant?.role && participant.role !== request.role) throw new Error("TOOL_ACTION_ROLE_MISMATCH: bound lead participant role does not match.");
    } else if (!participant || participant.role !== request.role) {
      throw new Error("TOOL_ACTION_PARTICIPANT_UNREGISTERED: participant is not registered with this canonical role.");
    }
    if (impact.startsWith("EXTERNAL_")) throw new Error("TOOL_ACTION_CONTROLLER_AUTHORITY_REQUIRED: participant role identity cannot authorize an external effect.");
    if (evidence.kind === "execution-authority") {
      assertExecutionAuthority(evidence.authority, request.now ?? new Date());
      const authority = evidence.authority;
      if (authority.controllerEpoch !== operationEpoch) throw new Error(`TOOL_ACTION_CONTROLLER_FENCED: execution authority was compiled under controller epoch ${authority.controllerEpoch}, but the operation is owned by controller epoch ${operationEpoch}.`);
      if (authority.operationId !== request.operationId || authority.participantId !== request.participantId || !candidateRevisionsEqual(authority.candidateRevision, request.candidate) || authority.candidateDigest !== request.candidate.identityDigest) {
        throw new Error("TOOL_ACTION_AUTHORITY_MISMATCH: execution authority is not bound to the operation, participant, and current candidate.");
      }
      if (impact === "LOCAL_REPOSITORY_MUTATION" && (!profile.authority.canWrite || !authority.leases.some((lease) => lease.capability === "write"))) {
        throw new Error("TOOL_ACTION_CAPABILITY_DENIED: local repository mutation requires the role's write ceiling and a write lease.");
      }
      if (impact === "LOCAL_RESOURCE_CREATION" && (!profile.authority.canExecute || !authority.leases.some((lease) => lease.capability === "execute"))) {
        throw new Error("TOOL_ACTION_CAPABILITY_DENIED: local resource creation requires the role's execute ceiling and an execute lease.");
      }
    } else if (evidence.kind === "execution-blueprint") {
      assertBlueprintBinding(evidence.blueprint, request, operationEpoch);
      if (evidence.blueprint.resolvedOperationPolicy.digest !== policy.digest) throw new Error("TOOL_ACTION_POLICY_STALE: participant blueprint does not bind the current frozen operation policy.");
      const assignment = evidence.blueprint.plan.assignments.find((item) => item.participantId === request.participantId)!;
      if (impact === "LOCAL_REPOSITORY_MUTATION" && (!profile.authority.canWrite || !hasTool(assignment.toolPack, "repository-write"))) {
        throw new Error("TOOL_ACTION_CAPABILITY_DENIED: blueprint does not grant this role repository-write authority.");
      }
      if (impact === "LOCAL_RESOURCE_CREATION" && (!profile.authority.canExecute || !hasTool(assignment.toolPack, "command-execute"))) {
        throw new Error("TOOL_ACTION_CAPABILITY_DENIED: blueprint does not grant this role command-execute authority.");
      }
    } else {
      throw new Error("TOOL_ACTION_AUTHORITY_INVALID: unsupported authority evidence kind.");
    }
    if (consumeHumanDecision) await consumeRequiredHumanDecision(request, operation, policy, operationEpoch);
    return;
  }

  // Deterministic controller authority: the fenced operation owner may perform
  // policy-authorized delivery effects and controller-owned local resources.
  // It is not a participant and never inherits a role ceiling.
  if (request.role !== undefined) throw new Error("TOOL_ACTION_ROLE_MISMATCH: controller authority must not claim a participant role.");
  if (request.participantId !== controllerActorId(request.operationId)) throw new Error("TOOL_ACTION_CONTROLLER_ACTOR_MISMATCH: controller authority requires the deterministic controller actor id.");
  if (evidence.operationId !== request.operationId) throw new Error("TOOL_ACTION_CONTROLLER_ACTOR_MISMATCH: controller authority belongs to another operation.");
  if (evidence.controllerEpoch !== operationEpoch) throw new Error(`TOOL_ACTION_CONTROLLER_FENCED: controller authority cites epoch ${evidence.controllerEpoch}, but the operation is owned by controller epoch ${operationEpoch}.`);
  assertCurrentControllerOwner(operation, "tool action authorization");
  if (impact.startsWith("EXTERNAL_") && !policy.allowedExternalEffects.includes(request.action)) {
    throw new Error(`TOOL_ACTION_POLICY_DENIED: frozen policy does not authorize external effect '${request.action}'.`);
  }
  if (consumeHumanDecision) await consumeRequiredHumanDecision(request, operation, policy, operationEpoch);
}

async function consumeRequiredHumanDecision(request: ToolActionRequestV1, operation: OperationRecordV2, policy: ResolvedOperationPolicyV1, operationEpoch: number): Promise<void> {
  const requirement: HumanDecisionRequirementV1 | undefined = policy.humanDecisionRequirements.find((item) => item.kind === "ACTION_AUTHORIZATION" && item.action === request.action);
  if (requirement) {
    const ledger = new HumanDecisionLedgerV2(path.resolve(resolveOperationStateRoot(request.root), ".harness", "security", "human-decisions.json"));
    try {
      const decision = await ledger.consume({
        operationId: operation.id,
        candidate: operation.candidateRevision!,
        operationExecutionRevision: operation.operationExecutionRevision!,
        policyDigest: policy.digest,
        controllerEpoch: operationEpoch
      }, { kind: "ACTION_AUTHORIZATION", action: request.action, effectDigest: sha256Canonical(request.payload) }, undefined, request.now ?? new Date());
      if (decision.kind !== "APPROVE") throw new Error("matching HumanDecision rejects this exact action and effect.");
    } catch (error) {
      throw new Error(`TOOL_ACTION_HUMAN_DECISION_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function currentResolvedPolicy(operation: OperationRecordV2, request: ToolActionRequestV1): ResolvedOperationPolicyV1 {
  if (!operation.resolvedOperationPolicy) throw new Error("TOOL_ACTION_POLICY_REQUIRED: sensitive actions require a frozen ResolvedOperationPolicy.");
  assertResolvedOperationPolicyV1(operation.resolvedOperationPolicy);
  const policy = operation.resolvedOperationPolicy;
  if (!operation.candidateRevision || !Number.isSafeInteger(operation.operationExecutionRevision)
    || policy.operationId !== operation.id
    || policy.operationExecutionRevision !== operation.operationExecutionRevision
    || policy.candidateRevision !== operation.candidateRevision.revision
    || policy.candidateDigest !== operation.candidateRevision.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(operation)
    || (operation.candidateRevision.projectId && policy.projectId !== operation.candidateRevision.projectId)
    || !candidateRevisionsEqual(operation.candidateRevision, request.candidate)) {
    throw new Error("TOOL_ACTION_POLICY_STALE: frozen policy does not bind the current operation, candidate, execution revision, project, and controller epoch.");
  }
  return policy;
}

function assertBlueprintBinding(blueprint: ExecutionBlueprint, request: ToolActionRequestV1, operationEpoch: number): void {
  if (!blueprint || !blueprint.candidate) throw new Error("TOOL_ACTION_BLUEPRINT_INVALID: blueprint is missing its current candidate binding.");
  assertExecutionBlueprintV2(blueprint);
  if (!Number.isSafeInteger(blueprint.controllerEpoch) || blueprint.controllerEpoch < 0) throw new Error("TOOL_ACTION_BLUEPRINT_INVALID: blueprint has no controller epoch.");
  if (blueprint.controllerEpoch !== operationEpoch) throw new Error(`TOOL_ACTION_CONTROLLER_FENCED: blueprint was compiled under controller epoch ${blueprint.controllerEpoch}, but the operation is owned by controller epoch ${operationEpoch}.`);
  if (blueprint.taskId !== request.candidate.taskId || blueprint.candidateRevision !== request.candidate.revision || !candidateRevisionsEqual(blueprint.candidate, request.candidate)) {
    throw new Error("TOOL_ACTION_BLUEPRINT_STALE: blueprint is not bound to the current candidate and task.");
  }
  const assignment = blueprint.plan.assignments.find((item) => item.participantId === request.participantId);
  if (!assignment || assignment.role !== request.role) throw new Error("TOOL_ACTION_BLUEPRINT_PARTICIPANT_MISMATCH: blueprint has no matching participant-role assignment.");
}

function hasTool(pack: { required: readonly string[]; optional: readonly string[] }, tool: string): boolean {
  return pack.required.includes(tool) || pack.optional.includes(tool);
}

function createActionIdentity(request: ToolActionRequestV1, policy: ResolvedOperationPolicyV1): Omit<ActionIntentV1, "createdAt"> {
  assertCandidateRevisionV1(request.candidate);
  if (!TOOL_ACTION_KINDS_V1.includes(request.action)) throw new Error(`TOOL_ACTION_KIND_INVALID: ${String(request.action)} is not registered.`);
  const impact = classifyToolActionImpact(request.action);
  const payloadDigest = sha256Canonical(request.payload);
  const authorityBindingDigest = authorityDigest(request.authority);
  const intentId = `action-intent:${sha256Canonical({ operationId: request.operationId, actionKey: request.actionKey })}`;
  const requestIdentity = {
    version: 2 as const,
    intentId,
    actionKey: request.actionKey,
    operationId: request.operationId,
    participantId: request.participantId,
    role: request.role,
    candidate: request.candidate,
    action: request.action,
    impact,
    operationExecutionRevision: policy.operationExecutionRevision,
    policyDigest: policy.digest,
    controllerEpoch: authorityEpoch(request.authority),
    payloadDigest,
    authorityBindingDigest
  };
  return { ...requestIdentity, requestDigest: sha256Canonical(requestIdentity) };
}

function authorityEpoch(evidence: ToolActionAuthorityEvidenceV1): number {
  if (evidence?.kind === "execution-authority") {
    const epoch = evidence.authority?.controllerEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("TOOL_ACTION_AUTHORITY_INVALID: execution authority has no controller epoch.");
    return epoch;
  }
  if (evidence?.kind === "execution-blueprint") {
    const epoch = evidence.blueprint?.controllerEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("TOOL_ACTION_BLUEPRINT_INVALID: blueprint has no controller epoch.");
    return epoch;
  }
  if (evidence?.kind === "controller-authority") {
    const epoch = evidence.controllerEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("TOOL_ACTION_AUTHORITY_INVALID: controller authority has no controller epoch.");
    return epoch;
  }
  throw new Error("TOOL_ACTION_AUTHORITY_REQUIRED: blueprint or execution authority lease is required.");
}

function authorityDigest(evidence: ToolActionAuthorityEvidenceV1): string {
  if (evidence?.kind === "execution-authority") {
    const authority = evidence.authority;
    return sha256Canonical({ kind: evidence.kind, version: authority.version, operationId: authority.operationId, participantId: authority.participantId, candidateDigest: authority.candidateDigest, controllerEpoch: authority.controllerEpoch, leases: authority.leases.map((lease) => ({ leaseId: lease.leaseId, capability: lease.capability, expiresAt: lease.expiresAt })).sort((a, b) => a.leaseId.localeCompare(b.leaseId)) });
  }
  if (evidence?.kind === "execution-blueprint") return sha256Canonical({ kind: evidence.kind, digest: evidence.blueprint?.digest });
  if (evidence?.kind === "controller-authority") return sha256Canonical({ kind: evidence.kind, operationId: evidence.operationId, controllerEpoch: evidence.controllerEpoch });
  throw new Error("TOOL_ACTION_AUTHORITY_REQUIRED: blueprint or execution authority lease is required.");
}

function assertStoredIntent(value: ActionIntentV1): void {
  if (!value || value.version !== 2 || !value.intentId || !value.actionKey || !value.operationId || !value.participantId || (value.role !== undefined && !isCanonicalRole(value.role)) || !TOOL_ACTION_KINDS_V1.includes(value.action) || value.impact !== classifyToolActionImpact(value.action) || !Number.isSafeInteger(value.controllerEpoch) || value.controllerEpoch < 0 || !Number.isSafeInteger(value.operationExecutionRevision) || value.operationExecutionRevision < 1 || !/^[a-f0-9]{64}$/.test(value.policyDigest)) {
    throw new Error("UNSUPPORTED_TOOL_ACTION_INTENT_VERSION: persisted ActionIntent is malformed or requires explicit migration.");
  }
  assertCandidateRevisionV1(value.candidate);
  const { createdAt: _createdAt, requestDigest, ...identity } = value;
  const expectedIntentId = `action-intent:${sha256Canonical({ operationId: value.operationId, actionKey: value.actionKey })}`;
  if (requestDigest !== sha256Canonical(identity) || value.intentId !== expectedIntentId || value.candidate.operationId !== value.operationId || !/^[a-f0-9]{64}$/.test(value.payloadDigest) || !/^[a-f0-9]{64}$/.test(value.authorityBindingDigest)) {
    throw new Error("TOOL_ACTION_INTENT_CORRUPT: persisted ActionIntent identity is inconsistent.");
  }
}

function assertStoredReceipt(value: ActionReceiptV1, intent: ActionIntentV1): void {
  if (!value || value.version !== 2 || value.intentId !== intent.intentId || value.operationId !== intent.operationId || value.participantId !== intent.participantId || value.candidateDigest !== intent.candidate.identityDigest || value.operationExecutionRevision !== intent.operationExecutionRevision || value.policyDigest !== intent.policyDigest || value.action !== intent.action || value.controllerEpoch !== intent.controllerEpoch || (value.reconciledUnderEpoch !== undefined && (!Number.isSafeInteger(value.reconciledUnderEpoch) || value.reconciledUnderEpoch < intent.controllerEpoch)) || !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.outcome)) {
    throw new Error("TOOL_ACTION_RECEIPT_CORRUPT: persisted ActionReceipt is malformed or not bound to its ActionIntent.");
  }
  const { receiptId: _receiptId, receiptDigest, recordedAt: _recordedAt, ...identity } = value;
  if (receiptDigest !== sha256Canonical(identity) || value.receiptId !== `action-receipt:${receiptDigest}`) throw new Error("TOOL_ACTION_RECEIPT_CORRUPT: persisted ActionReceipt identity is inconsistent.");
}

function actionFiles(root: string, operationId: string, actionKey: string): { intentFile: string; receiptFile: string } {
  const operationKey = sha256Utf8(operationId).slice(0, 32);
  const actionKeyDigest = sha256Canonical({ operationId, actionKey });
  const directory = path.resolve(resolveOperationStateRoot(root), ".harness", "security", "tool-actions", operationKey);
  const base = path.join(directory, `${actionKeyDigest}.json`);
  return { intentFile: base.replace(/\.json$/, ".intent.json"), receiptFile: base.replace(/\.json$/, ".receipt.json") };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`TOOL_ACTION_STATE_UNREADABLE: ${path.basename(file)}: ${String(error)}`);
  }
}
