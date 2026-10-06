import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";
import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
import { assuranceLevelSchema, implementationRouteSchema } from "./contracts.js";

export const workRiskValues = ["low", "medium", "high", "critical"] as const;
export type WorkRisk = (typeof workRiskValues)[number];
export const workRiskSchema = z.enum(workRiskValues);

export const changeKindValues = ["source", "test", "schema", "config", "docs", "dependency", "infrastructure", "security"] as const;
export type ChangeKind = (typeof changeKindValues)[number];
export const changeKindSchema = z.enum(changeKindValues);

export const graphWorkUnitStatusValues = ["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"] as const;
export type GraphWorkUnitStatus = (typeof graphWorkUnitStatusValues)[number];
export const graphWorkUnitStatusSchema = z.enum(graphWorkUnitStatusValues);

export const resourceClaimModeValues = ["SHARED_READ", "EXCLUSIVE_WRITE", "ORDERED_SEQUENCE"] as const;
export type ResourceClaimMode = (typeof resourceClaimModeValues)[number];
export const resourceClaimModeSchema = z.enum(resourceClaimModeValues);
export interface ResourceClaimV1 { version: 1; resource: string; mode: ResourceClaimMode; order?: number }
export const resourceClaimSchema = z.object({
  version: z.literal(1),
  resource: z.string().trim().min(1).max(200),
  mode: resourceClaimModeSchema,
  order: z.number().int().min(0).max(100000).optional()
}).strict();

export interface WorkUnitV1 {
  version: 1;
  id: string;
  objective: string;
  scope: string[];
  dependencies: string[];
  requirementRefs: string[];
  acceptanceRefs: string[];
  competencies: string[];
  riskTags: string[];
  changeKinds: ChangeKind[];
  risk: WorkRisk;
  status: GraphWorkUnitStatus;
  resourceClaims: ResourceClaimV1[];
}

export const workUnitV1Schema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(500),
  scope: z.array(z.string().trim().min(1)).min(1).max(256),
  dependencies: z.array(z.string().trim().min(1)).max(64),
  requirementRefs: z.array(z.string().trim().min(1)).max(128),
  acceptanceRefs: z.array(z.string().trim().min(1)).max(128),
  competencies: z.array(z.string().trim().min(1)).max(64),
  riskTags: z.array(z.string().trim().min(1)).max(64),
  changeKinds: z.array(changeKindSchema).min(1).max(changeKindValues.length),
  risk: workRiskSchema,
  status: graphWorkUnitStatusSchema,
  resourceClaims: z.array(resourceClaimSchema).max(64).default([])
}).strict();

export interface WorkGraphV1 {
  version: 1;
  taskId: string;
  objective: string;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  requirementRefs: string[];
  acceptanceRefs: string[];
  units: WorkUnitV1[];
}

export const workGraphV1Schema = z.object({
  version: z.literal(1),
  taskId: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(500),
  route: implementationRouteSchema,
  assurance: assuranceLevelSchema,
  requirementRefs: z.array(z.string().trim().min(1)).max(128),
  acceptanceRefs: z.array(z.string().trim().min(1)).max(128),
  units: z.array(workUnitV1Schema).max(256)
}).strict();

export interface WorkExpansionRequestV1 {
  version: 1;
  taskId: string;
  sourceUnitId: string;
  reason: string;
  requestedCompetencies: string[];
  requestedScope: string[];
  requestedAcceptanceRefs: string[];
}

export const workExpansionRequestV1Schema = z.object({
  version: z.literal(1),
  taskId: z.string().trim().min(1),
  sourceUnitId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  requestedCompetencies: z.array(z.string().trim().min(1)).max(64),
  requestedScope: z.array(z.string().trim().min(1)).max(256),
  requestedAcceptanceRefs: z.array(z.string().trim().min(1)).max(128)
}).strict();

export function validateWorkGraph(value: unknown): WorkGraphV1 {
  const parsed = workGraphV1Schema.parse(value);
  const ids = new Set<string>();
  for (const unit of parsed.units) {
    if (ids.has(unit.id)) throw new Error(`WORK_GRAPH_INVALID: duplicate work unit '${unit.id}'.`);
    ids.add(unit.id);
  }
  for (const unit of parsed.units) {
    const resources = new Set<string>();
    const resourceModes = new Set<string>();
    for (const claim of unit.resourceClaims) {
      if (resources.has(claim.resource)) throw new Error(`WORK_GRAPH_INVALID: '${unit.id}' declares duplicate resource claim '${claim.resource}'.`);
      resources.add(claim.resource);
      if (claim.mode === "ORDERED_SEQUENCE" && claim.order === undefined) throw new Error(`WORK_GRAPH_INVALID: '${unit.id}' declares ORDERED_SEQUENCE for '${claim.resource}' without a non-negative integer order.`);
      const modeKey = `${claim.resource}\u0000${claim.mode}`;
      if (resourceModes.has(modeKey)) throw new Error(`WORK_GRAPH_INVALID: '${unit.id}' declares duplicate ${claim.mode} claim for '${claim.resource}'.`);
      resourceModes.add(modeKey);
    }
  }
  for (const unit of parsed.units) {
    for (const dependency of unit.dependencies) {
      if (!ids.has(dependency)) throw new Error(`WORK_GRAPH_INVALID [UNKNOWN_DEPENDENCY]: '${unit.id}' depends on unknown unit '${dependency}'.`);
      if (dependency === unit.id) throw new Error(`WORK_GRAPH_INVALID [DEPENDENCY_CYCLE]: '${unit.id}' cannot depend on itself.`);
    }
  }
  // Cycle rejection is unconditional at this validation boundary: standalone
  // validateWorkGraph callers get the same fail-closed graph as createWorkGraph.
  // MECHANISM: DETERMINISTIC. Finite DAGs always expose a dependency-ready
  // node, so the iterative visit below reports the first re-entered unit.
  const visitState = new Map<string, "visiting" | "visited">();
  const visit = (id: string): void => {
    if (visitState.get(id) === "visiting") throw new Error(`WORK_GRAPH_INVALID [DEPENDENCY_CYCLE]: dependency cycle includes '${id}'.`);
    if (visitState.get(id) === "visited") return;
    visitState.set(id, "visiting");
    const unit = parsed.units.find((candidate) => candidate.id === id);
    if (!unit) throw new Error(`WORK_GRAPH_INVALID [UNKNOWN_DEPENDENCY]: unknown unit '${id}'.`);
    unit.dependencies.forEach(visit);
    visitState.set(id, "visited");
  };
  parsed.units.forEach((unit) => visit(unit.id));
  const coveredRequirements = new Set(parsed.units.flatMap((unit) => unit.requirementRefs));
  const coveredAcceptance = new Set(parsed.units.flatMap((unit) => unit.acceptanceRefs));
  const missingRequirements = parsed.requirementRefs.filter((id) => !coveredRequirements.has(id));
  const missingAcceptance = parsed.acceptanceRefs.filter((id) => !coveredAcceptance.has(id));
  if (missingRequirements.length) throw new Error(`WORK_GRAPH_INVALID: uncovered requirements ${missingRequirements.join(", ")}.`);
  if (missingAcceptance.length) throw new Error(`WORK_GRAPH_INVALID: uncovered acceptance refs ${missingAcceptance.join(", ")}.`);
  return parsed;
}

function claimsByResource(claims: readonly ResourceClaimV1[]): Map<string, Set<ResourceClaimMode>> {
  const byResource = new Map<string, Set<ResourceClaimMode>>();
  for (const claim of claims) {
    const modes = byResource.get(claim.resource) ?? new Set<ResourceClaimMode>();
    modes.add(claim.mode);
    byResource.set(claim.resource, modes);
  }
  return byResource;
}

export function resourceClaimConflicts(left: readonly ResourceClaimV1[], right: readonly ResourceClaimV1[]): string[] {
  const leftByResource = claimsByResource(left);
  const rightByResource = claimsByResource(right);
  const conflicts: string[] = [];
  for (const resource of [...leftByResource.keys()].filter((name) => rightByResource.has(name)).sort()) {
    const leftModes = leftByResource.get(resource)!;
    const rightModes = rightByResource.get(resource)!;
    if (leftModes.has("ORDERED_SEQUENCE") || rightModes.has("ORDERED_SEQUENCE")) { conflicts.push(`resource:${resource}:ordered-sequence`); continue; }
    if (leftModes.has("EXCLUSIVE_WRITE") && rightModes.has("EXCLUSIVE_WRITE")) { conflicts.push(`resource:${resource}:exclusive-exclusive`); continue; }
    if (leftModes.has("EXCLUSIVE_WRITE") !== rightModes.has("EXCLUSIVE_WRITE")) conflicts.push(`resource:${resource}:write-read`);
  }
  return conflicts;
}

export function resourceClaimOrderingViolations(units: ReadonlyArray<{ id: string; resourceClaims: readonly ResourceClaimV1[] }>): string[] {
  const byResource = new Map<string, Array<{ id: string; order?: number }>>();
  for (const unit of units) {
    for (const claim of unit.resourceClaims) {
      if (claim.mode !== "ORDERED_SEQUENCE") continue;
      byResource.set(claim.resource, [...(byResource.get(claim.resource) ?? []), { id: unit.id, order: claim.order }]);
    }
  }
  const violations: string[] = [];
  for (const resource of [...byResource.keys()].sort()) {
    const idsByOrder = new Map<string, string[]>();
    for (const entry of byResource.get(resource)!) {
      const orderKey = entry.order === undefined ? "undefined" : String(entry.order);
      idsByOrder.set(orderKey, [...(idsByOrder.get(orderKey) ?? []), entry.id]);
    }
    for (const orderKey of [...idsByOrder.keys()].sort()) {
      const ids = idsByOrder.get(orderKey)!;
      if (ids.length > 1) violations.push(`resource:${resource}:duplicate-order:${orderKey}`);
    }
  }
  return violations;
}

export function createWorkGraph(input: Omit<WorkGraphV1, "version">): WorkGraphV1 {
  return validateWorkGraph({ version: 1, ...input });
}

/**
 * Minimal structural surface the deterministic scheduler needs. Both
 * WorkUnitV1 and planner WorkUnitOutput satisfy it.
 */
export interface SchedulableWorkUnitV1 {
  id: string;
  scope: readonly string[];
  dependencies: readonly string[];
  resourceClaims?: readonly ResourceClaimV1[];
}

/** Static (glob-free) leading path of a scope pattern. */
export function scopeStaticPrefix(pattern: string): string {
  return pattern.split(/[?*\[]/, 1)[0]!.replace(/\/+$/, "");
}

function pathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function nonEmptyPrefixOverlap(left: string, right: string): boolean {
  return Boolean(left && right) && (pathWithin(left, right) || pathWithin(right, left));
}

/**
 * MECHANISM: DETERMINISTIC. Scope overlap shared by every scheduler: exact,
 * glob, or directory-prefix overlap on either side.
 */
export function workUnitScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftScope) => right.some((rightScope) =>
    leftScope === rightScope
    || minimatch(leftScope, rightScope, { dot: true })
    || minimatch(rightScope, leftScope, { dot: true })
    || nonEmptyPrefixOverlap(scopeStaticPrefix(leftScope), scopeStaticPrefix(rightScope))));
}

/**
 * MECHANISM: DETERMINISTIC. Scheduling conflicts observable from the frozen
 * graph alone: scope overlap plus logical resource-claim conflicts
 * (exclusive-exclusive, write-read, and any ORDERED_SEQUENCE sharing).
 */
export function deterministicSchedulingConflicts(left: SchedulableWorkUnitV1, right: SchedulableWorkUnitV1): string[] {
  const reasons: string[] = [];
  if (workUnitScopesOverlap(left.scope, right.scope)) reasons.push("scope-overlap");
  for (const conflict of resourceClaimConflicts(left.resourceClaims ?? [], right.resourceClaims ?? [])) reasons.push(`resource-claim:${conflict}`);
  return [...new Set(reasons)];
}

/**
 * MECHANISM: DETERMINISTIC. Single conflict-aware wave scheduler shared by
 * compileExecutionBlueprint (frozen blueprint.waves) and planParallelism
 * (runtime schedule.waves). A wave holds only units whose dependencies are
 * complete, whose ORDERED_SEQUENCE predecessors are complete, and which are
 * pairwise conflict-free. Graph-snapshot (graphify) conflicts are a
 * planParallelism-only refinement passed via areMutuallyExclusive.
 *
 * Failure codes are distinct: ORDERING_BLOCKED for duplicate
 * ORDERED_SEQUENCE positions or ordering deadlocks, UNKNOWN_DEPENDENCY for
 * references outside the scheduled set, DEPENDENCY_CYCLE when every
 * remaining unit waits on another remaining unit.
 */
export function planWorkUnitWaves(
  units: readonly SchedulableWorkUnitV1[],
  options?: { areMutuallyExclusive?: (leftId: string, rightId: string) => boolean }
): string[][] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const mutuallyExclusive = options?.areMutuallyExclusive
    ?? ((leftId: string, rightId: string) => deterministicSchedulingConflicts(byId.get(leftId)!, byId.get(rightId)!).length > 0);
  const orderingViolations = resourceClaimOrderingViolations(units.map((unit) => ({ id: unit.id, resourceClaims: unit.resourceClaims ?? [] })));
  if (orderingViolations.length) throw new Error(`Cannot schedule delegation plan [ORDERING_BLOCKED]: ${orderingViolations.join(", ")}`);
  const orderedClaims = new Map<string, Array<{ resource: string; order?: number }>>(units.map((unit) => [unit.id, (unit.resourceClaims ?? []).filter((claim) => claim.mode === "ORDERED_SEQUENCE").map((claim) => ({ resource: claim.resource, order: claim.order }))]));
  const remaining = new Map(units.map((unit) => [unit.id, unit]));
  const completed = new Set<string>();
  const orderedReadinessSatisfied = (unit: SchedulableWorkUnitV1): boolean => {
    for (const claim of orderedClaims.get(unit.id) ?? []) {
      const order = claim.order;
      if (order === undefined) continue;
      for (const [otherId, otherClaims] of orderedClaims) {
        if (otherId === unit.id || completed.has(otherId)) continue;
        if (otherClaims.some((other) => other.resource === claim.resource && other.order !== undefined && other.order < order)) return false;
      }
    }
    return true;
  };
  const waves: string[][] = [];
  while (remaining.size) {
    const wave: SchedulableWorkUnitV1[] = [];
    for (const unit of remaining.values()) {
      if (!unit.dependencies.every((dependency) => completed.has(dependency))) continue;
      if (!orderedReadinessSatisfied(unit)) continue;
      if (wave.some((other) => mutuallyExclusive(unit.id, other.id))) continue;
      wave.push(unit);
    }
    if (!wave.length) throw classifySchedulingBlockage([...remaining.values()], completed);
    waves.push(wave.map((unit) => unit.id));
    for (const unit of wave) { completed.add(unit.id); remaining.delete(unit.id); }
  }
  return waves;
}

function classifySchedulingBlockage(remaining: SchedulableWorkUnitV1[], completed: ReadonlySet<string>): Error {
  const remainingIds = new Set(remaining.map((unit) => unit.id));
  for (const unit of remaining) {
    for (const dependency of unit.dependencies) {
      if (!completed.has(dependency) && !remainingIds.has(dependency)) {
        return new Error(`Cannot schedule delegation plan [UNKNOWN_DEPENDENCY]: '${unit.id}' depends on unknown unit '${dependency}'.`);
      }
    }
  }
  const dependencyReady = remaining.filter((unit) => unit.dependencies.every((dependency) => completed.has(dependency)));
  if (dependencyReady.length) {
    return new Error(`Cannot schedule delegation plan [ORDERING_BLOCKED]: ordering deadlock among ${remaining.map((unit) => unit.id).join(", ")}; '${dependencyReady[0]!.id}' is dependency-ready but waits for an ORDERED_SEQUENCE predecessor that can never complete first.`);
  }
  return new Error(`Cannot schedule delegation plan [DEPENDENCY_CYCLE]: dependency cycle among ${remaining.map((unit) => unit.id).join(", ")}.`);
}

/**
 * Plan-time scope-shape validation (fail-closed, no broadening).
 *
 * MECHANISM: DETERMINISTIC. A WorkUnit scope entry that is an exist-on-disk
 * directory without a trailing `/**` and without being an exact file never
 * matches children at assembly (the candidate assembler matches with exact
 * minimatch, so `docs/evidence/s9` never matches
 * `docs/evidence/s9/evidence.md`). Accepting it silently at plan time only
 * explodes later as PARTICIPANT_PLAN_INVALID. Reject it here, before
 * execution, with a typed error naming the unit + scope entry + required
 * form. Bare directories never gain `/**` semantics silently.
 *
 * Valid: `**`, any explicit glob (`*?[]{}!()` etc, including `dir/*` and
 * `dir/**`), and exact file paths (exist-on-disk file, or non-existent
 * future file path). Rejected: exist-on-disk directory without trailing
 * `/**` (including trailing-slash form `dir/`).
 *
 * Traversal: `..` segments, absolute paths, and drive prefixes are rejected
 * on the RAW input before normalization or fs.stat (never stripped or
 * resolved away), including inside glob scopes (`../outside/**`,
 * `/etc/**`). After join, lexical containment within the symlink-resolved
 * root is verified. Symlink-target policy: fail closed on escape — a scope
 * whose realpath (or nearest existing ancestor's realpath for future
 * paths) leaves the resolved root is rejected as out-of-root.
 */
export function normalizeScopeEntry(scope: string): string {
  return scope.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isExplicitGlobScope(scope: string): boolean {
  const trimmed = scope.trim();
  if (trimmed === "**" || trimmed.endsWith("/**")) return true;
  return /[*?[\]{}!()+@]/.test(trimmed);
}

/**
 * DETERMINISTIC raw-input traversal gate (same theme as prior Luna scope
 * fixes). Strips leading `./` segments (including redundant `././`, `.//`
 * forms) FIRST, then rejects any `..` segment, absolute form, or drive
 * prefix on the stripped form BEFORE normalization, so a `./C:/...` prefix
 * can never hide a drive as a safe relative path. Order: strip → reject →
 * normalize → contain.
 */
function hasUnsafeRawScopeInput(value: string): boolean {
  const slashedRaw = value.replaceAll("\\", "/");
  const stripped = slashedRaw.replace(/^(?:\.\/+)+/, "");
  if (path.isAbsolute(stripped) || path.posix.isAbsolute(stripped) || path.win32.isAbsolute(stripped)) return true;
  if (stripped.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(stripped)) return true;
  if (stripped.split("/").includes("..")) return true;
  return false;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Nearest existing ancestor's realpath, for symlink-escape detection on not-yet-existing paths. */
async function realpathNearestExisting(candidate: string): Promise<{ realBase: string; remainder: string } | undefined> {
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const realBase = await fs.realpath(current);
      return { realBase, remainder: suffix.length ? path.join(...suffix) : "" };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function throwOutOfRoot(unitId: string, rawScope: string, symlinkEscape: boolean): never {
  throw new Error(
    symlinkEscape
      ? `WORK_GRAPH_INVALID: '${unitId}' declares out-of-root scope '${rawScope}' (symlink target escapes the repository root). Scopes must resolve inside the repository root.`
      : `WORK_GRAPH_INVALID: '${unitId}' declares out-of-root scope '${rawScope}'. Scopes must be root-relative paths without '..', absolute, or drive-prefix forms.`
  );
}

export async function assertNoBareDirectoryScopes(
  root: string,
  units: readonly { id: string; scope: readonly string[] }[]
): Promise<void> {
  const rootResolved = path.resolve(root);
  const resolvedRoot = await fs.realpath(rootResolved).catch(() => rootResolved);
  for (const unit of units) {
    for (const rawScope of unit.scope) {
      const scope = rawScope.trim();
      if (!scope) continue;
      // Traversal gate BEFORE any glob/`/**` shortcut or fs.stat: `..`
      // segments, absolute paths, and drive prefixes are rejected here, not
      // normalized away. This also closes the `../outside/**` and `/etc/**`
      // bypass where a glob suffix previously skipped validation entirely.
      if (hasUnsafeRawScopeInput(scope)) throwOutOfRoot(unit.id, rawScope, false);
      if (scope === "**") continue;
      if (scope.endsWith("/**") || isExplicitGlobScope(scope)) {
        // Glob scopes perform no fs.stat, but the literal base must still be
        // contained. Lexical containment first, then symlink-target check on
        // the nearest existing ancestor of the base (fail-closed on escape).
        const globIndex = scope.search(/[*?[\]{}!()+@]/);
        const baseRaw = (globIndex === -1 ? scope : scope.slice(0, globIndex)).replace(/\/+$/, "");
        const baseNormalized = baseRaw ? normalizeScopeEntry(baseRaw) : "";
        if (!baseNormalized || baseNormalized === "**") continue;
        if (baseNormalized.split("/").includes("..")) throwOutOfRoot(unit.id, rawScope, false);
        const baseCandidate = path.join(resolvedRoot, baseNormalized);
        if (!isWithinRoot(resolvedRoot, baseCandidate)) throwOutOfRoot(unit.id, rawScope, false);
        const resolved = await realpathNearestExisting(baseCandidate);
        if (resolved && !isWithinRoot(resolvedRoot, resolved.realBase)) throwOutOfRoot(unit.id, rawScope, true);
        continue;
      }
      const normalized = normalizeScopeEntry(scope);
      if (!normalized || normalized === "**") continue;
      // Defense in depth: normalization must never reintroduce `..`.
      if (normalized.split("/").includes("..")) throwOutOfRoot(unit.id, rawScope, false);
      const candidate = path.join(resolvedRoot, normalized);
      // Lexical containment after join (defense in depth: raw gate above
      // already rejected every `..`/absolute/drive form).
      if (!isWithinRoot(resolvedRoot, candidate)) throwOutOfRoot(unit.id, rawScope, false);
      // Symlink-target policy: fail closed on escape. Resolve the candidate
      // (or its nearest existing ancestor for future file paths) and reject
      // when the real target leaves the symlink-resolved root.
      const resolved = await realpathNearestExisting(candidate);
      if (resolved && !isWithinRoot(resolvedRoot, resolved.realBase)) throwOutOfRoot(unit.id, rawScope, true);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(candidate);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        throw new Error(
          `WORK_GRAPH_INVALID: '${unit.id}' declares bare directory scope '${rawScope}'. Use an exact file path or '${normalized}/**'.`
        );
      }
    }
  }
}
