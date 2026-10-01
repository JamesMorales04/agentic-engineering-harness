import { z } from "zod";
export const implementationRouteValues = ["NO_AGENT", "DIRECT", "DELEGATED", "FORMAL_SDD"];
export const implementationRouteSchema = z.enum(implementationRouteValues);
export const assuranceLevelValues = ["NONE", "STANDARD", "ELEVATED", "CRITICAL"];
export const assuranceLevelSchema = z.enum(assuranceLevelValues);
export const workUnitStatusValues = ["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"];
export const workUnitStatusSchema = z.enum(workUnitStatusValues);
export const routeEvidenceSchema = z.object({
    route: implementationRouteSchema,
    source: z.string().trim().min(1).max(120),
    statement: z.string().trim().min(1).max(1_000)
}).strict();
export const intentDecisionSchema = z.object({
    version: z.literal(1),
    intent: z.string().trim().min(1).max(200),
    route: implementationRouteSchema,
    assurance: assuranceLevelSchema,
    routeEvidence: z.array(routeEvidenceSchema).min(1).max(16)
}).strict();
export const progressSchema = z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative()
}).strict();
export const workUnitSchema = z.object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    status: workUnitStatusSchema,
    dependsOn: z.array(z.string().trim().min(1).max(120)).max(32).optional()
}).strict();
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
export class InvalidArchitectureContractError extends Error {
    code = "INVALID_ARCHITECTURE_CONTRACT";
    constructor(message) {
        super(`INVALID_ARCHITECTURE_CONTRACT: ${message}`);
        this.name = "InvalidArchitectureContractError";
    }
}
export function createRouteEvidence(routeOrInput, source, statement) {
    const input = typeof routeOrInput === "string" ? { route: routeOrInput, source, statement } : routeOrInput;
    return assertRouteEvidence(input);
}
export function validateRouteEvidence(value) {
    const parsed = routeEvidenceSchema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}
export function assertRouteEvidence(value) {
    const result = validateRouteEvidence(value);
    if (!result.ok)
        throw new InvalidArchitectureContractError(result.issues.join("; "));
    return result.value;
}
export function createIntentDecision(intent, route, assurance, routeEvidence) {
    return assertIntentDecision({ version: 1, intent, route, assurance, routeEvidence });
}
export function validateIntentDecision(value) {
    const parsed = intentDecisionSchema.safeParse(value);
    if (!parsed.success)
        return { ok: false, issues: formatIssues(parsed.error) };
    return validateDecisionInvariants(parsed.data);
}
export function assertIntentDecision(value) {
    const result = validateIntentDecision(value);
    if (!result.ok)
        throw new InvalidArchitectureContractError(result.issues.join("; "));
    return result.value;
}
export function assertIntentDecisionForRoute(value, route) {
    const decision = assertIntentDecision(value);
    if (decision.route !== route)
        throw new InvalidArchitectureContractError(`route ${route} does not match decision route ${decision.route}`);
    return decision;
}
export function validateProgress(value) {
    const parsed = progressSchema.safeParse(value);
    if (!parsed.success)
        return { ok: false, issues: formatIssues(parsed.error) };
    const sum = parsed.data.completed + parsed.data.inProgress + parsed.data.blocked;
    return sum <= parsed.data.total ? { ok: true, value: parsed.data } : { ok: false, issues: ["progress completed + inProgress + blocked must not exceed total"] };
}
export function assertProgress(value) {
    const result = validateProgress(value);
    if (!result.ok)
        throw new InvalidArchitectureContractError(result.issues.join("; "));
    return result.value;
}
export function validateWorkUnit(value) {
    const parsed = workUnitSchema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}
export function assertWorkUnit(value) {
    const result = validateWorkUnit(value);
    if (!result.ok)
        throw new InvalidArchitectureContractError(result.issues.join("; "));
    return result.value;
}
export function validateFeatureCapsule(value) {
    const parsed = featureCapsuleV1Schema.safeParse(value);
    if (!parsed.success)
        return { ok: false, issues: formatIssues(parsed.error) };
    if (!parsed.data.featureId && !parsed.data.taskId)
        return { ok: false, issues: ["featureId or taskId is required"] };
    if (!parsed.data.intent && !parsed.data.objective)
        return { ok: false, issues: ["intent or objective is required"] };
    const decision = validateDecisionInvariants({ version: 1, intent: parsed.data.intent ?? parsed.data.objective, route: parsed.data.route, assurance: parsed.data.assurance, routeEvidence: parsed.data.routeEvidence });
    if (!decision.ok)
        return decision;
    const progress = validateProgress(parsed.data.progress);
    if (!progress.ok)
        return progress;
    const workUnitIds = new Set();
    for (const workUnit of parsed.data.workUnits) {
        if (workUnitIds.has(workUnit.id))
            return { ok: false, issues: [`workUnits contains duplicate id '${workUnit.id}'`] };
        workUnitIds.add(workUnit.id);
    }
    if (parsed.data.progress.total !== parsed.data.workUnits.length)
        return { ok: false, issues: ["progress.total must equal workUnits.length"] };
    return { ok: true, value: parsed.data };
}
export function assertFeatureCapsule(value) {
    const result = validateFeatureCapsule(value);
    if (!result.ok)
        throw new InvalidArchitectureContractError(result.issues.join("; "));
    return result.value;
}
/** Serialize only schema-validated data in a stable, whitespace-free shape. */
export function serializeFeatureCapsule(value) {
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
export function parseFeatureCapsule(serialized) {
    try {
        return assertFeatureCapsule(JSON.parse(serialized));
    }
    catch (error) {
        if (error instanceof InvalidArchitectureContractError)
            throw error;
        throw new InvalidArchitectureContractError("serialized capsule is not valid JSON");
    }
}
export const deserializeFeatureCapsule = parseFeatureCapsule;
function validateDecisionInvariants(value) {
    const mismatches = value.routeEvidence.filter((evidence) => evidence.route !== value.route);
    if (mismatches.length > 0)
        return { ok: false, issues: ["every route evidence item must support the selected route"] };
    return { ok: true, value };
}
function formatIssues(error) {
    return error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`);
}
//# sourceMappingURL=contracts.js.map