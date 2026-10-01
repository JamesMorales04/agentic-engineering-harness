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
      if (!ids.has(dependency)) throw new Error(`WORK_GRAPH_INVALID: '${unit.id}' depends on unknown unit '${dependency}'.`);
      if (dependency === unit.id) throw new Error(`WORK_GRAPH_INVALID: '${unit.id}' cannot depend on itself.`);
    }
  }
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

export function assertAcyclicWorkGraph(graph: WorkGraphV1): void {
  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string): void => {
    if (state.get(id) === "visiting") throw new Error(`WORK_GRAPH_INVALID: dependency cycle includes '${id}'.`);
    if (state.get(id) === "visited") return;
    state.set(id, "visiting");
    const unit = graph.units.find((candidate) => candidate.id === id);
    if (!unit) throw new Error(`WORK_GRAPH_INVALID: unknown unit '${id}'.`);
    unit.dependencies.forEach(visit);
    state.set(id, "visited");
  };
  graph.units.forEach((unit) => visit(unit.id));
}

export function createWorkGraph(input: Omit<WorkGraphV1, "version">): WorkGraphV1 {
  const graph = validateWorkGraph({ version: 1, ...input });
  assertAcyclicWorkGraph(graph);
  return graph;
}
