import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { sealTask } from "../core/seal.js";
import { validateAgentOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, WorkerSession } from "../core/types.js";

/**
 * Out-of-scope-blocker → bounded-replan channel.
 *
 * Mechanism classification (decision-mechanism invariant):
 * - Blocker parsing/validation, amendment bounding, contract amendment,
 *   reseal and forbidden-scope filtering are DETERMINISTIC.
 * - Lead approval is the authority gate: a MODEL (lead semantic acceptance)
 *   or HUMAN decision supplies only the approval boolean + reason; it cannot
 *   widen scope itself. The deterministic controller applies the amendment,
 *   persists it, reseals, and retries exactly once.
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

export interface RepairScopeAmendmentDecisionV1 {
  approved: boolean;
  /** Only `lead` or `human` can approve. Any other value (including a worker role) fails closed. */
  decidedBy: string;
  reason: string;
  decidedAt?: string;
}

export interface RepairScopeAmendmentV1 {
  version: 1;
  /** Deterministic mechanism marker: the controller applied a lead/human approval, never model authority. */
  mechanism: "DETERMINISTIC";
  operationId: string;
  taskId: string;
  blockerDigest: string;
  exemptedPaths: string[];
  decidedBy: "lead" | "human";
  decisionReason: string;
  decidedAt: string;
  amendedScope: string[];
  contractPath: string;
  sealPath: string;
  amendmentPath: string;
  amendmentDigest: string;
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
  const { amendmentDigest, ...body } = record as unknown as RepairScopeAmendmentV1 & { amendmentDigest: string };
  if (typeof amendmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(amendmentDigest)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment digest is malformed.");
  }
  if (sha256Canonical(body) !== amendmentDigest) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope amendment digest does not match its typed claims.");
  }
}

/**
 * DETERMINISTIC controller-owned bounded replan gate.
 *
 * - Max 1 amendment per task (fail-closed when exhausted).
 * - Only an explicit lead/human approval applies an amendment; any other
 *   decidedBy (including worker roles) or approved=false returns BLOCKED.
 * - The amendment adds exactly the blocker-declared paths to the TaskContract
 *   scope allowlist, persists the amended contract YAML, persists a durable
 *   amendment artifact (seal trail), and deterministically reseals via
 *   `sealTask`. No auto-allow, no silent expansion, no model authority.
 */
export async function applyRepairScopeAmendment(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  blocker: RepairScopeBlockerReceiptV1;
  decision: RepairScopeAmendmentDecisionV1;
}): Promise<
  | { status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1 }
  | { status: "BLOCKED"; blocker: RepairScopeBlockerReceiptV1; check: ValidationCheck }
> {
  const { root, config, contract, blocker, decision } = input;
  assertRepairScopeBlockerReceipt(blocker);
  if (blocker.taskId !== contract.task.id) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Blocker task does not match the contract being amended.");
  }
  if (!decision.reason.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "A scope amendment decision requires a non-empty reason.");
  }
  const approvedByAuthority = decision.approved && (decision.decidedBy === "lead" || decision.decidedBy === "human");
  if (!approvedByAuthority) {
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker) };
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

  const decidedAt = decision.decidedAt ?? new Date().toISOString();
  const amendmentPath = repairScopeAmendmentPath(root, contract.task.id, existing.length + 1);
  const sealPath = path.join(root, ".harness", "seals", `${contract.task.id}.json`);
  const amendmentBody = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId: blocker.operationId,
    taskId: contract.task.id,
    blockerDigest: blocker.digest,
    exemptedPaths,
    decidedBy: decision.decidedBy as "lead" | "human",
    decisionReason: decision.reason.trim(),
    decidedAt,
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
