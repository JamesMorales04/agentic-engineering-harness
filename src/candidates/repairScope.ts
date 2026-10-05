import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { sealTask } from "../core/seal.js";
import { validateAgentOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, WorkerSession } from "../core/types.js";
import { assertResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import {
  currentControllerEpoch,
  completeOperationProductChoice,
  loadOperation,
  markOperationProductChoiceConsumed,
  resolveOperationStateRoot,
  resumeOperationProductChoice,
  suspendOperationForProductChoice,
  type ProductChoiceRequestContentV1,
} from "../operations/state.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import {
  HumanDecisionLedgerV2,
  type DecisionChoiceV1,
  type HumanDecisionBindingV2,
  type HumanDecisionV2,
} from "../security/humanDecision.js";

/**
 * Out-of-scope-blocker → bounded-replan channel.
 *
 * Mechanism classification (decision-mechanism invariant):
 * - Blocker parsing/validation, amendment bounding, contract amendment,
 *   reseal and forbidden-scope filtering are DETERMINISTIC.
 * - Scope-amendment authority is HUMAN via the canonical HumanDecisionLedgerV2
 *   product-choice channel (suspendOperationForProductChoice +
 *   productChoiceForRequest with binding + consumeExact). A caller-supplied
 *   `{approved, decidedBy}` string alone NEVER authorizes an amendment; only a
 *   ledger-consumed CHOOSE decision with a matching operation/candidate/policy/
 *   epoch binding for the exact blocker paths authorizes
 *   applyRepairScopeAmendment. The deterministic controller applies the
 *   amendment, persists it, reseals, and retries exactly once.
 * - No model output selects tools, grants capability, or bypasses gates.
 */

export const REPAIR_SCOPE_BLOCKER_VERSION = 1 as const;
export const MAX_REPAIR_SCOPE_BLOCKER_FILES_V1 = 8;
export const MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1 = 1;

export interface RepairScopeNeededFileV1 {
  path: string;
  reason: string;
}

export interface RepairScopeBlockerReceiptV1 {
  version: 1;
  /** Deterministic mechanism marker: the receipt is controller-validated, never model authority. */
  mechanism: "DETERMINISTIC";
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId?: string;
  declaredAt: string;
  filesNeededOutsideScope: RepairScopeNeededFileV1[];
  digest: string;
}

export interface RepairScopeAmendmentV1 {
  version: 1;
  /** Deterministic mechanism marker: the controller applied a ledger-consumed human approval, never model authority. */
  mechanism: "DETERMINISTIC";
  operationId: string;
  taskId: string;
  blockerDigest: string;
  exemptedPaths: string[];
  decidedBy: "lead" | "human";
  decisionReason: string;
  decidedAt: string;
  /** Ledger provenance: the exact consumed HumanDecision that authorized this amendment. */
  decisionId: string;
  requestId: string;
  decidedActor: string;
  amendedScope: string[];
  contractPath: string;
  sealPath: string;
  amendmentPath: string;
  amendmentDigest: string;
}

/**
 * Canonical repair-scope product-choice IDs. The scope-amendment question is a
 * product choice over the exact blocker-declared paths: approve exactly those
 * paths (bounded amendment + reseal + single retry) or deny (BLOCKED stands).
 * Exact paths only; no wildcards, no expansion.
 */
export const REPAIR_SCOPE_APPROVE_CHOICE_ID = "approve-exact-paths" as const;
export const REPAIR_SCOPE_DENY_CHOICE_ID = "deny-scope-expansion" as const;

/**
 * Ledger-gated authorization for a scope amendment. A caller-supplied
 * approved/decidedBy string alone is never sufficient; only this
 * ledger-consumed decision with a matching binding authorizes
 * applyRepairScopeAmendment.
 */
export interface RepairScopeLedgerAuthorizationV1 {
  /** The ledger-consumed CHOOSE decision (kind CHOOSE, PRODUCT_CHOICE purpose). */
  decision: HumanDecisionV2;
  /** The current operation/candidate/policy/epoch binding the decision was consumed under. */
  binding: HumanDecisionBindingV2;
  /** The suspend-created product-choice request ID the decision answers. */
  requestId: string;
}

const neededFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1_000),
}).strict();

const blockerReceiptBodySchema = z.object({
  version: z.literal(1),
  mechanism: z.literal("DETERMINISTIC"),
  operationId: z.string().min(1),
  taskId: z.string().min(1),
  workUnitId: z.string().min(1),
  participantId: z.string().min(1).optional(),
  declaredAt: z.string().min(1),
  filesNeededOutsideScope: z.array(neededFileSchema).min(1).max(MAX_REPAIR_SCOPE_BLOCKER_FILES_V1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function isSafeRepairScopePath(value: string): boolean {
  if (!value || !value.trim() || value !== value.trim()) return false;
  if (value.includes("\0")) return false;
  if (path.isAbsolute(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return true;
}

export function normalizeRepairScopePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * DETERMINISTIC parse of the Repairer `repair-result` no-mutation report.
 * Returns the declared needed files when stdout/stderr carries a schema-valid
 * `repair-result` payload with a non-empty `filesNeededOutsideScope`, else
 * undefined. Never throws for absent/invalid markers; the caller decides the
 * typed outcome. Model content, deterministic validation.
 */
export function parseRepairScopeBlockerFromSession(session: Pick<WorkerSession, "stdout" | "stderr">): RepairScopeNeededFileV1[] | undefined {
  const marker = extractMarkedRepairResult(session.stdout, session.stderr ?? "");
  if (!marker) return undefined;
  const validation = validateAgentOutput("repair-result", marker);
  if (!validation.ok) return undefined;
  const value = validation.value as { filesChanged?: string[]; filesNeededOutsideScope?: RepairScopeNeededFileV1[] };
  const needed = value.filesNeededOutsideScope ?? [];
  if (!needed.length) return undefined;
  // The output-contract schema already enforces no-mutation (filesChanged empty
  // when needed files are declared); re-check here so a forged payload that
  // bypassed schema registration cannot slip through.
  if ((value.filesChanged ?? []).length > 0) return undefined;
  const normalized: RepairScopeNeededFileV1[] = [];
  for (const entry of needed) {
    if (typeof entry?.path !== "string" || typeof entry?.reason !== "string") return undefined;
    const filePath = normalizeRepairScopePath(entry.path.trim());
    const reason = entry.reason.trim();
    if (!filePath || !reason || !isSafeRepairScopePath(filePath)) return undefined;
    if (reason.length > 1_000) return undefined;
    normalized.push({ path: filePath, reason });
  }
  if (!normalized.length || normalized.length > MAX_REPAIR_SCOPE_BLOCKER_FILES_V1) return undefined;
  // Dedupe by path, locale-sort for determinism.
  const byPath = new Map<string, RepairScopeNeededFileV1>();
  for (const entry of normalized) {
    const existing = byPath.get(entry.path);
    if (!existing || entry.reason.length > existing.reason.length) byPath.set(entry.path, entry);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function repairScopeBlockerDigest(blocker: Omit<RepairScopeBlockerReceiptV1, "digest">): string {
  return sha256Canonical(blocker);
}

export function createRepairScopeBlockerReceipt(input: {
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId?: string;
  declaredAt?: string;
  filesNeededOutsideScope: RepairScopeNeededFileV1[];
}): RepairScopeBlockerReceiptV1 {
  const files = [...input.filesNeededOutsideScope]
    .map((entry) => ({ path: normalizeRepairScopePath(entry.path.trim()), reason: entry.reason.trim() }))
    .filter((entry) => entry.path && entry.reason && isSafeRepairScopePath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!input.operationId.trim() || !input.taskId.trim() || !input.workUnitId.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope blocker requires operation, task, and work-unit identity.");
  }
  if (!files.length || files.length > MAX_REPAIR_SCOPE_BLOCKER_FILES_V1) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `Repair scope blocker requires 1-${MAX_REPAIR_SCOPE_BLOCKER_FILES_V1} needed files with per-file reasons.`);
  }
  const body = {
    version: REPAIR_SCOPE_BLOCKER_VERSION,
    mechanism: "DETERMINISTIC" as const,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    declaredAt: input.declaredAt ?? new Date().toISOString(),
    filesNeededOutsideScope: files,
  };
  return { ...body, digest: sha256Canonical(body) };
}

export function assertRepairScopeBlockerReceipt(value: unknown): asserts value is RepairScopeBlockerReceiptV1 {
  const parsed = blockerReceiptBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `REPAIR_SCOPE_BLOCKER_INVALID: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "blocker"}: ${issue.message}`).join("; ")}`);
  }
  const { digest, ...body } = parsed.data;
  if (sha256Canonical(body) !== digest) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_BLOCKER_INVALID: Repair scope blocker digest does not match its typed claims.");
  }
}

/**
 * DETERMINISTIC projection of a blocker receipt into a validation check.
 * Status is FAIL (fail-closed) with the needed files cited; the controller
 * treats this as the BLOCKED outcome until a lead-approved amendment reseals.
 */
export function repairScopeBlockerValidationCheck(blocker: RepairScopeBlockerReceiptV1): ValidationCheck {
  assertRepairScopeBlockerReceipt(blocker);
  const files = blocker.filesNeededOutsideScope.map((entry) => entry.path).join(", ");
  return {
    id: "repair.scope-blocker",
    category: "frozen-scope",
    status: "FAIL",
    message: `Repair blocked: required fix needs out-of-scope file(s): ${files}. Declare via filesNeededOutsideScope; do not expand scope without a lead-approved amendment.`,
    details: {
      mechanism: "DETERMINISTIC",
      operationId: blocker.operationId,
      taskId: blocker.taskId,
      workUnitId: blocker.workUnitId,
      filesNeededOutsideScope: blocker.filesNeededOutsideScope,
      blockerDigest: blocker.digest,
    },
  };
}

export function repairScopeBlockerReceiptPath(root: string, config: HarnessProjectConfig, taskId: string): string {
  const dir = path.join(root, config.sdd?.repairsDir ?? ".harness/repairs");
  return path.join(dir, `${safe(taskId)}-scope-blocker.json`);
}

export async function writeRepairScopeBlockerReceipt(
  root: string,
  config: HarnessProjectConfig,
  blocker: RepairScopeBlockerReceiptV1,
): Promise<string> {
  assertRepairScopeBlockerReceipt(blocker);
  const file = repairScopeBlockerReceiptPath(root, config, blocker.taskId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(blocker, null, 2)}\n`);
  return file;
}

export function repairScopeAmendmentPath(root: string, taskId: string, index = 1): string {
  return path.join(root, ".harness", "seals", `${safe(taskId)}-scope-amendment-${index}.json`);
}

export async function listRepairScopeAmendments(
  root: string,
  _config: HarnessProjectConfig,
  taskId: string,
): Promise<RepairScopeAmendmentV1[]> {
  const found: RepairScopeAmendmentV1[] = [];
  for (let index = 1; index <= MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1 + 1; index += 1) {
    const file = repairScopeAmendmentPath(root, taskId, index);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as RepairScopeAmendmentV1;
      assertRepairScopeAmendment(raw);
      found.push(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return found.sort((a, b) => a.amendmentPath.localeCompare(b.amendmentPath));
}

export function assertRepairScopeAmendment(value: unknown): asserts value is RepairScopeAmendmentV1 {
  if (!value || typeof value !== "object") throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope amendment is not an object.");
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || record["mechanism"] !== "DETERMINISTIC") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope amendment requires version 1 with DETERMINISTIC mechanism.");
  }
  if (typeof record["operationId"] !== "string" || !record["operationId"].trim()) throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment operationId is required.");
  if (typeof record["taskId"] !== "string" || !record["taskId"].trim()) throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment taskId is required.");
  if (!Array.isArray(record["exemptedPaths"]) || record["exemptedPaths"].length === 0) throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment exemptedPaths must be non-empty.");
  for (const entry of record["exemptedPaths"] as unknown[]) {
    if (typeof entry !== "string" || !isSafeRepairScopePath(normalizeRepairScopePath(entry))) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment exempted path '${String(entry)}' is not a safe repository-relative path.`);
    }
  }
  if (record["decidedBy"] !== "lead" && record["decidedBy"] !== "human") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment decidedBy must be lead or human.");
  }
  // Ledger provenance: every amendment must cite the exact consumed HumanDecision.
  if (typeof record["decisionId"] !== "string" || !/^decision:[0-9a-f-]{36}$/i.test(record["decisionId"])) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment decisionId must be the consumed HumanDecision id.");
  }
  if (typeof record["requestId"] !== "string" || !record["requestId"].startsWith("request:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment requestId must be the suspend-created product-choice request id.");
  }
  if (typeof record["decidedActor"] !== "string" || !record["decidedActor"].startsWith("human:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment decidedActor must be the ledger human authority.");
  }
  const { amendmentDigest, ...body } = record as unknown as RepairScopeAmendmentV1 & { amendmentDigest: string };
  if (typeof amendmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(amendmentDigest)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment digest is malformed.");
  }
  if (sha256Canonical(body) !== amendmentDigest) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope amendment digest does not match its typed claims.");
  }
}

/**
 * DETERMINISTIC controller-owned bounded replan gate (ledger-gated).
 *
 * - Max 1 amendment per task (fail-closed when exhausted).
 * - ONLY a ledger-consumed HumanDecisionV2 (kind CHOOSE, PRODUCT_CHOICE purpose,
 *   choiceId `approve-exact-paths`, matching operation/candidate/policy/epoch
 *   binding, one-time consumeExact receipt) authorizes an amendment. A
 *   caller-supplied `{approved, decidedBy}` string alone NEVER authorizes; that
 *   self-label path was deleted. A deny choice returns BLOCKED (fail closed,
 *   citing the blocker); any missing/invalid/stale provenance throws fail-closed.
 * - The amendment adds exactly the blocker-declared paths to the TaskContract
 *   scope allowlist, persists the amended contract YAML, persists a durable
 *   amendment artifact (seal trail citing the exact ledger decision), and
 *   deterministically reseals via `sealTask`. No auto-allow, no silent
 *   expansion, no model authority. Exact paths only.
 */
export async function applyRepairScopeAmendment(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  blocker: RepairScopeBlockerReceiptV1;
  authorization: RepairScopeLedgerAuthorizationV1;
  ledger: HumanDecisionLedgerV2;
}): Promise<
  | { status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1 }
  | { status: "BLOCKED"; blocker: RepairScopeBlockerReceiptV1; check: ValidationCheck }
> {
  const { root, config, contract, blocker, authorization, ledger } = input;
  assertRepairScopeBlockerReceipt(blocker);
  if (blocker.taskId !== contract.task.id) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Blocker task does not match the contract being amended.");
  }
  const { decision, binding, requestId } = authorization;
  // Fail-closed provenance gate: every field must match the ledger record.
  if (!decision || typeof decision !== "object" || decision.version !== 2) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_INVALID: a ledger HumanDecisionV2 is required; a caller-supplied decidedBy string never authorizes.");
  }
  if (decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_PURPOSE_MISMATCH: scope amendment requires a CHOOSE product-choice HumanDecision.");
  }
  if (decision.purpose.requestId !== requestId) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_REQUEST_MISMATCH: ledger decision does not answer this suspend-created request.");
  }
  if (!sameRepairScopeBinding(decision, binding)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_BINDING_STALE: ledger decision does not match the current operation, candidate, policy, execution revision, or controller epoch.");
  }
  if (binding.operationId !== blocker.operationId) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_OPERATION_MISMATCH: ledger binding does not match the blocker operation.");
  }
  if (!decision.actorId.startsWith("human:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_ACTOR_INVALID: only a ledger human authority may authorize a scope amendment.");
  }
  if (!decision.reason.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_REASON_REQUIRED: a scope amendment decision requires a non-empty reason.");
  }
  // The deny choice is an explicit human refusal: BLOCKED stands, no amendment.
  if (decision.purpose.choiceId === REPAIR_SCOPE_DENY_CHOICE_ID) {
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker) };
  }
  if (decision.purpose.choiceId !== REPAIR_SCOPE_APPROVE_CHOICE_ID) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `REPAIR_SCOPE_DECISION_CHOICE_INVALID: '${decision.purpose.choiceId}' is not a bounded repair-scope option.`);
  }
  // Durable-receipt gate: the decision must already be one-time consumed under
  // the exact binding+purpose+actor. A missing receipt means no authority.
  const receipt = await ledger.consumedExact(binding, decision.purpose, decision.decisionId, decision.actorId);
  if (!receipt) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_UNCONSUMED: the ledger HumanDecision has no exact one-time consumption receipt; the BLOCKED outcome stands.");
  }
  const existing = await listRepairScopeAmendments(root, config, contract.task.id);
  if (existing.length >= MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1) {
    throw new AehError(
      "PARTICIPANT_PLAN_BUDGET_EXCEEDED",
      `Only ${MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1} repair scope amendment(s) per task are permitted; the BLOCKED outcome stands.`,
      { details: { taskId: contract.task.id, blockerDigest: blocker.digest } },
    );
  }
  const exemptedPaths = [...new Set(blocker.filesNeededOutsideScope.map((entry) => normalizeRepairScopePath(entry.path)))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (!exemptedPaths.length || exemptedPaths.length > MAX_REPAIR_SCOPE_BLOCKER_FILES_V1) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment exempted paths are outside the bounded blocker size.");
  }
  for (const filePath of exemptedPaths) {
    if (!isSafeRepairScopePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment path '${filePath}' is not a safe repository-relative path.`);
    }
  }
  const currentAllowed = contract.scope?.allowed ?? ["**"];
  const amendedScope = [...new Set([...currentAllowed, ...exemptedPaths])].sort((a, b) => a.localeCompare(b));
  const amendedContract: TaskContract = {
    ...contract,
    scope: { ...(contract.scope ?? {}), allowed: amendedScope },
  };
  const contractsDir = config.sdd?.contractsDir ?? ".harness/contracts";
  const contractPath = path.join(root, contractsDir, `${contract.task.id}.yaml`);
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(contractPath, YAML.stringify(amendedContract));

  const amendmentPath = repairScopeAmendmentPath(root, contract.task.id, existing.length + 1);
  const sealPath = path.join(root, ".harness", "seals", `${contract.task.id}.json`);
  const amendmentBody = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId: blocker.operationId,
    taskId: contract.task.id,
    blockerDigest: blocker.digest,
    exemptedPaths,
    decidedBy: "human" as const,
    decisionReason: decision.reason.trim(),
    decidedAt: decision.createdAt,
    decisionId: decision.decisionId,
    requestId,
    decidedActor: decision.actorId,
    amendedScope,
    contractPath: path.relative(root, contractPath).replaceAll("\\", "/"),
    sealPath: path.relative(root, sealPath).replaceAll("\\", "/"),
    amendmentPath: path.relative(root, amendmentPath).replaceAll("\\", "/"),
  };
  const amendment: RepairScopeAmendmentV1 = { ...amendmentBody, amendmentDigest: sha256Canonical(amendmentBody) };
  assertRepairScopeAmendment(amendment);
  await fs.mkdir(path.dirname(amendmentPath), { recursive: true });
  await fs.writeFile(amendmentPath, `${JSON.stringify(amendment, null, 2)}\n`);
  // Deterministic reseal against the amended contract; the seal trail (amendment
  // + seal) is the durable authority for the single retry.
  await sealTask(root, config, amendedContract);
  return { status: "AMENDED", contract: amendedContract, amendment };
}

/**
 * DETERMINISTIC repair-scope product choices over the exact blocker paths.
 * approve-exact-paths authorizes the bounded amendment (exact paths only);
 * deny-scope-expansion leaves BLOCKED standing. No wildcards, no expansion.
 */
export function repairScopeProductChoices(blocker: RepairScopeBlockerReceiptV1): DecisionChoiceV1[] {
  assertRepairScopeBlockerReceipt(blocker);
  const files = blocker.filesNeededOutsideScope.map((entry) => entry.path);
  const reasons = blocker.filesNeededOutsideScope.map((entry) => `${entry.path}: ${entry.reason}`);
  const fileList = files.join(", ");
  const description = `Amend the frozen TaskContract scope allowlist with exactly these blocker-declared file(s): ${fileList}. No other path is widened; the amendment persists, reseals, and retries once.`.slice(0, 2000);
  const consequences = [
    ...reasons.map((reason) => reason.slice(0, 1000)),
    "The amended contract is persisted and deterministically resealed; exactly one retry runs against the amended scope.",
    "All other protected paths remain denied; silent expansion still throws in the assembler.",
  ].slice(0, 8);
  return [
    {
      choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID,
      label: `Approve scope amendment for ${files.length} exact file(s)`,
      description,
      consequences,
    },
    {
      choiceId: REPAIR_SCOPE_DENY_CHOICE_ID,
      label: "Deny scope expansion",
      description: `Leave the frozen scope unchanged for ${fileList}. The BLOCKED outcome stands citing the blocker; no amendment, no reseal, no retry.`.slice(0, 2000),
      consequences: [
        "The repair BLOCKED outcome stands citing the exact needed files.",
        "No contract amendment is persisted and no retry runs against widened scope.",
      ],
    },
  ];
}

/**
 * DETERMINISTIC product-choice request content for a repair-scope blocker.
 * Exact files + per-file reasons are cited as choices/evidence; the blocker
 * receipt artifact is the authoritative evidence.
 */
export function repairScopeProductChoiceContent(
  blocker: RepairScopeBlockerReceiptV1,
  evidence: { artifact: string; sha256: string; description: string },
): ProductChoiceRequestContentV1 {
  assertRepairScopeBlockerReceipt(blocker);
  const files = blocker.filesNeededOutsideScope.map((entry) => entry.path).join(", ");
  return {
    issue: `Repair for task '${blocker.taskId}' needs out-of-scope file(s): ${files}. Approve a bounded scope amendment for exactly these files, or deny and leave BLOCKED standing.`.slice(0, 4000),
    authoritativeEvidence: [evidence],
    whatTried: [
      `The canonical Repairer returned no changes and declared filesNeededOutsideScope for ${files} with per-file reasons.`,
      "The deterministic controller verified every declared file is actually outside the frozen scope (or explicitly denied) and persisted the BLOCKED receipt.",
    ],
    whyUnresolvable: "Only a human product authority may widen the frozen task scope; the Repairer cannot expand scope itself and silent expansion is rejected.".slice(0, 4000),
    choices: repairScopeProductChoices(blocker),
    workThatCanContinue: ["Read-only diagnosis can continue; no implementation may touch the needed files until a ledger-approved amendment reseals."],
  };
}

function repairScopeLedger(controlRoot: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(controlRoot), ".harness", "security", "human-decisions.json"));
}

function repairScopeDecisionBinding(operation: {
  id: string;
  candidateRevision?: unknown;
  resolvedOperationPolicy?: unknown;
  operationExecutionRevision?: unknown;
  controller?: unknown;
}): HumanDecisionBindingV2 {
  const candidate = operation.candidateRevision as HumanDecisionBindingV2["candidate"] | undefined;
  const policy = operation.resolvedOperationPolicy as { digest: string } | undefined;
  if (!candidate || !policy || !Number.isSafeInteger(operation.operationExecutionRevision)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_AUTHORITY_REQUIRED: current candidate, operation revision, and policy are required.");
  }
  assertResolvedOperationPolicyV2(policy as never);
  const current = operation as Parameters<typeof currentControllerEpoch>[0];
  const epoch = currentControllerEpoch(current);
  return {
    operationId: operation.id,
    candidate,
    operationExecutionRevision: operation.operationExecutionRevision as number,
    policyDigest: (policy as { digest: string }).digest,
    controllerEpoch: epoch,
  };
}

function sameRepairScopeBinding(left: HumanDecisionBindingV2, right: HumanDecisionBindingV2): boolean {
  return left.operationId === right.operationId
    && candidateRevisionsEqual(left.candidate, right.candidate)
    && left.operationExecutionRevision === right.operationExecutionRevision
    && left.policyDigest === right.policyDigest
    && left.controllerEpoch === right.controllerEpoch;
}

function artifactForEvidence(controlRoot: string, absoluteFile: string): string {
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const relative = path.relative(stateRoot, absoluteFile).replaceAll("\\", "/");
  if (!relative.startsWith(".harness/")) throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_EVIDENCE_INVALID: blocker receipt must be an in-root .harness artifact.");
  return relative;
}

export interface RepairScopeSuspendedChoiceV1 {
  requestId: string;
  decisionRequest: unknown;
}

/**
 * Suspend the operation for a repair-scope product choice (canonical
 * HUMAN_REQUIRED channel). The exact blocker files + reasons become the
 * bounded approve/deny choices with the durable blocker receipt as
 * authoritative evidence. Fail-closed: suspend errors propagate (caller maps
 * to BLOCKED citing the blocker).
 */
export async function suspendRepairScopeForProductChoice(input: {
  controlRoot: string;
  operationId: string;
  config: HarnessProjectConfig;
  blocker: RepairScopeBlockerReceiptV1;
}): Promise<RepairScopeSuspendedChoiceV1> {
  const { controlRoot, operationId, config, blocker } = input;
  assertRepairScopeBlockerReceipt(blocker);
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const receiptFile = repairScopeBlockerReceiptPath(stateRoot, config, blocker.taskId);
  const content = await fs.readFile(receiptFile, "utf8").catch(() => undefined);
  if (!content) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_RECEIPT_MISSING: the durable blocker receipt must exist before a product-choice suspension.");
  }
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const artifact = artifactForEvidence(controlRoot, receiptFile);
  const suspended = await suspendOperationForProductChoice(controlRoot, operationId, repairScopeProductChoiceContent(blocker, {
    artifact,
    sha256,
    description: "Durable Repairer out-of-scope-blocker receipt declaring the exact needed files with per-file reasons.",
  }), {
    kind: "repair-scope",
    taskId: blocker.taskId,
    blockerDigest: blocker.digest,
    filesNeededOutsideScope: blocker.filesNeededOutsideScope,
  });
  const requestId = suspended.decisionRequest?.requestId;
  if (!requestId) throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_SUSPEND_INVALID: suspension produced no decision request.");
  return { requestId, decisionRequest: suspended.decisionRequest };
}

export interface RepairScopeChoiceSelectionV1 {
  requestId: string;
  decisionId: string;
  choiceId: string;
  choice: DecisionChoiceV1;
  reason: string;
  decision: HumanDecisionV2;
  binding: HumanDecisionBindingV2;
}

/**
 * Await the ledger-consumed repair-scope product choice (canonical
 * productChoiceForRequest + consumeExact pattern). On success the exact choice
 * is atomically consumed and the operation continuation is marked consumed.
 * On timeout the operation remains WAITING (human may still decide within
 * expiry); the caller maps timeout to BLOCKED citing the blocker (fail closed).
 * Operation-terminal or binding-stale conditions throw fail-closed.
 */
export async function awaitRepairScopeProductChoice(input: {
  controlRoot: string;
  operationId: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<RepairScopeChoiceSelectionV1> {
  const { controlRoot, operationId } = input;
  const timeoutMs = input.timeoutMs ?? Number.POSITIVE_INFINITY;
  const pollMs = input.pollMs ?? 250;
  const ledger = repairScopeLedger(controlRoot);
  const startedAt = Date.now();
  for (;;) {
    const current = await loadOperation(controlRoot, operationId);
    if (current.status !== "RUNNING") {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `REPAIR_SCOPE_CONTINUATION_STOPPED: operation is ${current.status}.`);
    }
    const continuation = current.continuation;
    const request = current.decisionRequest;
    if (!continuation || continuation.state !== "WAITING" || !request || current.phase !== "HUMAN_REQUIRED" || continuation.requestId !== request.requestId) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_CONTINUATION_STATE_INVALID: operation left the waiting repair-scope product-choice state.");
    }
    const binding = repairScopeDecisionBinding(current as never);
    if (Date.parse(request.expiresAt) <= Date.now()) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_REQUEST_EXPIRED: the repair-scope product-choice request has expired; the BLOCKED outcome stands.");
    }
    const allowedChoiceIds = request.choices.map((choice) => choice.choiceId);
    if (!allowedChoiceIds.includes(REPAIR_SCOPE_APPROVE_CHOICE_ID) || !allowedChoiceIds.includes(REPAIR_SCOPE_DENY_CHOICE_ID)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_REQUEST_CHOICE_INVALID: the waiting request is not the bounded repair-scope approve/deny choice.");
    }
    const decision = await ledger.productChoiceForRequest(request.requestId, binding, allowedChoiceIds);
    if (decision) {
      if (decision.purpose.kind !== "PRODUCT_CHOICE") {
        throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_PURPOSE_MISMATCH: repair-scope request resolved to another HumanDecision purpose.");
      }
      const decidedChoiceId: string = decision.purpose.choiceId;
      await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
      const consumed = await markOperationProductChoiceConsumed(controlRoot, operationId, {
        requestId: request.requestId,
        decisionId: decision.decisionId,
        choiceId: decidedChoiceId,
      });
      const choice = request.choices.find((item) => item.choiceId === decidedChoiceId);
      if (!choice || !consumed.continuation) {
        throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_DECISION_CHOICE_INVALID: consumed choice is absent from the current request.");
      }
      return {
        requestId: request.requestId,
        decisionId: decision.decisionId,
        choiceId: choice.choiceId,
        choice,
        reason: decision.reason,
        decision,
        binding,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_CHOICE_TIMEOUT: no ledger product choice was recorded in time; the BLOCKED outcome stands.", { details: { requestId: request.requestId } });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * High-level repair-scope blocker resolution for the run.ts validation-repair
 * loop (the single production amendment path; max 1/task preserved).
 *
 * - When an amendment already exists: BLOCKED without a second suspension.
 * - Otherwise suspends for the bounded approve/deny product choice, awaits the
 *   ledger-consumed decision, applies the amendment + reseal on approve
 *   (single retry owned by the caller), and resumes/completes the continuation.
 * - On deny: resumes/completes and returns BLOCKED citing the blocker.
 * - On timeout/expiry/terminal/stale (await throws): the operation remains
 *   WAITING when unanswered (human may still decide within expiry); the caller
 *   maps to BLOCKED citing the blocker (fail closed, no amendment, no retry).
 * - No unbounded loops: at most one suspension + one amendment per call, and
 *   apply enforces max 1/task.
 */
export async function resolveRepairScopeBlockerViaProductChoice(input: {
  root: string;
  controlRoot: string;
  operationId: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  blocker: RepairScopeBlockerReceiptV1;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<
  | { status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1; selection: RepairScopeChoiceSelectionV1 }
  | { status: "BLOCKED"; blocker: RepairScopeBlockerReceiptV1; check: ValidationCheck; choiceId?: string }
> {
  const { root, controlRoot, operationId, config, contract, blocker } = input;
  assertRepairScopeBlockerReceipt(blocker);
  const preexisting = await listRepairScopeAmendments(root, config, contract.task.id);
  if (preexisting.length >= MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1) {
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker) };
  }
  const suspended = await suspendRepairScopeForProductChoice({ controlRoot, operationId, config, blocker });
  void suspended;
  let selection: RepairScopeChoiceSelectionV1;
  try {
    selection = await awaitRepairScopeProductChoice({ controlRoot, operationId, timeoutMs: input.timeoutMs, pollMs: input.pollMs });
  } catch {
    // Unanswered (timeout), expired, terminal, or stale: BLOCKED stands. When
    // still WAITING the suspension remains for a human decision within expiry;
    // no amendment is applied and no retry runs.
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker) };
  }
  const ledger = repairScopeLedger(controlRoot);
  if (selection.choiceId === REPAIR_SCOPE_DENY_CHOICE_ID) {
    await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
    await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker), choiceId: selection.choiceId };
  }
  const applied = await applyRepairScopeAmendment({
    root,
    config,
    contract,
    blocker,
    authorization: { decision: selection.decision, binding: selection.binding, requestId: selection.requestId },
    ledger,
  });
  await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
  await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
  if (applied.status !== "AMENDED") {
    return { status: "BLOCKED", blocker, check: applied.check, choiceId: selection.choiceId };
  }
  return { status: "AMENDED", contract: applied.contract, amendment: applied.amendment, selection };
}

/**
 * DETERMINISTIC forbidden-scope projection for an amended retry.
 * Removes exactly the amendment-exempted paths (plus their `/**` variants)
 * from the effective forbidden list. The default-deny source
 * (`repairProtectedPaths`) is unchanged; this only applies the durable
 * lead-approved exemption for the single retry. All other protected paths
 * remain denied and silent expansion still throws in the assembler.
 */
export function filterForbiddenScopeForAmendment(
  forbiddenScope: readonly string[],
  amendment: RepairScopeAmendmentV1,
): string[] {
  assertRepairScopeAmendment(amendment);
  const exempted = new Set<string>();
  for (const filePath of amendment.exemptedPaths) {
    exempted.add(filePath);
    exempted.add(`${filePath}/**`);
  }
  return forbiddenScope.filter((entry) => !exempted.has(entry));
}

function extractMarkedRepairResult(stdout: string, stderr: string): unknown | undefined {
  const sources = [stdout, stderr];
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const text = sources[index] ?? "";
    const lines = text.split(/\r?\n/);
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      const trimmed = lines[line]?.trim() ?? "";
      const prefix = "AEH_RESULT_JSON=";
      if (!trimmed.startsWith(prefix)) continue;
      const raw = trimmed.slice(prefix.length).trim();
      if (!raw) continue;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
    }
  }
  // Fallback: a bare JSON object payload (no marker) is also accepted when it
  // schema-validates as repair-result; anything else is ignored (no blocker).
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const text = (sources[index] ?? "").trim();
    if (!text.startsWith("{") || !text.endsWith("}")) continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function safe(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
