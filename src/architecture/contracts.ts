import { z } from "zod";

export const implementationRouteValues = ["NO_AGENT", "DIRECT", "DELEGATED", "FORMAL_SDD"] as const;
export type ImplementationRoute = (typeof implementationRouteValues)[number];
export const implementationRouteSchema = z.enum(implementationRouteValues);

export const assuranceLevelValues = ["NONE", "STANDARD", "ELEVATED", "CRITICAL"] as const;
export type AssuranceLevel = (typeof assuranceLevelValues)[number];
export const assuranceLevelSchema = z.enum(assuranceLevelValues);

export const workUnitStatusValues = ["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"] as const;
export type WorkUnitStatus = (typeof workUnitStatusValues)[number];
export const workUnitStatusSchema = z.enum(workUnitStatusValues);

export interface RouteEvidence {
  route: ImplementationRoute;
  source: string;
  statement: string;
}

export const routeEvidenceSchema = z.object({
  route: implementationRouteSchema,
  source: z.string().trim().min(1).max(120),
  statement: z.string().trim().min(1).max(1_000)
}).strict();

export interface IntentDecision {
  version: 1;
  intent: string;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  routeEvidence: RouteEvidence[];
}

export const intentDecisionSchema = z.object({
  version: z.literal(1),
  intent: z.string().trim().min(1).max(200),
  route: implementationRouteSchema,
  assurance: assuranceLevelSchema,
  routeEvidence: z.array(routeEvidenceSchema).min(1).max(16)
}).strict();

export interface Progress {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
}

export const progressSchema = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative()
}).strict();

export interface WorkUnit {
  id: string;
  title: string;
  status: WorkUnitStatus;
  dependsOn?: string[];
}

export const workUnitSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  status: workUnitStatusSchema,
  dependsOn: z.array(z.string().trim().min(1).max(120)).max(32).optional()
}).strict();

export interface FeatureCapsuleV1 {
  version: 1;
  /** `taskId`/`objective` are the canonical v2 names. The legacy aliases remain readable for migration. */
  taskId?: string;
  objective?: string;
  featureId?: string;
  intent?: string;
  scope?: { allowed: string[]; forbidden?: string[] };
  constraints?: Record<string, unknown>;
  acceptance?: string[];
  contextRefs?: string[];
  candidateRevision?: Record<string, unknown>;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  routeEvidence: RouteEvidence[];
  progress: Progress;
  workUnits: WorkUnit[];
}

export const featureCapsuleV1Schema = z.object({
  version: z.literal(1),
  taskId: z.string().trim().min(1).max(120).optional(),
  objective: z.string().trim().min(1).max(500).optional(),
  featureId: z.string().trim().min(1).max(120).optional(),
  intent: z.string().trim().min(1).max(200).optional(),
  scope: z.object({ allowed: z.array(z.string().trim().min(1)).max(256), forbidden: z.array(z.string().trim().min(1)).max(256).optional() }).strict().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  acceptance: z.array(z.string().trim().min(1)).max(256).optional(),
  contextRefs: z.array(z.string().trim().min(1)).max(256).optional(),
  candidateRevision: z.record(z.string(), z.unknown()).optional(),
  route: implementationRouteSchema,
  assurance: assuranceLevelSchema,
  routeEvidence: z.array(routeEvidenceSchema).min(1).max(16),
  progress: progressSchema,
  workUnits: z.array(workUnitSchema).max(256)
}).strict();

export interface ContractValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ContractValidationFailure {
  ok: false;
  issues: string[];
}

export type ContractValidation<T> = ContractValidationSuccess<T> | ContractValidationFailure;

export class InvalidArchitectureContractError extends Error {
  readonly code = "INVALID_ARCHITECTURE_CONTRACT";

  constructor(message: string) {
    super(`INVALID_ARCHITECTURE_CONTRACT: ${message}`);
    this.name = "InvalidArchitectureContractError";
  }
}

export function createRouteEvidence(route: ImplementationRoute, source: string, statement: string): RouteEvidence;
export function createRouteEvidence(input: RouteEvidence): RouteEvidence;
export function createRouteEvidence(routeOrInput: ImplementationRoute | RouteEvidence, source?: string, statement?: string): RouteEvidence {
  const input = typeof routeOrInput === "string" ? { route: routeOrInput, source, statement } : routeOrInput;
  return assertRouteEvidence(input);
}

export function validateRouteEvidence(value: unknown): ContractValidation<RouteEvidence> {
  const parsed = routeEvidenceSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}

export function assertRouteEvidence(value: unknown): RouteEvidence {
  const result = validateRouteEvidence(value);
  if (!result.ok) throw new InvalidArchitectureContractError(result.issues.join("; "));
  return result.value;
}

export function createIntentDecision(
  intent: string,
  route: ImplementationRoute,
  assurance: AssuranceLevel,
  routeEvidence: RouteEvidence[]
): IntentDecision {
  return assertIntentDecision({ version: 1, intent, route, assurance, routeEvidence });
}

export function validateIntentDecision(value: unknown): ContractValidation<IntentDecision> {
  const parsed = intentDecisionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  return validateDecisionInvariants(parsed.data);
}

export function assertIntentDecision(value: unknown): IntentDecision {
  const result = validateIntentDecision(value);
  if (!result.ok) throw new InvalidArchitectureContractError(result.issues.join("; "));
  return result.value;
}

export function assertIntentDecisionForRoute(value: unknown, route: ImplementationRoute): IntentDecision {
  const decision = assertIntentDecision(value);
  if (decision.route !== route) throw new InvalidArchitectureContractError(`route ${route} does not match decision route ${decision.route}`);
  return decision;
}

export function validateProgress(value: unknown): ContractValidation<Progress> {
  const parsed = progressSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  const sum = parsed.data.completed + parsed.data.inProgress + parsed.data.blocked;
  return sum <= parsed.data.total ? { ok: true, value: parsed.data } : { ok: false, issues: ["progress completed + inProgress + blocked must not exceed total"] };
}

export function assertProgress(value: unknown): Progress {
  const result = validateProgress(value);
  if (!result.ok) throw new InvalidArchitectureContractError(result.issues.join("; "));
  return result.value;
}

export function validateWorkUnit(value: unknown): ContractValidation<WorkUnit> {
  const parsed = workUnitSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}

export function assertWorkUnit(value: unknown): WorkUnit {
  const result = validateWorkUnit(value);
  if (!result.ok) throw new InvalidArchitectureContractError(result.issues.join("; "));
  return result.value;
}

export function validateFeatureCapsule(value: unknown): ContractValidation<FeatureCapsuleV1> {
  const parsed = featureCapsuleV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  if (!parsed.data.featureId && !parsed.data.taskId) return { ok: false, issues: ["featureId or taskId is required"] };
  if (!parsed.data.intent && !parsed.data.objective) return { ok: false, issues: ["intent or objective is required"] };
  const decision = validateDecisionInvariants({ version: 1, intent: parsed.data.intent ?? parsed.data.objective!, route: parsed.data.route, assurance: parsed.data.assurance, routeEvidence: parsed.data.routeEvidence });
  if (!decision.ok) return decision;
  const progress = validateProgress(parsed.data.progress);
  if (!progress.ok) return progress;
  const workUnitIds = new Set<string>();
  for (const workUnit of parsed.data.workUnits) {
    if (workUnitIds.has(workUnit.id)) return { ok: false, issues: [`workUnits contains duplicate id '${workUnit.id}'`] };
    workUnitIds.add(workUnit.id);
  }
  if (parsed.data.progress.total !== parsed.data.workUnits.length) return { ok: false, issues: ["progress.total must equal workUnits.length"] };
  return { ok: true, value: parsed.data };
}

export function assertFeatureCapsule(value: unknown): FeatureCapsuleV1 {
  const result = validateFeatureCapsule(value);
  if (!result.ok) throw new InvalidArchitectureContractError(result.issues.join("; "));
  return result.value;
}

/** Serialize only schema-validated data in a stable, whitespace-free shape. */
export function serializeFeatureCapsule(value: unknown): string {
  const capsule = assertFeatureCapsule(value);
  return JSON.stringify({
    version: capsule.version,
    ...(capsule.taskId ? { taskId: capsule.taskId } : {}),
    ...(capsule.objective ? { objective: capsule.objective } : {}),
    ...(capsule.featureId ? { featureId: capsule.featureId } : {}),
    ...(capsule.intent ? { intent: capsule.intent } : {}),
    ...(capsule.scope ? { scope: capsule.scope } : {}),
    ...(capsule.constraints ? { constraints: capsule.constraints } : {}),
    ...(capsule.acceptance ? { acceptance: capsule.acceptance } : {}),
    ...(capsule.contextRefs ? { contextRefs: capsule.contextRefs } : {}),
    ...(capsule.candidateRevision ? { candidateRevision: capsule.candidateRevision } : {}),
    route: capsule.route,
    assurance: capsule.assurance,
    routeEvidence: capsule.routeEvidence,
    progress: capsule.progress,
    workUnits: capsule.workUnits
  });
}

export function parseFeatureCapsule(serialized: string): FeatureCapsuleV1 {
  try {
    return assertFeatureCapsule(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof InvalidArchitectureContractError) throw error;
    throw new InvalidArchitectureContractError("serialized capsule is not valid JSON");
  }
}

export const deserializeFeatureCapsule = parseFeatureCapsule;

function validateDecisionInvariants(value: IntentDecision): ContractValidation<IntentDecision> {
  const mismatches = value.routeEvidence.filter((evidence) => evidence.route !== value.route);
  if (mismatches.length > 0) return { ok: false, issues: ["every route evidence item must support the selected route"] };
  return { ok: true, value };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`);
}
