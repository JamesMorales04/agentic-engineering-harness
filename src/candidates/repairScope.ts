import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { minimatch } from "minimatch";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { sealTask } from "../core/seal.js";
import { extractMarkedJson, StructuredOutputError } from "../agents/structuredOutput.js";
import { validateAgentOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, WorkerSession } from "../core/types.js";
import { assertResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import {
  currentControllerEpoch,
  completeOperationProductChoice,
  controllerTokenFromEnvironment,
  isTerminalOperation,
  loadOperation,
  markOperationProductChoiceConsumed,
  resolveOperationStateRoot,
  resumeOperationProductChoice,
  suspendOperationForProductChoice,
  updateOperationMetadata,
  type OperationRecordV2,
  type ProductChoiceRequestContentV1,
} from "../operations/state.js";
import { isManagedBoundedAgent } from "../operations/executionContext.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import {
  HumanDecisionLedgerV2,
  assertDecisionV2,
  type DecisionChoiceV1,
  type HumanDecisionBindingV2,
  type HumanDecisionV2,
} from "../security/humanDecision.js";
import {
  assertOwnerHardProtectionExemptionGrant,
  computeOwnerExemptionMac,
  isOwnerExemptionLineageDescendant,
  ownerExemptionStablePolicyDigest,
  verifyOwnerExemptionMac,
  type OwnerHardProtectionExemptionGrantV1,
} from "../security/ownerExemption.js";

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
/**
 * Bounded amendment-discovery window: the scan probes at most this many
 * amendment candidates. Derived from existing bounds (per-task cap + blocker
 * file cap); any unaccountable state beyond it fails closed.
 */
export const REPAIR_SCOPE_AMENDMENT_SCAN_CAP_V1 =
  MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1 + MAX_REPAIR_SCOPE_BLOCKER_FILES_V1;

/**
 * Amendable scope denials: dependency manifests that a ledger-approved
 * amendment may exempt for a single retry. Everything else in the
 * default-deny protected set is HARD-protected (never exemptible).
 */
export const REPAIR_AMENDABLE_MANIFEST_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/**
 * DETERMINISTIC hard-protected paths (never exemptible): frozen TaskContract,
 * seal, validators, acceptance/spec files, and policy paths. A blocker
 * intersecting any of these is rejected as BLOCKED citing non-exemptible
 * with no suspend/approve path. Dependency manifests (see
 * REPAIR_AMENDABLE_MANIFEST_PATHS) are the amendable subset of the
 * default-deny set.
 */
export function repairHardProtectedPaths(
  config: HarnessProjectConfig,
  contract: TaskContract,
): string[] {
  const paths = new Set<string>([
    `${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`,
    `.harness/seals/${contract.task.id}.json`,
    ".harness/project.yaml",
    "tests",
    "test",
    "specs",
    "acceptance",
    "features",
    "src/validators",
    ...(contract.scope?.frozen ?? []),
    ...(config.validation?.frozenPaths ?? []),
    ...configuredValidatorSourcePathsForScope(config, contract),
    ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)),
    ...(contract.issue?.snapshotPath ? [contract.issue.snapshotPath] : []),
    ...(config.agents?.configPath ? [config.agents.configPath] : []),
    ...(config.agents?.generatedPath ? [config.agents.generatedPath] : []),
    ...(config.toolchain?.configPath ? [config.toolchain.configPath] : []),
    ...(config.toolchain?.lockPath ? [config.toolchain.lockPath] : []),
    ...(config.validation?.opa?.policyDirs ?? []),
    ...(config.organization?.policyBundles?.cacheDir ? [config.organization.policyBundles.cacheDir] : []),
    ...(config.controlPlane?.include ?? []),
  ]);
  return expandRepairScopePatterns(paths);
}

function expandRepairScopePatterns(paths: Set<string> | Iterable<string>): string[] {
  const normalized = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string" || hasUnsafeRawRepairScopeInput(raw)) continue;
    const value = normalizeRepairScopePath(raw);
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) continue;
    normalized.add(value);
    normalized.add(`${value}/**`);
  }
  return [...normalized].sort();
}

function configuredValidatorSourcePathsForScope(
  config: HarnessProjectConfig,
  contract: TaskContract,
): string[] {
  const commands = [
    ...(config.validation?.commands ?? []),
    ...(config.validation?.validators ?? []),
    ...(config.validation?.providers ?? []),
    ...(contract.verification?.commands ?? []),
    ...(contract.verification?.validators ?? []),
  ];
  const references = new Set<string>();
  const sourceArgument =
    /(?:^|[\s"'=])((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:[cm]?[jt]sx?|py|sh|bash|ps1|rb|pl|rego|feature|json|ya?ml|toml))(?=$|[\s"'#])/g;
  for (const command of commands) {
    if (!command.command) continue;
    sourceArgument.lastIndex = 0;
    for (const match of command.command.matchAll(sourceArgument)) {
      const value = match[1];
      if (!value || path.posix.isAbsolute(value)) continue;
      const reference = path.posix.normalize(path.posix.join(command.workingDirectory ?? ".", value)).replace(/^\.\//, "");
      if (reference !== ".." && !reference.startsWith("../")) references.add(reference);
    }
  }
  return [...references];
}

function matchesAnyHardProtectedPattern(file: string, patterns: readonly string[]): boolean {
  const normalizedFile = normalizeRepairScopePath(file);
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRepairScopePath(pattern);
    // Preserve the exact `**` open pattern through normalization.
    if (normalizedPattern === "**" || pattern === "**") return true;
    return minimatch(normalizedFile, normalizedPattern, { dot: true });
  });
}

/**
 * DETERMINISTIC hard-protection gate: returns the subset of `paths` that
 * intersect HARD-protected patterns (exact or `/**` variants). Empty means
 * amendable (or already allowed); non-empty means non-exemptible.
 */
export function findRepairHardProtectedViolations(
  paths: readonly string[],
  config: HarnessProjectConfig,
  contract: TaskContract,
): string[] {
  const hard = repairHardProtectedPaths(config, contract);
  return paths
    .map((filePath) => normalizeRepairScopePath(filePath.trim()))
    .filter((filePath) => filePath && matchesAnyHardProtectedPattern(filePath, hard));
}

/**
 * Warn-only protected-grant overlap detection for capsule/operation-intake
 * scope construction (`--file` values becoming capsule `scope.allowed`).
 *
 * MECHANISM: DETERMINISTIC glob-overlap heuristic (no model judgment, no
 * filesystem). A granted `allowed` pattern that COULD match HARD-protected
 * content (frozen TaskContract, seal, validators, acceptance/spec, policy —
 * see repairHardProtectedPaths) is accepted silently today but can NEVER take
 * effect: forbidden wins over allowed at every assembly gate
 * (partitionRepairScopeBlockerFiles denies + effectiveRepairScope keeps hard
 * paths forbidden without a verified Owner exemption), so the grantor learns
 * this only at terminal escape. Warn-only: matching/assembly semantics are
 * untouched (fail-closed preserved); a grantor seeing the warning can fix
 * scope or seek an Owner exemption BEFORE burning an op.
 *
 * Heuristic (conservative: warn on exact/parent/child/glob-overlap):
 * - `**` on either side overlaps everything.
 * - Exact equality of normalized patterns overlaps.
 * - Literal-base parent/child overlaps: the glob-free prefix before the first
 *   magic char (`*?[]{}!()+@`, same set as isExplicitGlobScope) is equal or
 *   one side is a `/`-bounded prefix of the other (e.g. granted `src`
 *   contains hard `src/validators`; granted `src/validators/foo.ts` lies
 *   under hard `src/validators`). Empty bases (pattern starts with magic,
 *   e.g. `*.json`, `**\/*.ts`) skip this check and rely on the probes below.
 * - Glob overlap: representative concrete probes synthesized from each side
 *   (the literal base itself plus `<base>/__aeh_probe__` with several
 *   extensions, so extension-specific globs like `**\/*.ts` are caught) are
 *   matched with minimatch (dot:true) against the other side's pattern in
 *   BOTH directions. Any hit means some path could match both patterns.
 *
 * Unsafe raw inputs (`..`, absolute, drive prefix) are skipped silently (no
 * warning): they are rejected fail-closed elsewhere, and overlap advice for
 * them would be wrong. Mirrors the ScopeDirectoryPatternWarningV1 family.
 */
export interface ScopeProtectedGrantWarningV1 {
  raw: string;
  normalized: string;
  matchedHardPaths: string[];
}

const SCOPE_PROTECTED_GRANT_PROBE_NAMES = [
  "__aeh_probe__",
  "__aeh_probe__.ts",
  "__aeh_probe__.json",
  "__aeh_probe__.txt",
] as const;

function literalScopeBase(pattern: string): string {
  const index = pattern.search(/[*?[\]{}!()+@]/);
  if (index === -1) return pattern;
  return pattern.slice(0, index).replace(/\/+$/, "");
}

function concreteProbesForScopePattern(normalized: string, base: string): string[] {
  if (normalized !== "**" && !/[*?[\]{}!()+@]/.test(normalized)) return [normalized];
  if (!base) return [...SCOPE_PROTECTED_GRANT_PROBE_NAMES];
  return [base, ...SCOPE_PROTECTED_GRANT_PROBE_NAMES.map((name) => `${base}/${name}`)];
}

/** DETERMINISTIC conservative overlap check between one granted pattern and one hard-protected pattern. */
export function scopePatternOverlapsHardPattern(allowedPattern: string, hardPattern: string): boolean {
  const allowed = normalizeRepairScopePath(allowedPattern.trim());
  const hard = normalizeRepairScopePath(typeof hardPattern === "string" ? hardPattern.trim() : "");
  if (!allowed || !hard) return false;
  if (allowed === "**" || hard === "**") return true;
  if (allowed === hard) return true;
  const allowedBase = literalScopeBase(allowed);
  const hardBase = literalScopeBase(hard);
  if (allowedBase && hardBase) {
    if (allowedBase === hardBase) return true;
    if (allowedBase.startsWith(`${hardBase}/`) || hardBase.startsWith(`${allowedBase}/`)) return true;
  }
  try {
    for (const probe of concreteProbesForScopePattern(allowed, allowedBase)) {
      if (minimatch(probe, hard, { dot: true })) return true;
    }
    for (const probe of concreteProbesForScopePattern(hard, hardBase)) {
      if (minimatch(probe, allowed, { dot: true })) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * DETERMINISTIC warn-only scan: for every granted `allowed` pattern, collect
 * the HARD-protected patterns it could match. Pure (no filesystem, no config
 * beyond the caller-supplied hard list, typically from
 * repairHardProtectedPaths); never throws for malformed entries (they are
 * skipped so the warning can never block intake).
 */
export function findScopeProtectedGrantWarnings(
  allowed: readonly string[],
  hardProtected: readonly string[],
): ScopeProtectedGrantWarningV1[] {
  const hard = [...new Set(
    hardProtected
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeRepairScopePath(entry.trim()))
      .filter((entry) => entry && !path.isAbsolute(entry) && !entry.split("/").includes("..")),
  )].sort();
  if (!hard.length) return [];
  const warnings: ScopeProtectedGrantWarningV1[] = [];
  for (const raw of allowed) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (hasUnsafeRawRepairScopeInput(trimmed)) continue;
    const normalized = normalizeRepairScopePath(trimmed);
    if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) continue;
    const matched = hard.filter((entry) => scopePatternOverlapsHardPattern(normalized, entry));
    if (matched.length) warnings.push({ raw, normalized, matchedHardPaths: matched });
  }
  return warnings;
}

/** LOUD single-line CLI diagnostic for a HARD-protected scope grant. */
export function formatScopeProtectedGrantWarning(warning: ScopeProtectedGrantWarningV1): string {
  const shown = warning.matchedHardPaths.slice(0, 8).join(", ");
  const extra = warning.matchedHardPaths.length > 8 ? ` (+${warning.matchedHardPaths.length - 8} more)` : "";
  return (
    `SCOPE_PROTECTED_GRANT_WARNING: scope pattern '${warning.raw}' (normalized '${warning.normalized}') could match HARD-protected path(s): ${shown}${extra}. ` +
    `Forbidden wins over allowed at every assembly gate, so this grant can NEVER take effect without a bounded Owner exemption. ` +
    `Fix scope or seek Owner exemption BEFORE burning an op. Scope is NOT broadened (fail-closed preserved).`
  );
}

/**
 * DETERMINISTIC BLOCKED check for hard-protected paths without an anchored
 * owner grant (declined, expired, or timed-out suspend/decide/resume).
 * Cites the exact hard-protected files; the BLOCKED outcome stands.
 */
export function repairScopeNonExemptibleValidationCheck(
  blocker: RepairScopeBlockerReceiptV1,
  hardPaths: readonly string[],
): ValidationCheck {
  assertRepairScopeBlockerReceipt(blocker);
  const files = [...new Set(hardPaths)].sort((a, b) => a.localeCompare(b)).join(", ");
  return {
    id: "repair.scope-blocker",
    category: "frozen-scope",
    status: "FAIL",
    message: `Repair blocked: required fix needs hard-protected file(s): ${files}. Frozen TaskContract, seal, validators, acceptance/spec, and policy paths require a bounded owner-approved suspension; with no anchored covering grant (declined, expired, or timed out) the BLOCKED outcome stands.`,
    details: {
      mechanism: "DETERMINISTIC",
      operationId: blocker.operationId,
      taskId: blocker.taskId,
      workUnitId: blocker.workUnitId,
      filesNeededOutsideScope: blocker.filesNeededOutsideScope,
      blockerDigest: blocker.digest,
      nonExemptiblePaths: [...new Set(hardPaths)].sort((a, b) => a.localeCompare(b)),
    },
  };
}

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
  /**
   * Owner-exemption provenance: present ONLY when a verified owner-scoped
   * hard-protection grant authorized hard paths in this amendment. `requestId`
   * then cites the exemption (`exemption:<uuid>`) instead of a suspend-created
   * product-choice request. Every use of a grant is traced here (exemption id,
   * ledger decision id + digest); the grant itself is operation-bound and dies
   * with the operation terminal state.
   */
  ownerExemption?: {
    exemptionId: string;
    decisionId: string;
    decisionDigest: string;
  };
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

/**
 * DETERMINISTIC raw-input traversal gate (Luna traversal-hiding fix).
 * Returns true when the RAW scope string hides traversal that
 * posix-normalize would resolve away (e.g. `src/../.harness/seals/U2.json`
 * -> `.harness/seals/U2.json`). Rejects any `..` segment, drive prefix, or
 * absolute form in the raw input BEFORE normalization. Called by
 * `isSafeRepairScopePath` and by pattern-expansion deny sources so hidden
 * traversal never becomes a 'safe' relative path.
 */
function hasUnsafeRawRepairScopeInput(value: string): boolean {
  const slashedRaw = value.replaceAll("\\", "/");
  if (path.isAbsolute(value) || path.posix.isAbsolute(slashedRaw) || path.win32.isAbsolute(value)) return true;
  if (slashedRaw.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(value) || /^[A-Za-z]:/.test(slashedRaw)) return true;
  if (slashedRaw.split("/").includes("..")) return true;
  return false;
}

export function isSafeRepairScopePath(value: string): boolean {
  if (!value || !value.trim() || value !== value.trim()) return false;
  if (value.includes("\0")) return false;
  if (path.isAbsolute(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  // Raw-input traversal rejection BEFORE normalization: even a resolvable
  // `..` (e.g. `src/../.harness/seals/U2.json`) or drive/absolute form
  // rejects here so normalization cannot hide it as a safe relative path.
  if (hasUnsafeRawRepairScopeInput(value)) return false;
  const normalized = normalizeRepairScopePath(value);
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return true;
}

/**
 * DETERMINISTIC exact-file gate (C-NEW-2): scope-amendment and blocker paths
 * must be exact files — glob metacharacters (`*?[]{}!()+@`) and trailing
 * `/**` (including bare `**`) are rejected. Mirrors `isExplicitGlobScope`
 * (architecture/workGraph.ts) inverted; kept local so the candidates layer
 * does not depend on the architecture layer. `isSafeRepairScopePath` alone
 * accepts `src/**`/`**` (it only rejects traversal/absolute/drive/NUL
 * forms), so every amendment/blocker entry point must also pass this gate —
 * otherwise one entry (`src/**`, `**`) exempts unlimited files and
 * `filterForbiddenScopeForAmendment` strips subtree denies.
 */
export function isExactRepairScopeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === "**" || trimmed.endsWith("/**")) return false;
  return !/[*?[\]{}!()+@]/.test(trimmed);
}

export function normalizeRepairScopePath(value: string): string {
  // DETERMINISTIC single scope-string identity (C4): posix separators, collapse
  // redundant `//`, `./`, and resolvable `../`, strip a single leading `./`,
  // strip trailing `/` (except root `/`). Preserves `**` globs (`src/**`
  // stays `src/**`; `**` stays `**`). Empty/`.` maps to `""` (rejected by
  // isSafe). All scope gates (hard-protected expansion, violation search,
  // blocker parse, amendment filter, diffScope, run assembly) must route
  // through this function so `./src//a.ts`, `src/./a.ts`, and `src/a/../b.ts`
  // share one identity (`src/a.ts` / `src/b.ts`). Fail-closed: unresolvable
  // `..` (e.g. `a/../../b` -> `../b`) is preserved for isSafe to reject.
  const slashed = value.replaceAll("\\", "/");
  let normalized: string;
  try {
    normalized = path.posix.normalize(slashed);
  } catch {
    normalized = slashed;
  }
  if (normalized === "." || normalized === "./") return "";
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * DETERMINISTIC parse of the Implementer / Repairer no-mutation report
 * (H-NEW-1 canonical extractor, H-NEW-7 strip-and-trace preserved).
 * Returns the declared needed files when stdout/stderr carries a schema-valid
 * `repair-result` OR `implementer` payload with a non-empty
 * `filesNeededOutsideScope`, else undefined. The Implementer role declares via
 * its own `implementer` output contract (filesChanged + behaviorImplemented +
 * filesNeededOutsideScope); the Repairer declares via `repair-result`. Both
 * share the same no-mutation invariant and normalization.
 * Throws REPAIR_SCOPE_BLOCKER_CONFLICT fail-closed when a
 * schema-valid (or zod-flagged) payload declares needed files AND file changes
 * (the no-mutation invariant); conflict is never swallowed as undefined.
 * Throws REPAIR_SCOPE_BLOCKER_INVALID fail-closed when a marker is observed
 * but its payload is not valid JSON (MARKER_INVALID_JSON / NATIVE_JSON_INVALID
 * via the canonical extractor); truncation is never swallowed as undefined.
 * Returns undefined ONLY for absent markers (EMPTY_OUTPUT / NO_MARKER) or for
 * schema-valid payloads with no needed files.
 * Model content, deterministic validation.
 */
export function parseRepairScopeBlockerFromSession(session: Pick<WorkerSession, "stdout" | "stderr">): RepairScopeNeededFileV1[] | undefined {
  const marker = extractMarkedRepairResult(session.stdout, session.stderr ?? "");
  if (!marker) return undefined;
  const repairValidation = validateAgentOutput("repair-result", marker);
  if (repairValidation.ok) {
    const value = repairValidation.value as { filesChanged?: string[]; filesNeededOutsideScope?: RepairScopeNeededFileV1[] };
    const needed = value.filesNeededOutsideScope ?? [];
    if (needed.length) {
      // The output-contract schema already enforces no-mutation (filesChanged empty
      // when needed files are declared); re-check here so a forged payload that
      // bypassed schema registration cannot slip through. Fail closed with a
      // distinct conflict diagnostic instead of undefined.
      if ((value.filesChanged ?? []).length > 0) {
        throw new AehError(
          "PARTICIPANT_PLAN_INVALID",
          "REPAIR_SCOPE_BLOCKER_CONFLICT: filesNeededOutsideScope is a no-mutation report path; filesChanged must be empty when needed files are declared.",
        );
      }
      const parsed = normalizeBlockerEntries(needed);
      if (parsed) return parsed;
      // A repair-valid payload with invalid entries falls through to the
      // implementer attempt only when it could be an implementer shape;
      // otherwise its normalization outcome (undefined vs throw) stands.
      // Repair-valid + needed non-empty + normalization undefined means
      // invalid entries (traversal etc.) — return undefined to preserve
      // H-NEW-1/H-NEW-7 behavior (traversal is ignored, globs throw inside).
      return undefined;
    }
    // Repair-valid with no needed files: may still be an implementer-shaped
    // payload that coincidentally validates as repair (generic fields only)?
    // Fall through to the implementer attempt; a genuine implementer blocker
    // carries behaviorImplemented and fails repair strict validation, so this
    // path only matters for ambiguous payloads.
  } else {
    // Distinct conflict diagnostic: zod already enforces no-mutation via
    // superRefine, so a REPAIR_SCOPE_BLOCKER_CONFLICT issue means the payload
    // is a forged/conflicting report, not an absent marker. Fail closed
    // instead of returning undefined (which callers treat as "no blocker").
    if (repairValidation.issues.some((issue) => issue.includes("REPAIR_SCOPE_BLOCKER_CONFLICT"))) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        "REPAIR_SCOPE_BLOCKER_CONFLICT: filesNeededOutsideScope is a no-mutation report path; filesChanged must be empty when needed files are declared.",
      );
    }
  }
  const implementerValidation = validateAgentOutput("implementer", marker);
  if (!implementerValidation.ok) {
    if (implementerValidation.issues.some((issue) => issue.includes("REPAIR_SCOPE_BLOCKER_CONFLICT"))) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        "REPAIR_SCOPE_BLOCKER_CONFLICT: filesNeededOutsideScope is a no-mutation report path; filesChanged must be empty when needed files are declared.",
      );
    }
    return undefined;
  }
  const implValue = implementerValidation.value as { filesChanged?: string[]; filesNeededOutsideScope?: RepairScopeNeededFileV1[] };
  const implNeeded = implValue.filesNeededOutsideScope ?? [];
  if (!implNeeded.length) return undefined;
  if ((implValue.filesChanged ?? []).length > 0) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      "REPAIR_SCOPE_BLOCKER_CONFLICT: filesNeededOutsideScope is a no-mutation report path; filesChanged must be empty when needed files are declared.",
    );
  }
  return normalizeBlockerEntries(implNeeded);
}

function normalizeBlockerEntries(needed: RepairScopeNeededFileV1[]): RepairScopeNeededFileV1[] | undefined {
  const normalized: RepairScopeNeededFileV1[] = [];
  for (const entry of needed) {
    if (typeof entry?.path !== "string" || typeof entry?.reason !== "string") return undefined;
    const rawPath = entry.path.trim();
    // Raw traversal gate BEFORE normalization so `src/../...` cannot hide
    // as a safe relative path; normalize only the raw-safe remainder.
    if (!isSafeRepairScopePath(rawPath)) return undefined;
    // Exact-paths gate (C-NEW-2): globs are an explicit scope-expansion
    // attempt, never a silently ignorable declaration — fail closed with a
    // distinct diagnostic instead of returning undefined ("no blocker").
    if (!isExactRepairScopeFilePath(rawPath)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_BLOCKER_INVALID: blocker path '${rawPath}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`,
      );
    }
    const filePath = normalizeRepairScopePath(rawPath);
    const reason = entry.reason.trim();
    if (!filePath || !reason || !isSafeRepairScopePath(filePath)) return undefined;
    if (!isExactRepairScopeFilePath(filePath)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_BLOCKER_INVALID: blocker path '${filePath}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`,
      );
    }
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
  // Exact-paths gate (C-NEW-2): reject globs fail-closed BEFORE the
  // safe-path filter so a glob entry can never be silently filtered into an
  // empty list (size error) or, worse, pass through as an exemptible path.
  for (const entry of input.filesNeededOutsideScope) {
    const raw = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (raw && isSafeRepairScopePath(raw) && !isExactRepairScopeFilePath(raw)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_BLOCKER_INVALID: blocker path '${raw}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`,
      );
    }
  }
  const files = [...input.filesNeededOutsideScope]
    .filter((entry) => typeof entry?.path === "string" && isSafeRepairScopePath(entry.path.trim()))
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

export function repairScopeBlockerReceiptPath(root: string, config: HarnessProjectConfig, taskId: string, workUnitId: string): string {
  // SINGLE canonical durable root (RECEIPT_MISSING fix): cross-phase repair
  // artifacts must resolve IDENTICALLY at write and read. The correction-turn
  // write passes runTask controlRoot (= executionRoot/isolated worktree) while
  // the suspend read resolves via resolveOperationStateRoot(controlRoot) (=
  // durable AEH_CONTROL_ROOT when AEH_OPERATION_STATE_REDIRECT=1). Resolving
  // here converges both sites to the durable root; without a redirect the
  // resolve is the identity, so behavior is unchanged when roots agree.
  // NAMESPACED by workUnitId (H-NEW-11 R1): planner (`planner:<taskId>`) and
  // repairer (`wu-*`, `direct:*`, `*:escape-correction`) receipts for the same
  // task MUST NOT share one taskId-derived file — the second write overwrites
  // the first and suspend reads the wrong digest. Filename is
  // `<safe(taskId)>-scope-blocker-<safe(workUnitId)>.json`. EVERY producer
  // (write) and consumer (suspend reads) derives via this single function —
  // no duplication, no backward-compat dual-read (repo invariant: update all
  // sites + tests, stale single-file paths fail with RECEIPT_MISSING).
  if (!taskId.trim() || !workUnitId.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repair scope blocker receipt requires task and work-unit identity for namespaced derivation.");
  }
  const stateRoot = resolveOperationStateRoot(root);
  const dir = path.join(stateRoot, config.sdd?.repairsDir ?? ".harness/repairs");
  return path.join(dir, `${safe(taskId)}-scope-blocker-${safe(workUnitId)}.json`);
}

export async function writeRepairScopeBlockerReceipt(
  root: string,
  config: HarnessProjectConfig,
  blocker: RepairScopeBlockerReceiptV1,
): Promise<string> {
  assertRepairScopeBlockerReceipt(blocker);
  const file = repairScopeBlockerReceiptPath(root, config, blocker.taskId, blocker.workUnitId);
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
  // Gap-tolerant discovery (DETERMINISTIC): amendment files are numbered
  // densely by the write path, but a missing lower index (deleted or never
  // written) must not hide a higher-numbered amendment and bypass the
  // per-task limit. Discover candidates by directory listing instead of
  // stopping at the first ENOENT. The probe count stays capped at
  // REPAIR_SCOPE_AMENDMENT_SCAN_CAP_V1 and any unaccountable state (a
  // non-numeric amendment-like file, or more candidates than the window
  // holds) fails closed — admission never proceeds on a truncated scan.
  const dir = path.join(root, ".harness", "seals");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = `${safe(taskId)}-scope-amendment-`;
  const indices: number[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const numeral = entry.slice(prefix.length, -".json".length);
    if (!/^[1-9]\d*$/.test(numeral)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_AMENDMENT_SCAN_INVALID: unexpected scope amendment file '${entry}' is not a numbered amendment; failing closed — the BLOCKED outcome stands.`,
      );
    }
    indices.push(Number(numeral));
  }
  indices.sort((a, b) => a - b);
  if (indices.length > REPAIR_SCOPE_AMENDMENT_SCAN_CAP_V1) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      "REPAIR_SCOPE_AMENDMENT_SCAN_TRUNCATED: scope amendment candidates exceed the bounded scan window; failing closed — the BLOCKED outcome stands.",
    );
  }
  const found: RepairScopeAmendmentV1[] = [];
  for (const index of indices) {
    const raw = JSON.parse(await fs.readFile(repairScopeAmendmentPath(root, taskId, index), "utf8")) as RepairScopeAmendmentV1;
    assertRepairScopeAmendment(raw);
    found.push(raw);
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
    if (typeof entry !== "string" || !isSafeRepairScopePath(entry)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment exempted path '${String(entry)}' is not a safe repository-relative path.`);
    }
    // Exact-paths gate (C-NEW-2): the product choice is over exact
    // blocker-declared paths — a glob entry (e.g. `src/**`, `**`) would
    // exempt unlimited files via filterForbiddenScopeForAmendment.
    if (!isExactRepairScopeFilePath(entry) || !isExactRepairScopeFilePath(normalizeRepairScopePath(entry))) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment exempted path '${String(entry)}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`);
    }
    if (!isSafeRepairScopePath(normalizeRepairScopePath(entry))) {
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
  if (typeof record["requestId"] !== "string" || (!record["requestId"].startsWith("request:") && !record["requestId"].startsWith("exemption:"))) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment requestId must be the suspend-created product-choice request id or, for owner-exempted amendments, the exemption id.");
  }
  if (record["ownerExemption"] !== undefined) {
    const provenance = record["ownerExemption"] as Record<string, unknown>;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment ownerExemption provenance must be an object.");
    }
    const provenanceKeys = Object.keys(provenance).sort();
    if (provenanceKeys.join(",") !== "decisionDigest,decisionId,exemptionId") {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment ownerExemption provenance must cite exactly exemptionId, decisionId, and decisionDigest.");
    }
    if (typeof provenance["exemptionId"] !== "string" || !/^exemption:[0-9a-f-]{36}$/i.test(provenance["exemptionId"])
      || record["requestId"] !== provenance["exemptionId"]) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment ownerExemption exemptionId must be 'exemption:<uuid>' and match the amendment requestId.");
    }
    if (typeof provenance["decisionId"] !== "string" || provenance["decisionId"] !== record["decisionId"]) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment ownerExemption decisionId must match the amendment decisionId.");
    }
    if (typeof provenance["decisionDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(provenance["decisionDigest"])) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "Amendment ownerExemption decisionDigest must be a lowercase SHA-256 digest.");
    }
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
    // Exact-paths defense-in-depth (C-NEW-2): exempted paths derive from the
    // blocker receipt, which may have bypassed create/parse gates when forged
    // directly — never widen on a glob here.
    if (!isExactRepairScopeFilePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment path '${filePath}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`);
    }
  }
  // HARD-protection gate (never exemptible): even a ledger-approved decision
  // cannot widen frozen TaskContract, seal, validators, acceptance/spec, or
  // policy paths. Fail closed before any persistence.
  const hardViolations = findRepairHardProtectedViolations(exemptedPaths, config, contract);
  if (hardViolations.length) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_AMENDMENT_NON_EXEMPTIBLE: exempted path(s) are never exemptible (frozen TaskContract, seal, validators, acceptance/spec, policy): ${hardViolations.join(", ")}.`,
    );
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
 * DETERMINISTIC full verification of an owner-scoped hard-protection
 * exemption for the exact needed paths (the authority gate; the sync filter
 * re-checks the MAC tier only). Every check fails closed:
 *
 * 1. operation is non-terminal (exemptions die with terminal state);
 * 2. grant operationId matches the live operation (no cross-operation replay;
 *    lineage root `candidate:<operationId>:rN` additionally never matches
 *    another operation);
 * 3. grant controllerEpoch matches the live epoch (no reuse after takeover;
 *    retained exact — post-epoch reuse refused);
 * 4. LINEAGE binding (H-NEW-12): the LIVE candidate IS the anchored revision
 *    or descends from it via the durable `parentCandidateId` +
 *    `candidateAssemblyReceipts` chain (`isOwnerExemptionLineageDescendant`),
 *    verified via the revision CHAIN, never by revision numbers alone
 *    (siblings sharing the parent but branching to a different child are NOT
 *    descendants and are refused);
 * 5. STABLE policy binding (H-NEW-12): `ownerExemptionStablePolicyDigest`
 *    of the LIVE policy equals the grant's `policyStableDigest`. Exact
 *    `policyDigest` matching is deleted because it can never survive normal
 *    progress — `operationExecutionRevision` (+ `candidateRevision`,
 *    `candidateDigest`, `controllerEpoch`) is compiled INTO the exact digest
 *    (`compileResolvedOperationPolicy`, executionIdentity.ts:206-225) and
 *    every candidate bind increments the execution revision and clears the
 *    policy (state.ts:687,776,780), forcing a recompile → new exact digest.
 *    Stable-config changes still kill the grant fail-closed;
 * 6. live-exact `operationExecutionRevision` matching is DROPPED (H-NEW-12):
 *    the anchored value stays MAC-bound for provenance + ledger-decision
 *    cross-check, but honor never compares it to LIVE. Safe because lineage
 *    roots scope to one op lineage, epoch kills takeovers, expiry bounds
 *    lifetime, and terminal kills the grant;
 * 7. grant MAC verifies under the LIVE controller token (forgery-proof: only
 *    the token-holding controller can mint; managed children never inherit it);
 * 8. grant (and ledger decision) unexpired;
 * 9. ledger cross-check: the cited consumed CHOOSE/PRODUCT_CHOICE
 *    approve-exact-paths decision exists, is one-time consumed under its
 *    exact ANCHORED binding+purpose+actor (approval binds its WAITING
 *    continuation at anchor time; the decision's candidate/policy/execution
 *    binding must equal the grant's ANCHORED identities, not LIVE —
 *    stale/recorded-but-unconsumed approvals cannot verify), matches the
 *    grant on decisionId/digest/actor/operation/anchored binding, and carries
 *    the suspend-created request that authorized this exact hard set (a
 *    model-minted or edited decision cannot match a MAC-bound digest plus
 *    its consumption receipt);
 * 10. every needed path is exactly covered by the grant (agent-declared need
 *    can only narrow human-authorized scope, never widen it).
 *
 * Consumption semantics: operation-scoped MULTI-amendment (bounded by exact
 * paths and the existing per-task amendment cap), non-transferable, never
 * one-time-consumed on the ledger. Justification: repair loops legitimately
 * need re-amendment (amend → retry → new blocker on another granted path);
 * forcing a fresh human round-trip per amendment within the same
 * operation+epoch+lineage+stable-policy+paths adds no security, while replay
 * across operations is impossible (operationId MAC-bound + lineage-root-checked),
 * takeover invalidates (epoch-checked), expiry bounds lifetime, stable-config
 * drift invalidates (stable-digest-checked), off-lineage candidates are
 * refused (lineage-checked), and terminal state kills the grant. Every use is
 * traced in the amendment artifact provenance.
 */
export async function verifyOwnerHardProtectionExemption(input: {
  operation: OperationRecordV2;
  neededPaths: readonly string[];
  grant: OwnerHardProtectionExemptionGrantV1;
  ledger: HumanDecisionLedgerV2;
  now?: Date;
}): Promise<OwnerHardProtectionExemptionGrantV1> {
  const { operation, neededPaths, grant, ledger } = input;
  const now = input.now ?? new Date();
  try {
    assertOwnerHardProtectionExemptionGrant(grant);
  } catch (error) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_GRANT_INVALID: stored grant is malformed: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (isTerminalOperation(operation.status)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: hard-protection exemptions die with the operation terminal state.");
  }
  if (grant.operationId !== operation.id) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_CROSS_OPERATION: grant '${grant.exemptionId}' is bound to another operation and is non-transferable.`);
  }
  if (grant.controllerEpoch !== currentControllerEpoch(operation)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_EPOCH_STALE: the grant does not match the current controller epoch (takeover invalidates prior grants).");
  }
  // Live-identity binding (H-NEW-12 LINEAGE + STABLE): the MAC body binds
  // the ANCHORED identities (`anchoredCandidateId` + `candidateRevision` +
  // `candidateIdentityDigest` + anchored exact `policyDigest` +
  // `operationExecutionRevision`) plus `policyStableDigest`. Honor requires:
  // (a) LIVE candidate IS the anchored revision or descends from it via the
  // parentCandidateId + assembly-receipts chain (never revision numbers
  // alone — siblings excluded); (b) LIVE stable policy digest equals the
  // grant's stable digest (exact digest matching deleted: operationExecution-
  // Revision + candidateRevision/Digest + controllerEpoch are compiled INTO
  // the exact digest per compileResolvedOperationPolicy, and every candidate
  // bind increments the execution revision and clears the policy, so exact
  // matching can never survive normal progress); (c) live-exact
  // operationExecutionRevision matching DROPPED (covered by lineage + epoch +
  // expiry + terminal; anchored value stays MAC-bound for provenance).
  const liveCandidate = operation.candidateRevision;
  const livePolicy = operation.resolvedOperationPolicy;
  if (!liveCandidate || !Number.isSafeInteger(liveCandidate.revision) || !liveCandidate.identityDigest
    || !liveCandidate.candidateId || !livePolicy || typeof livePolicy.digest !== "string"
    || !/^[a-f0-9]{64}$/.test(livePolicy.digest)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the live operation candidate or policy is unavailable; the grant cannot be honored.");
  }
  try {
    assertResolvedOperationPolicyV2(livePolicy);
  } catch {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the live operation policy is invalid; the grant cannot be honored.");
  }
  // Provenance-bound lineage (H-NEW-12 R2): the walk uses the
  // CONTROLLER-DURABLE receipts map from the controller-loaded operation
  // record as the chain of truth (see isOwnerExemptionLineageDescendant
  // source map). `operation` MUST be freshly loaded via `loadOperation` in
  // the same controller tick — a supplied receipt object alone is never
  // authority. Every hop is op-bound to `operation.id` and parent-linked to
  // the durable live candidate ancestry.
  if (!isOwnerExemptionLineageDescendant({
    liveCandidate,
    anchoredCandidateId: grant.anchoredCandidateId,
    anchoredRevision: grant.candidateRevision,
    anchoredIdentityDigest: grant.candidateIdentityDigest,
    expectedOperationId: operation.id,
    assemblies: operation.candidateAssemblyReceipts,
  })) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the live candidate is not the anchored revision nor its lineage descendant (same-epoch off-lineage advance invalidates prior grants; siblings excluded).");
  }
  let liveStableDigest: string;
  try {
    liveStableDigest = ownerExemptionStablePolicyDigest(livePolicy);
  } catch {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the live stable policy digest is unavailable; the grant cannot be honored.");
  }
  if (liveStableDigest !== grant.policyStableDigest) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: the live stable policy does not match the anchored grant (stable-config drift invalidates prior grants).");
  }
  if (!verifyOwnerExemptionMac(controllerTokenFromEnvironment(), grant)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_FORGED: grant MAC integrity check failed; the grant was not minted by the live controller.");
  }
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_EXPIRED: the hard-protection exemption has expired.");
  }
  const stored = await ledger.find(grant.decisionId);
  if (!stored) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_DECISION_MISMATCH: the anchored ledger HumanDecision no longer exists.");
  }
  const decision = assertDecisionV2(stored);
  // Ledger-decision cross-check (H-NEW-12): the decision must equal the
  // ANCHORED identities (not LIVE — LIVE already proved descendant + stable
  // above). The decision was minted at suspend time with the anchored
  // candidate + exact policy digest + execution revision; its one-time
  // consumption receipt below is looked up under that exact ANCHORED binding.
  if (decision.decisionId !== grant.decisionId
    || decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE"
    || decision.purpose.choiceId !== REPAIR_SCOPE_APPROVE_CHOICE_ID
    || decision.actorId !== grant.decidedActor
    || decision.operationId !== operation.id
    || decision.operationId !== grant.operationId
    || decision.candidate.operationId !== grant.operationId
    || decision.candidate.candidateId !== grant.anchoredCandidateId
    || decision.candidate.revision !== grant.candidateRevision
    || decision.candidate.identityDigest !== grant.candidateIdentityDigest
    || decision.policyDigest !== grant.policyDigest
    || decision.operationExecutionRevision !== grant.operationExecutionRevision
    || decision.controllerEpoch !== grant.controllerEpoch
    || sha256Canonical(decision) !== grant.decisionDigest) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_DECISION_MISMATCH: the ledger HumanDecision does not match the anchored exemption (consumed approve-exact-paths choice, actor, operation, anchored binding, or digest).");
  }
  // Approval binds continuation: the cited decision must have a one-time
  // consumption receipt under its exact binding+purpose+actor. Recorded-but-
  // unconsumed (or stale-binding) approvals verify nothing.
  const decisionBinding: HumanDecisionBindingV2 = {
    operationId: decision.operationId,
    candidate: decision.candidate,
    operationExecutionRevision: decision.operationExecutionRevision,
    policyDigest: decision.policyDigest,
    controllerEpoch: decision.controllerEpoch,
  };
  if (!await ledger.consumedExact(decisionBinding, decision.purpose, decision.decisionId, decision.actorId)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_DECISION_UNCONSUMED: the anchored HumanDecision has no exact one-time consumption receipt; stale approvals cannot authorize hard paths.");
  }
  if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= now.getTime()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_EXPIRED: the anchored HumanDecision has expired.");
  }
  if (!neededPaths.length) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_NOT_COVERED: no needed paths were presented for exemption coverage.");
  }
  const uncovered = neededPaths
    .map((filePath) => normalizeRepairScopePath(filePath.trim()))
    .filter((filePath) => !grant.paths.includes(filePath));
  if (uncovered.length) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `OWNER_EXEMPTION_NOT_COVERED: needed path(s) are outside the owner-exempted exact set: ${uncovered.join(", ")}.`,
    );
  }
  return grant;
}

/**
 * DETERMINISTIC covering-grant discovery: the first operation grant that
 * fully verifies for ALL needed paths. Partial coverage never partially
 * honors: a blocker needing any path outside every grant stays BLOCKED.
 */
export async function findCoveringOwnerHardProtectionExemption(input: {
  operation: OperationRecordV2;
  neededPaths: readonly string[];
  ledger: HumanDecisionLedgerV2;
  now?: Date;
}): Promise<{ grant?: OwnerHardProtectionExemptionGrantV1; failures: string[] }> {
  const failures: string[] = [];
  for (const grant of Object.values(input.operation.ownerExemptions ?? {})) {
    try {
      const verified = await verifyOwnerHardProtectionExemption({ ...input, grant });
      return { grant: verified, failures };
    } catch (error) {
      failures.push(`${grant?.exemptionId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }
  return { failures };
}

/**
 * DETERMINISTIC owner-exempted amendment application (the single
 * hard-path amendment path). Mirrors the persistence tail of
 * applyRepairScopeAmendment (per-task cap, contract allowlist persist,
 * durable artifact, deterministic reseal) but its authority is a fully
 * verified owner grant instead of a consumed product-choice decision.
 *
 * Anti-laundering rule: the blocker must need at least one HARD-protected
 * path. A blocker of only amendable manifests is refused here — those flow
 * through the product-choice approve/deny channel (with its explicit deny
 * option), never through the owner shortcut.
 */
export async function applyOwnerExemptedRepairScopeAmendment(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  blocker: RepairScopeBlockerReceiptV1;
  grant: OwnerHardProtectionExemptionGrantV1;
  ledger: HumanDecisionLedgerV2;
}): Promise<{ status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1 }> {
  const { root, config, contract, blocker, grant, ledger } = input;
  assertRepairScopeBlockerReceipt(blocker);
  if (blocker.taskId !== contract.task.id) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Blocker task does not match the contract being amended.");
  }
  const operation = await loadOperation(root, blocker.operationId);
  const verified = await verifyOwnerHardProtectionExemption({
    operation,
    neededPaths: blocker.filesNeededOutsideScope.map((entry) => entry.path),
    grant,
    ledger,
  });
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
    if (!isExactRepairScopeFilePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Amendment path '${filePath}' is not an exact file path; scope amendments allow exact paths only (no wildcards).`);
    }
  }
  const hardViolations = findRepairHardProtectedViolations(exemptedPaths, config, contract);
  if (!hardViolations.length) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      "OWNER_EXEMPTION_HARD_REQUIRED: the owner-exempted path authorizes hard-protected paths only; amendable manifests use the product-choice approve/deny channel.",
    );
  }
  const existing = await listRepairScopeAmendments(root, config, contract.task.id);
  if (existing.length >= MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1) {
    throw new AehError(
      "PARTICIPANT_PLAN_BUDGET_EXCEEDED",
      `Only ${MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1} repair scope amendment(s) per task are permitted; the BLOCKED outcome stands.`,
      { details: { taskId: contract.task.id, blockerDigest: blocker.digest } },
    );
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
    decisionReason: verified.decisionReason,
    decidedAt: verified.createdAt,
    decisionId: verified.decisionId,
    requestId: verified.exemptionId,
    decidedActor: verified.decidedActor,
    ownerExemption: {
      exemptionId: verified.exemptionId,
      decisionId: verified.decisionId,
      decisionDigest: verified.decisionDigest,
    },
    amendedScope,
    contractPath: path.relative(root, contractPath).replaceAll("\\", "/"),
    sealPath: path.relative(root, sealPath).replaceAll("\\", "/"),
    amendmentPath: path.relative(root, amendmentPath).replaceAll("\\", "/"),
  };
  const amendment: RepairScopeAmendmentV1 = { ...amendmentBody, amendmentDigest: sha256Canonical(amendmentBody) };
  assertRepairScopeAmendment(amendment);
  await fs.mkdir(path.dirname(amendmentPath), { recursive: true });
  await fs.writeFile(amendmentPath, `${JSON.stringify(amendment, null, 2)}\n`);
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

/**
 * DETERMINISTIC hard-path product-choice request content (suspend/decide/resume).
 * Bounded choices are generated deterministically from the declared hard
 * paths (approve-exact-set / decline via the shared approve-exact-paths /
 * deny-scope-expansion IDs); no agent input influences choices or paths.
 * The reason cites the blocker digest + hard paths; the blocker receipt
 * artifact is the authoritative evidence. Reuses the Spec-Manager
 * suspension/continuation/resume lifecycle (SPEC_AUTHORING / PRODUCT_CHOICE);
 * no new lifecycle is invented and the existing CC UI renders it.
 */
export function repairScopeHardProductChoiceContent(
  blocker: RepairScopeBlockerReceiptV1,
  evidence: { artifact: string; sha256: string; description: string },
  hardPaths: readonly string[],
): ProductChoiceRequestContentV1 {
  assertRepairScopeBlockerReceipt(blocker);
  const files = blocker.filesNeededOutsideScope.map((entry) => entry.path).join(", ");
  const hardList = [...new Set(hardPaths)].sort((a, b) => a.localeCompare(b)).join(", ");
  return {
    issue: `Repair for task '${blocker.taskId}' needs hard-protected file(s): ${files}. Hard paths [${hardList}] (blocker ${blocker.digest.slice(0, 12)}…) require owner approval. Approve a bounded owner-exempted amendment for exactly these blocker-declared files, or decline and leave BLOCKED standing.`.slice(0, 4000),
    authoritativeEvidence: [evidence],
    whatTried: [
      `The canonical Repairer returned no changes and declared filesNeededOutsideScope for ${files} with per-file reasons (blocker ${blocker.digest}).`,
      `The deterministic controller verified hard-protection violations for ${hardList} and persisted the BLOCKED receipt; no covering owner grant is anchored.`,
    ],
    whyUnresolvable: "Hard-protected paths (frozen TaskContract, seal, validators, acceptance/spec, policy) need owner approval via this bounded suspend/decide/resume; the Repairer cannot expand scope itself and silent expansion is rejected.".slice(0, 4000),
    choices: repairScopeProductChoices(blocker),
    workThatCanContinue: ["Read-only diagnosis can continue; no implementation may touch the needed files until a controller-minted owner grant anchors and reseals."],
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
  contract?: TaskContract;
}): Promise<RepairScopeSuspendedChoiceV1> {
  const { controlRoot, operationId, config, blocker } = input;
  assertRepairScopeBlockerReceipt(blocker);
  // HARD-protection defense: never suspend for non-exemptible paths even
  // when called directly (the resolver already returns BLOCKED without
  // suspending). Requires the contract for contract-specific paths.
  if (input.contract) {
    const hardViolations = findRepairHardProtectedViolations(
      blocker.filesNeededOutsideScope.map((entry) => entry.path),
      config,
      input.contract,
    );
    if (hardViolations.length) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_AMENDMENT_NON_EXEMPTIBLE: blocker path(s) are never exemptible (frozen TaskContract, seal, validators, acceptance/spec, policy): ${hardViolations.join(", ")}.`,
      );
    }
  }
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const receiptFile = repairScopeBlockerReceiptPath(stateRoot, config, blocker.taskId, blocker.workUnitId);
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

/**
 * Suspend for a HARD-protected repair blocker (suspend/decide/resume path).
 * Mirrors `suspendRepairScopeForProductChoice` and the Spec-Manager
 * suspension precedent (same suspendOperationForProductChoice lifecycle,
 * same SPEC_AUTHORING/PRODUCT_CHOICE continuation, same bounded expiry):
 * the exact blocker-declared hard paths + reasons become the bounded
 * approve-exact-set/decline choices with the durable blocker receipt as
 * authoritative evidence. No agent input influences choices/paths; no new
 * lifecycle is invented and the existing CC UI renders the request.
 */
export async function suspendHardRepairScopeForProductChoice(input: {
  controlRoot: string;
  operationId: string;
  config: HarnessProjectConfig;
  blocker: RepairScopeBlockerReceiptV1;
  hardPaths: readonly string[];
}): Promise<RepairScopeSuspendedChoiceV1> {
  const { controlRoot, operationId, config, blocker, hardPaths } = input;
  assertRepairScopeBlockerReceipt(blocker);
  if (!hardPaths.length) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_HARD_REQUIRED: hard-path suspension requires the declared hard-protected paths.");
  }
  const stateRoot = resolveOperationStateRoot(controlRoot);
  const receiptFile = repairScopeBlockerReceiptPath(stateRoot, config, blocker.taskId, blocker.workUnitId);
  const content = await fs.readFile(receiptFile, "utf8").catch(() => undefined);
  if (!content) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_RECEIPT_MISSING: the durable blocker receipt must exist before a hard-path product-choice suspension.");
  }
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const artifact = artifactForEvidence(controlRoot, receiptFile);
  const suspended = await suspendOperationForProductChoice(controlRoot, operationId, repairScopeHardProductChoiceContent(blocker, {
    artifact,
    sha256,
    description: "Durable Repairer hard-blocker receipt declaring the exact needed hard-protected files with per-file reasons.",
  }, hardPaths), {
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
 * DETERMINISTIC controller mint from a consumed hard-path product-choice
 * approval (the ONLY grant-creation path; same accepted grant shape).
 * The controller (token-holder) calls this AFTER `awaitRepairScopeProductChoice`
 * returned an approve-exact-paths selection for the current WAITING
 * continuation. Paths come ONLY from the controller-validated blocker
 * (deterministic); the decision must be the consumed CHOOSE/PRODUCT_CHOICE
 * approve for the suspend-created requestId with a one-time consumeExact
 * receipt under the live binding (stale approvals cannot mint). MAC minted
 * under the live controller token and anchored via controller-gated
 * `updateOperationMetadata`.
 */
export async function mintOwnerHardProtectionExemptionFromProductChoice(input: {
  root: string;
  operationId: string;
  paths: readonly string[];
  decision: HumanDecisionV2;
  binding: HumanDecisionBindingV2;
  requestId: string;
}): Promise<OwnerHardProtectionExemptionGrantV1> {
  if (isManagedBoundedAgent()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_AGENT_FORBIDDEN: Harness-spawned bounded agents cannot mint hard-protection exemptions; minting is controller-owned.");
  }
  const { decision, binding, requestId } = input;
  if (!requestId.startsWith("request:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_REQUEST_INVALID: minting requires the suspend-created product-choice request id.");
  }
  if (decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PURPOSE_MISMATCH: minting requires a CHOOSE product-choice approval for the suspended hard-path request.");
  }
  if (decision.purpose.requestId !== requestId) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_REQUEST_MISMATCH: the approval does not answer this suspend-created request.");
  }
  if (decision.purpose.choiceId !== REPAIR_SCOPE_APPROVE_CHOICE_ID) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_CHOICE_MISMATCH: only the bounded approve-exact-paths choice authorizes a hard-protection grant.");
  }
  if (!decision.actorId.startsWith("human:")) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_NOT_HUMAN: only a ledger human authority may authorize a hard-protection grant.");
  }
  if (!decision.reason.trim()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_REASON_REQUIRED: a hard-protection grant requires the approving reason.");
  }
  const operation = await loadOperation(input.root, input.operationId);
  if (isTerminalOperation(operation.status)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: a terminal operation cannot mint a hard-protection exemption.");
  }
  const live = repairScopeDecisionBinding(operation as never);
  const current = operation as Parameters<typeof currentControllerEpoch>[0];
  const liveEpoch = currentControllerEpoch(current);
  if (live.operationId !== binding.operationId || !candidateRevisionsEqual(live.candidate, binding.candidate)
    || live.operationExecutionRevision !== binding.operationExecutionRevision
    || live.policyDigest !== binding.policyDigest || live.controllerEpoch !== binding.controllerEpoch
    || live.controllerEpoch !== liveEpoch) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: minting binding does not match the live operation, candidate, execution revision, policy, or controller epoch.");
  }
  if (decision.operationId !== live.operationId || !candidateRevisionsEqual(decision.candidate, live.candidate)
    || decision.operationExecutionRevision !== live.operationExecutionRevision
    || decision.policyDigest !== live.policyDigest || decision.controllerEpoch !== live.controllerEpoch) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_DECISION_STALE: the approval does not match the current operation, candidate, execution revision, policy, or controller epoch.");
  }
  const now = new Date();
  if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= now.getTime()) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_EXPIRED: the hard-path approval expired before minting.");
  }
  const ledger = repairScopeLedger(input.root);
  if (!await ledger.consumedExact(binding, decision.purpose, decision.decisionId, decision.actorId)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNCONSUMED: the hard-path approval has no exact one-time consumption receipt; the BLOCKED outcome stands.");
  }
  const normalized: string[] = [];
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 exact file paths.");
  }
  for (const entry of input.paths) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw) || !isExactRepairScopeFilePath(raw)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${String(entry)}' is not an exact safe file path.`);
    }
    const filePath = normalizeRepairScopePath(raw);
    if (!filePath || !isSafeRepairScopePath(filePath) || !isExactRepairScopeFilePath(filePath)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `OWNER_EXEMPTION_PATH_INVALID: exemption path '${raw}' is not an exact safe file path.`);
    }
    normalized.push(filePath);
  }
  const paths = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  if (!paths.length || paths.length > 8) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_PATH_INVALID: an exemption requires 1 to 8 unique exact file paths.");
  }
  const token = controllerTokenFromEnvironment();
  if (!token) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNANCHORED: minting requires the live controller token.");
  }
  // H-NEW-12 LINEAGE + STABLE anchor: the grant roots lineage at the live
  // `candidateId` and binds the stable policy digest (not just the exact
  // digest). The exact `policyDigest` + `operationExecutionRevision` stay
  // MAC-bound as ANCHORED provenance for the ledger-decision cross-check;
  // live honor uses lineage + stable (see verify).
  const anchorPolicy = operation.resolvedOperationPolicy;
  if (!anchorPolicy) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: minting requires the live frozen policy to anchor the stable digest.");
  }
  let anchorStableDigest: string;
  try {
    assertResolvedOperationPolicyV2(anchorPolicy);
    anchorStableDigest = ownerExemptionStablePolicyDigest(anchorPolicy);
  } catch {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: minting requires a valid live frozen policy to anchor the stable digest.");
  }
  const createdAt = now.toISOString();
  const body = {
    version: 1 as const,
    kind: "OWNER_HARD_PROTECTION_EXEMPTION" as const,
    mechanism: "DETERMINISTIC" as const,
    exemptionId: `exemption:${crypto.randomUUID()}`,
    operationId: live.operationId,
    controllerEpoch: live.controllerEpoch,
    anchoredCandidateId: live.candidate.candidateId,
    candidateRevision: live.candidate.revision,
    candidateIdentityDigest: live.candidate.identityDigest,
    policyDigest: live.policyDigest,
    policyStableDigest: anchorStableDigest,
    operationExecutionRevision: live.operationExecutionRevision,
    paths,
    decisionId: decision.decisionId,
    decisionDigest: sha256Canonical(decision),
    decidedActor: decision.actorId,
    decisionReason: decision.reason.trim(),
    createdAt,
    ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
  };
  const grant: OwnerHardProtectionExemptionGrantV1 = { ...body, mac: computeOwnerExemptionMac(token, body) };
  await updateOperationMetadata(input.root, input.operationId, (currentOp) => {
    if (isTerminalOperation(currentOp.status)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_TERMINAL: the operation reached a terminal state before the exemption anchored.");
    }
    const currentBinding = repairScopeDecisionBinding(currentOp as never);
    const cur = currentOp as Parameters<typeof currentControllerEpoch>[0];
    if (currentBinding.operationId !== live.operationId || !candidateRevisionsEqual(currentBinding.candidate, live.candidate)
      || currentBinding.operationExecutionRevision !== live.operationExecutionRevision
      || currentBinding.policyDigest !== live.policyDigest || currentBinding.controllerEpoch !== live.controllerEpoch
      || currentControllerEpoch(cur) !== live.controllerEpoch) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_BINDING_STALE: operation identity changed before the exemption anchor committed.");
    }
    return { ownerExemptions: { ...(currentOp.ownerExemptions ?? {}), [grant.exemptionId]: grant } };
  }, { touchRevision: true, eventType: "operation.owner-exemption.anchored" });
  const anchored = await loadOperation(input.root, input.operationId);
  const persisted = anchored.ownerExemptions?.[grant.exemptionId];
  if (!persisted || persisted.mac !== grant.mac) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "OWNER_EXEMPTION_UNANCHORED: the exemption grant did not persist; the operation may have reached a terminal state.");
  }
  return persisted;
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
  | { status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1; selection?: RepairScopeChoiceSelectionV1; ownerExemption?: { exemptionId: string; decisionId: string; decisionDigest: string } }
  | { status: "BLOCKED"; blocker: RepairScopeBlockerReceiptV1; check: ValidationCheck; choiceId?: string }
> {
  const { root, controlRoot, operationId, config, contract, blocker } = input;
  assertRepairScopeBlockerReceipt(blocker);
  // HARD-protection gate (suspend/decide/resume, DETERMINISTIC, no model
  // judgment): a blocker intersecting frozen TaskContract, seal, validators,
  // acceptance/spec, or policy paths first honors an already-anchored
  // covering owner grant (no suspension). With NO covering grant the
  // controller suspends HUMAN_REQUIRED with bounded approve-exact-set/decline
  // choices generated deterministically from the declared hard paths (reason
  // cites the blocker) and awaits the session-authenticated product choice
  // bound to the WAITING continuation (Spec-Manager suspension precedent;
  // no new lifecycle; existing CC UI renders it). On approve the CONTROLLER
  // mints the MAC grant (same accepted shape), anchors it, resumes, and
  // retries with the grant; on decline/timeout BLOCKED stands. Suspend is
  // bounded (expiry -> BLOCKED).
  const hardViolations = findRepairHardProtectedViolations(
    blocker.filesNeededOutsideScope.map((entry) => entry.path),
    config,
    contract,
  );
  if (hardViolations.length) {
    const operation = await loadOperation(controlRoot, operationId);
    const ledger = repairScopeLedger(controlRoot);
    const covering = await findCoveringOwnerHardProtectionExemption({
      operation,
      neededPaths: blocker.filesNeededOutsideScope.map((entry) => entry.path),
      ledger,
    });
    if (covering.grant) {
      const applied = await applyOwnerExemptedRepairScopeAmendment({ root, config, contract, blocker, grant: covering.grant, ledger });
      return {
        status: "AMENDED",
        contract: applied.contract,
        amendment: applied.amendment,
        ownerExemption: {
          exemptionId: covering.grant.exemptionId,
          decisionId: covering.grant.decisionId,
          decisionDigest: covering.grant.decisionDigest,
        },
      };
    }
    const preexistingHard = await listRepairScopeAmendments(root, config, contract.task.id);
    if (preexistingHard.length >= MAX_REPAIR_SCOPE_AMENDMENTS_PER_TASK_V1) {
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations) };
    }
    const suspendedHard = await suspendHardRepairScopeForProductChoice({
      controlRoot, operationId, config, blocker, hardPaths: hardViolations,
    });
    void suspendedHard;
    let hardSelection: RepairScopeChoiceSelectionV1;
    try {
      hardSelection = await awaitRepairScopeProductChoice({ controlRoot, operationId, timeoutMs: input.timeoutMs, pollMs: input.pollMs });
    } catch {
      // Unanswered (timeout), expired, terminal, or stale: BLOCKED stands.
      // When still WAITING the suspension remains for a human decision
      // within expiry; no grant is minted, no amendment, no retry.
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations) };
    }
    if (hardSelection.choiceId === REPAIR_SCOPE_DENY_CHOICE_ID) {
      await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations), choiceId: hardSelection.choiceId };
    }
    if (hardSelection.choiceId !== REPAIR_SCOPE_APPROVE_CHOICE_ID) {
      await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations), choiceId: hardSelection.choiceId };
    }
    // Controller mints + anchors the grant from the consumed approval, then
    // re-verifies everything via the owner-exempted apply (MAC, binding,
    // expiry, ledger consumed-receipt cross-check, exact coverage) before
    // resuming. Any mint/apply throw stays BLOCKED (fail closed); the
    // suspension remains WAITING only when unanswered, otherwise it resumes.
    let hardGrant: OwnerHardProtectionExemptionGrantV1;
    try {
      hardGrant = await mintOwnerHardProtectionExemptionFromProductChoice({
        root: controlRoot,
        operationId,
        paths: blocker.filesNeededOutsideScope.map((entry) => entry.path),
        decision: hardSelection.decision,
        binding: hardSelection.binding,
        requestId: hardSelection.requestId,
      });
    } catch {
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations), choiceId: hardSelection.choiceId };
    }
    const hardLedger = repairScopeLedger(controlRoot);
    let hardApplied: Awaited<ReturnType<typeof applyOwnerExemptedRepairScopeAmendment>>;
    try {
      hardApplied = await applyOwnerExemptedRepairScopeAmendment({ root, config, contract, blocker, grant: hardGrant, ledger: hardLedger });
    } catch {
      await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
      return { status: "BLOCKED", blocker, check: repairScopeNonExemptibleValidationCheck(blocker, hardViolations), choiceId: hardSelection.choiceId };
    }
    await resumeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
    await completeOperationProductChoice(controlRoot, operationId).catch(() => undefined);
    return {
      status: "AMENDED",
      contract: hardApplied.contract,
      amendment: hardApplied.amendment,
      selection: hardSelection,
      ownerExemption: {
        exemptionId: hardGrant.exemptionId,
        decisionId: hardGrant.decisionId,
        decisionDigest: hardGrant.decisionDigest,
      },
    };
  }
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
 *
 * HARD-protection defense: when `hardProtected` is provided, any exempted
 * path intersecting it throws fail-closed (never exemptible) — UNLESS a
 * verified owner grant is presented via `ownerScope`. The filter tier
 * re-verifies the MAC under the live controller token plus operation/epoch/
 * LINEAGE + STABLE binding, expiry, terminal state, and exact coverage (all
 * sync, no ledger I/O); the async authority gate
 * (`verifyOwnerHardProtectionExemption`, incl. the ledger cross-check)
 * already ran in the amendment-apply path and re-runs in the retry caller
 * before this filter executes. A forged, stale, expired, terminal, or
 * non-covering grant throws the same NON_EXEMPTIBLE as no exemption at all.
 * Direct writes and general assembly scope NEVER honor exemptions — only
 * this amendment-path projection.
 */
export function filterForbiddenScopeForAmendment(
  forbiddenScope: readonly string[],
  amendment: RepairScopeAmendmentV1,
  hardProtected?: readonly string[],
  ownerScope?: {
    grant: OwnerHardProtectionExemptionGrantV1;
    operationId: string;
    controllerEpoch: number;
    candidateRevision: number;
    candidateIdentityDigest: string;
    candidateId: string;
    /** Durable live parent link (controller-loaded candidateRevision.parentCandidateId) for parent-linked walk. */
    candidateParentCandidateId?: string;
    policyStableDigest: string;
    /** CONTROLLER-DURABLE truth (operation.candidateAssemblyReceipts from a controller-loaded record). */
    assemblies?: Record<string, import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1> | readonly import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1[];
    /** Optional UNTRUSTED supplied hints: each must confirm against durable (mismatch → refuse). */
    hintAssemblies?: Record<string, import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1> | readonly import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1[];
    policyDigest?: string;
    operationExecutionRevision?: number;
    terminal: boolean;
  },
): string[] {
  assertRepairScopeAmendment(amendment);
  if (hardProtected) {
    const violations = amendment.exemptedPaths.filter((filePath) =>
      matchesAnyHardProtectedPattern(normalizeRepairScopePath(filePath.trim()), hardProtected),
    );
    if (violations.length && !ownerExemptionCoversHardPaths(amendment, violations, ownerScope)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_AMENDMENT_NON_EXEMPTIBLE: exempted path(s) are never exemptible (frozen TaskContract, seal, validators, acceptance/spec, policy): ${violations.join(", ")}.`,
      );
    }
  }
  const exempted = new Set<string>();
  for (const filePath of amendment.exemptedPaths) {
    const normalized = normalizeRepairScopePath(filePath.trim());
    if (!normalized) continue;
    exempted.add(normalized);
    exempted.add(`${normalized}/**`);
  }
  return forbiddenScope
    .map((entry) => ({ raw: entry, normalized: normalizeRepairScopePath(entry.trim()) }))
    .filter(({ normalized }) => !exempted.has(normalized))
    .map(({ raw }) => raw);
}

function ownerExemptionCoversHardPaths(
  amendment: RepairScopeAmendmentV1,
  hardViolations: string[],
  ownerScope: {
    grant: OwnerHardProtectionExemptionGrantV1;
    operationId: string;
    controllerEpoch: number;
    candidateRevision: number;
    candidateIdentityDigest: string;
    candidateId: string;
    candidateParentCandidateId?: string;
    policyStableDigest: string;
    assemblies?: Record<string, import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1> | readonly import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1[];
    hintAssemblies?: Record<string, import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1> | readonly import("../operations/v2Contracts.js").CandidateAssemblyReceiptV1[];
    policyDigest?: string;
    operationExecutionRevision?: number;
    terminal: boolean;
  } | undefined,
): boolean {
  // No grant, or the amendment does not cite one: not covered (existing
  // fail-closed behavior preserved bit-for-bit for all current callers).
  if (!ownerScope || !amendment.ownerExemption) return false;
  const { grant, operationId, controllerEpoch, candidateRevision, candidateIdentityDigest, candidateId, candidateParentCandidateId, policyStableDigest, assemblies, hintAssemblies, terminal } = ownerScope;
  try {
    assertOwnerHardProtectionExemptionGrant(grant);
  } catch {
    return false;
  }
  if (terminal) return false;
  if (grant.exemptionId !== amendment.ownerExemption.exemptionId) return false;
  if (grant.operationId !== operationId || grant.controllerEpoch !== controllerEpoch) return false;
  // Live-identity binding (H-NEW-12 LINEAGE + STABLE, sync tier, H-NEW-12 R2
  // provenance-bound): LIVE must BE the anchored revision or descend from it
  // via the CONTROLLER-DURABLE assembly-receipts chain (never revision numbers
  // alone — siblings excluded), op-bound to `operationId` and parent-linked
  // to the durable live parent when available. `assemblies` MUST be the
  // controller-loaded durable map; `hintAssemblies` (when present) must each
  // confirm against it. Live-exact `policyDigest` /
  // `operationExecutionRevision` matching is DROPPED (covered by lineage +
  // epoch + expiry + terminal; see verify). Missing live fields fail closed.
  if (!Number.isSafeInteger(candidateRevision) || typeof candidateIdentityDigest !== "string"
    || typeof candidateId !== "string" || !candidateId
    || typeof policyStableDigest !== "string" || !/^[a-f0-9]{64}$/.test(policyStableDigest)) return false;
  if (!isOwnerExemptionLineageDescendant({
    liveCandidate: { candidateId, revision: candidateRevision, identityDigest: candidateIdentityDigest, ...(candidateParentCandidateId ? { parentCandidateId: candidateParentCandidateId } : {}) },
    anchoredCandidateId: grant.anchoredCandidateId,
    anchoredRevision: grant.candidateRevision,
    anchoredIdentityDigest: grant.candidateIdentityDigest,
    expectedOperationId: operationId,
    assemblies,
    ...(hintAssemblies !== undefined ? { hintAssemblies } : {}),
  })) return false;
  if (policyStableDigest !== grant.policyStableDigest) return false;
  if (!verifyOwnerExemptionMac(controllerTokenFromEnvironment(), grant)) return false;
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= Date.now()) return false;
  return hardViolations
    .map((filePath) => normalizeRepairScopePath(filePath.trim()))
    .every((filePath) => grant.paths.includes(filePath));
}

function extractMarkedRepairResult(stdout: string, stderr: string): unknown | undefined {
  // Canonical marker path: fenced blocks, smart quotes, trailing logs,
  // JSON-in-JSON, and prefix-shrink are handled by extractMarkedJson.
  // Absent markers (EMPTY_OUTPUT / NO_MARKER) map to undefined ("no blocker");
  // observed-but-invalid markers (MARKER_INVALID_JSON / NATIVE_JSON_INVALID,
  // including tail truncation) throw fail-closed and are never undefined.
  try {
    return extractMarkedJson(stdout, stderr);
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      if (error.reason === "MARKER_INVALID_JSON" || error.reason === "NATIVE_JSON_INVALID") {
        throw new AehError(
          "PARTICIPANT_PLAN_INVALID",
          `REPAIR_SCOPE_BLOCKER_INVALID: MARKER_INVALID_JSON: agent output contained AEH_RESULT_JSON= but the marker payload was not valid JSON (${error.reason}).`,
        );
      }
      return undefined;
    }
    throw error;
  }
}

function safe(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
