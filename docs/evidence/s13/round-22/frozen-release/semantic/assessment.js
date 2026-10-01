import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { executionSelectionForAgent } from "../agents/routing.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { changeKindSchema } from "../architecture/workGraph.js";
import { candidateReviewDimensionValues } from "../architecture/candidateAssurance.js";
import { assertSemanticStructuredOutputCapabilityV1 } from "./structuredOutput.js";
export const semanticAssessmentTypeValues = ["INTENT", "ROUTE", "STACK", "ISSUE", "FAILURE", "CANDIDATE_IMPACT", "VALIDATION_NEED"];
export const semanticAssessmentTypeSchema = z.enum(semanticAssessmentTypeValues);
export const reasoningClassValues = ["LIGHT", "STANDARD", "DEEP"];
export const reasoningClassSchema = z.enum(reasoningClassValues);
export const assessmentContextClassValues = ["SMALL", "STANDARD", "LARGE"];
export const assessmentContextClassSchema = z.enum(assessmentContextClassValues);
export const assessmentRiskClassValues = ["LOW", "STANDARD", "HIGH", "CRITICAL"];
export const assessmentRiskClassSchema = z.enum(assessmentRiskClassValues);
export const decisionMechanismValues = ["DETERMINISTIC", "MODEL", "HYBRID"];
export const decisionMechanismSchema = z.enum(decisionMechanismValues);
export const semanticAssessmentBindingV1Schema = z.object({
    projectId: z.string().trim().min(1).max(200),
    repositoryDigest: z.string().trim().min(1).max(200),
    repositoryRootDigest: z.string().trim().min(1).max(200).optional(),
    operationId: z.string().trim().min(1).max(200).optional(),
    candidateId: z.string().trim().min(1).max(200).optional(),
    candidateRevision: z.number().int().positive().optional(),
    candidateDigest: z.string().trim().min(1).max(200).optional(),
    intentDigest: z.string().trim().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
    const candidateFields = [value.candidateId, value.candidateRevision, value.candidateDigest];
    if (candidateFields.some((field) => field !== undefined) && candidateFields.some((field) => field === undefined)) {
        context.addIssue({ code: "custom", path: ["candidateDigest"], message: "candidateId, candidateRevision, and candidateDigest must be bound together" });
    }
});
export const semanticEvidenceReceiptKindValues = ["REQUEST", "OBSERVED_FACT", "REPOSITORY_FILE", "CANDIDATE_FILE", "OPERATION_ARTIFACT"];
const semanticEvidenceReceiptShape = z.object({
    version: z.literal(1),
    reader: z.literal("aeh-controller-v1"),
    kind: z.enum(semanticEvidenceReceiptKindValues),
    ref: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(500).optional(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentBytes: z.number().int().nonnegative().max(24_000),
    boundaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export function semanticEvidenceBoundaryDigest(binding) {
    return sha256Canonical({
        projectId: binding.projectId,
        repositoryDigest: binding.repositoryDigest,
        repositoryRootDigest: binding.repositoryRootDigest ?? null,
        operationId: binding.operationId ?? null,
        candidateId: binding.candidateId ?? null,
        candidateRevision: binding.candidateRevision ?? null,
        candidateDigest: binding.candidateDigest ?? null
    });
}
/** Create a receipt for exact controller-supplied bytes; file callers must first enforce the repository/candidate read boundary. */
export function createSemanticEvidenceReceiptV1(input) {
    const normalizedPath = input.path === undefined ? undefined : normalizeEvidencePath(input.path);
    if ((input.kind === "REPOSITORY_FILE" || input.kind === "CANDIDATE_FILE") && !normalizedPath) {
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${input.kind} receipts require a normalized repository-relative path.`);
    }
    if (normalizedPath && input.ref !== `file:${normalizedPath}`)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "repository file evidence refs must equal file:<normalized path>.");
    const base = {
        version: 1,
        reader: "aeh-controller-v1",
        kind: input.kind,
        ref: input.ref,
        ...(normalizedPath ? { path: normalizedPath } : {}),
        contentDigest: sha256Utf8(input.content),
        contentBytes: Buffer.byteLength(input.content, "utf8"),
        boundaryDigest: semanticEvidenceBoundaryDigest(input.binding)
    };
    if (base.contentBytes > 24_000)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic evidence exceeds the controller receipt byte bound.");
    return { ...base, receiptDigest: sha256Canonical(base) };
}
const assessmentRequirementSchema = z.object({
    reasoningClass: reasoningClassSchema,
    structuredOutputRequired: z.boolean(),
    independenceRequired: z.boolean(),
    externalKnowledgeRequired: z.boolean(),
    maxContextClass: assessmentContextClassSchema,
    riskClass: assessmentRiskClassSchema
}).strict();
export const semanticAssessmentRequestV1Schema = z.object({
    version: z.literal(1),
    assessmentType: semanticAssessmentTypeSchema,
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
    compactEvidence: z.array(z.object({ ref: z.string().trim().min(1).max(200), content: z.string().min(1).max(4_000) }).strict()).min(1).max(16),
    evidenceReceipts: z.array(semanticEvidenceReceiptShape).min(1).max(32),
    requiredOutputSchema: z.literal("semantic-assessment-v1"),
    reasoningRequirement: assessmentRequirementSchema,
    binding: semanticAssessmentBindingV1Schema,
    budget: z.object({ maxInputTokens: z.number().int().positive().max(32_000).optional(), maxOutputTokens: z.number().int().positive().max(8_000).optional(), deadlineMs: z.number().int().positive().max(300_000).optional() }).strict(),
    policyRevision: z.string().trim().min(1).max(200)
}).strict().superRefine((value, context) => {
    const refs = new Set(value.compactEvidence.map((item) => item.ref));
    const receiptRefs = new Set(value.evidenceReceipts.map((item) => item.ref));
    if (refs.size !== value.compactEvidence.length)
        context.addIssue({ code: "custom", path: ["compactEvidence"], message: "evidence refs must be unique" });
    if (receiptRefs.size !== value.evidenceReceipts.length)
        context.addIssue({ code: "custom", path: ["evidenceReceipts"], message: "evidence receipt refs must be unique" });
    if (value.evidenceRefs.length !== refs.size || value.evidenceRefs.some((ref) => !refs.has(ref) || !receiptRefs.has(ref)))
        context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "evidenceRefs, compactEvidence, and evidenceReceipts must have the same refs" });
    if (receiptRefs.size !== refs.size || [...receiptRefs].some((ref) => !refs.has(ref)))
        context.addIssue({ code: "custom", path: ["evidenceReceipts"], message: "every evidence receipt must identify exactly one supplied evidence item" });
    const bytes = value.compactEvidence.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
    if (bytes > 24_000)
        context.addIssue({ code: "custom", path: ["compactEvidence"], message: "compact evidence exceeds the 24000-byte bound" });
});
export const candidateReviewDimensionSchema = z.enum(candidateReviewDimensionValues);
const claimStatusValues = ["SUPPORTED", "UNCERTAIN", "CONFLICTING"];
const semanticFailureClassValues = ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"];
const evidenceRefSchema = z.string().trim().min(1).max(200);
const semanticJudgmentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("INTENT"), intent: z.enum(["informational", "audit", "change"]), confidence: z.number().min(0).max(1), evidenceRefs: z.array(evidenceRefSchema).min(1).max(32) }).strict(),
    z.object({
        type: z.literal("ROUTE"),
        recommendedRoute: z.enum(["DIRECT", "DELEGATED", "FORMAL_SDD"]),
        scopeClarity: z.enum(["LOW", "MEDIUM", "HIGH"]),
        decompositionNeed: z.boolean(),
        coordinationNeed: z.boolean(),
        architectureUncertainty: z.boolean(),
        productUncertainty: z.boolean(),
        formalizationNeed: z.enum(["NONE", "RECOMMENDED", "REQUIRED"]),
        semanticRiskSignals: z.array(z.string().trim().min(1).max(500)).max(32),
        evidenceRefs: z.array(evidenceRefSchema).min(1).max(32),
        unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
    }).strict(),
    z.object({ type: z.literal("FAILURE"), classification: z.enum(semanticFailureClassValues), evidenceRefs: z.array(evidenceRefSchema).min(1).max(32) }).strict(),
    z.object({
        type: z.literal("STACK"),
        languages: z.array(z.string().trim().min(1).max(100)).max(16),
        frameworks: z.array(z.string().trim().min(1).max(200)).max(64),
        packageManagers: z.array(z.string().trim().min(1).max(200)).max(32),
        databases: z.array(z.string().trim().min(1).max(200)).max(32),
        toolchains: z.array(z.string().trim().min(1).max(200)).max(64),
        signals: z.array(z.object({ id: z.string().trim().min(1).max(200), evidenceRef: evidenceRefSchema }).strict()).max(128),
        testFrameworks: z.array(z.string().trim().min(1).max(200)).max(32),
        migrationMechanisms: z.array(z.string().trim().min(1).max(200)).max(32),
        buildSystems: z.array(z.string().trim().min(1).max(200)).max(32),
        versions: z.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(200)),
        projectSkillRoots: z.array(z.string().min(1).max(200)).max(64),
        evidenceRefs: z.array(evidenceRefSchema).min(1).max(128),
        unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
    }).strict(),
    z.object({
        type: z.literal("ISSUE"),
        classification: z.enum(["ready", "requires_product_decision", "spec_contradiction"]),
        requestedOutcome: z.string().trim().min(1).max(2_000),
        explicitRequirements: z.array(z.object({ statement: z.string().trim().min(1).max(2_000), evidenceRefs: z.array(evidenceRefSchema).min(1).max(16) }).strict()).max(64),
        evidenceRefs: z.array(evidenceRefSchema).min(1).max(128),
        unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
    }).strict(),
    z.object({
        type: z.literal("CANDIDATE_IMPACT"),
        changedFiles: z.array(z.string().trim().min(1).max(500)).max(256),
        changeKinds: z.array(changeKindSchema).max(32),
        reviewDimensions: z.array(candidateReviewDimensionSchema).max(32),
        requiresIndependentReview: z.boolean(),
        evidenceRefs: z.array(evidenceRefSchema).min(1).max(512),
        unknowns: z.array(z.string().trim().min(1).max(1_000)).max(64)
    }).strict(),
    z.object({
        type: z.literal("VALIDATION_NEED"),
        property: z.string().trim().min(1).max(500),
        rationale: z.string().trim().min(1).max(1_000),
        scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
        evidenceRefs: z.array(evidenceRefSchema).min(1).max(64),
        unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
    }).strict()
]);
export const semanticAssessmentPayloadV1Schema = z.object({
    judgment: semanticJudgmentSchema,
    claims: z.array(z.object({ id: z.string().trim().min(1).max(100), statement: z.string().trim().min(1).max(2_000), status: z.enum(claimStatusValues), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(64),
    assumptions: z.array(z.string().trim().min(1).max(1_000)).max(32),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32),
    recommendations: z.array(z.object({ id: z.string().trim().min(1).max(100), statement: z.string().trim().min(1).max(2_000), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(32),
    knowledgeGaps: z.array(z.object({ competency: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1_000), blocking: z.boolean(), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(32)
}).strict().superRefine((value, context) => {
    for (const [index, claim] of value.claims.entries()) {
        if (claim.status !== "UNCERTAIN" && claim.evidenceRefs.length === 0)
            context.addIssue({ code: "custom", path: ["claims", index, "evidenceRefs"], message: "supported or conflicting claims require evidence references" });
    }
    for (const [index, recommendation] of value.recommendations.entries()) {
        if (recommendation.evidenceRefs.length === 0)
            context.addIssue({ code: "custom", path: ["recommendations", index, "evidenceRefs"], message: "recommendations require evidence references" });
    }
});
export class InMemorySemanticAssessmentCacheV1 {
    values = new Map();
    async get(key) { return this.values.get(key); }
    async set(key, value) { this.values.set(key, value); }
}
/** Durable controller-owned storage for complete, provenance-bearing assessments. */
export class FileSemanticAssessmentCacheV1 {
    directory;
    constructor(root) {
        this.directory = path.resolve(root, ".harness", "cache", "semantic-assessments-v1");
    }
    async get(key) {
        if (!/^[a-f0-9]{64}$/.test(key))
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic cache key must be a SHA-256 digest.");
        const file = path.join(this.directory, `${key}.json`);
        let stat;
        try {
            stat = await fs.lstat(file);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `unable to inspect semantic cache entry ${key}.`, { cause: error });
        }
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `semantic cache entry ${key} is not a regular file.`);
        try {
            return JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch (error) {
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `semantic cache entry ${key} is malformed.`, { cause: error });
        }
    }
    async set(key, value) {
        if (!/^[a-f0-9]{64}$/.test(key) || value.cacheIdentity !== key)
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic cache entry key does not match its canonical identity.");
        await fs.mkdir(this.directory, { recursive: true });
        const file = path.join(this.directory, `${key}.json`);
        const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        try {
            await fs.rename(temporary, file);
        }
        catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
/**
 * Bounded, sanitized fingerprint of a rejected raw model reply. It records length, digest and a
 * short control-character-free prefix so the next assessor failure is diagnosable without
 * persisting or re-interpreting raw model prose.
 */
export function semanticReplyFingerprintV1(raw) {
    const sanitized = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    return { version: 1, lengthBytes: Buffer.byteLength(raw, "utf8"), sha256: sha256Utf8(raw), head: sanitized.slice(0, 200) };
}
export function semanticReplyDiagnosticV1(diagnostic) {
    const parts = [];
    if (diagnostic.sessionId)
        parts.push(`assessorSession=${diagnostic.sessionId}`);
    if (diagnostic.fingerprint)
        parts.push(`replyBytes=${diagnostic.fingerprint.lengthBytes}`, `replySha256=${diagnostic.fingerprint.sha256}`, `replyHead=${JSON.stringify(diagnostic.fingerprint.head)}`);
    return parts.length ? ` [${parts.join(" ")}]` : "";
}
export const semanticCapabilityPolicyRevisionV1 = "core-semantic-capability-policy-v1";
const SEMANTIC_THINKING_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const SEMANTIC_THINKING_BY_REASONING_CLASS = { LIGHT: "low", STANDARD: "medium", DEEP: "high" };
/**
 * Bound a topology-configured Paseo thinking option by the request's declared reasoning class.
 * The topology remains the upper bound; the assessment request cannot raise reasoning above it.
 * Deterministic and provider-appropriate: LIGHT requests must not launch a max-reasoning turn.
 */
export function boundSemanticThinkingOptionV1(variant, reasoningClass) {
    if (!variant)
        return undefined;
    const configured = SEMANTIC_THINKING_RANK.indexOf(variant);
    const wanted = SEMANTIC_THINKING_RANK.indexOf(SEMANTIC_THINKING_BY_REASONING_CLASS[reasoningClass]);
    if (configured < 0)
        return SEMANTIC_THINKING_BY_REASONING_CLASS[reasoningClass];
    return SEMANTIC_THINKING_RANK[Math.min(configured, wanted)];
}
/** Model-backed semantic assessment deadline that accommodates a cold real provider launch (Paseo + CLI agent) without weakening any authority or acceptance semantics. */
export const semanticModelDeadlineMsV1 = 300_000;
/**
 * Bounded retry for non-authoritative invalid model output. A real local model occasionally
 * returns prose, truncated JSON, or a schema-incomplete payload; one bounded re-ask is allowed
 * before the assessment fails closed. Provider unavailability, policy, evidence, and authority
 * failures are never retried.
 */
export const MAX_SEMANTIC_PAYLOAD_ATTEMPTS = 2;
export const semanticCapabilityPolicyV1 = {
    INTENT: { maxInputTokens: 4_000, maxOutputTokens: 1_000, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "STANDARD", maxContextClass: "SMALL", maxRiskClass: "HIGH" },
    ROUTE: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "DEEP", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
    STACK: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "STANDARD", maxContextClass: "LARGE", maxRiskClass: "HIGH" },
    ISSUE: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
    FAILURE: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
    CANDIDATE_IMPACT: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "DEEP", maxContextClass: "LARGE", maxRiskClass: "CRITICAL" },
    VALIDATION_NEED: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: semanticModelDeadlineMsV1, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" }
};
export function resolveSemanticAssessor(topology) {
    const configured = Object.values(topology.agents).filter((agent) => agent.role === "Semantic Assessor" && !agent.disabled).sort((left, right) => left.name.localeCompare(right.name));
    if (configured.length !== 1)
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `AgentTopology must resolve exactly one enabled Semantic Assessor; found ${configured.length}.`);
    const agent = configured[0];
    const selection = executionSelectionForAgent(topology, agent.name);
    const capabilityIssues = validateExecutionCapabilities(selection, "paseo");
    if (capabilityIssues.length)
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", capabilityIssues.join("; "));
    const permissions = selection.permissions;
    const requiredDenied = ["read", "write", "shell", "network", "delegate", "review", "validate", "gitWrite"];
    const permissionIssues = requiredDenied.filter((key) => permissions[key] !== "deny");
    if (permissionIssues.length)
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `Semantic Assessor permissions must explicitly deny ${permissionIssues.join(", ")}.`);
    if (selection.transport !== "paseo" || selection.runtimeAdapter !== "opencode" || selection.paseoProvider !== "opencode")
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor requires the AEH-managed OpenCode runtime through Paseo.");
    if (selection.runtimeCapabilities.runtimeConfigInjection !== true || selection.runtimeCapabilities.structuredOutput !== true || selection.runtimeCapabilities.modelSelection !== true)
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor runtime must support AEH permission projection, topology model selection, and structured output.");
    // Runtime-level `structuredOutput` is not proof for every model behind the runtime. The resolved
    // assessor model must hold a certified structured-output capability at the required level, so an
    // ineligible model fails closed before execution instead of silently falling back.
    assertSemanticStructuredOutputCapabilityV1(selection.modelId);
    if (selection.nativeAgent || selection.skills.length || selection.mcps.length || selection.args.length || agent.capabilities?.length || agent.orchestratorPromptPath)
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology cannot select external agents, tools, skills, capabilities, runtime arguments, or orchestrator prompts.");
    if (selection.outputContract !== "semantic-assessment")
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology must use the semantic-assessment output contract.");
    const contextRequirements = agent.contextRequirements;
    if (!contextRequirements || [contextRequirements.repositoryMap, contextRequirements.semanticRetrieval, contextRequirements.rawRetrieval, contextRequirements.compression].some((value) => value !== "FORBIDDEN"))
        throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology must forbid repository maps, retrieval, raw reads, and compression tools.");
    const identityBase = {
        version: 1,
        role: "Semantic Assessor",
        logicalAgent: agent.name,
        ...(topology.profile ? { topologyProfile: topology.profile } : {}),
        modelAlias: selection.modelAlias,
        modelId: selection.modelId,
        modelName: selection.modelName,
        ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
        runtimeName: selection.runtimeName,
        runtimeAdapter: selection.runtimeAdapter,
        paseoProvider: selection.paseoProvider,
        ...(selection.variant ? { variant: selection.variant } : {})
    };
    return { identity: { ...identityBase, identityDigest: sha256Canonical(identityBase) }, selection };
}
const rank = { LIGHT: 0, STANDARD: 1, DEEP: 2 };
const contextRank = { SMALL: 0, STANDARD: 1, LARGE: 2 };
const riskRank = { LOW: 0, STANDARD: 1, HIGH: 2, CRITICAL: 3 };
function validateRequestPolicy(request, policyRevision) {
    const limit = semanticCapabilityPolicyV1[request.assessmentType];
    const requirement = request.reasoningRequirement;
    if (request.policyRevision !== policyRevision || request.policyRevision !== semanticCapabilityPolicyRevisionV1)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "request policy revision is stale or does not match the deterministic semantic capability policy.");
    if (!requirement.structuredOutputRequired || requirement.independenceRequired || requirement.externalKnowledgeRequired)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic assessments require structured output and cannot request independence or external knowledge.");
    if (rank[requirement.reasoningClass] > rank[limit.maxReasoningClass] || contextRank[requirement.maxContextClass] > contextRank[limit.maxContextClass] || riskRank[requirement.riskClass] > riskRank[limit.maxRiskClass])
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} exceeds the deterministic semantic capability policy.`);
    if ((request.budget.maxInputTokens ?? limit.maxInputTokens) > limit.maxInputTokens || (request.budget.maxOutputTokens ?? limit.maxOutputTokens) > limit.maxOutputTokens || (request.budget.deadlineMs ?? limit.maxDeadlineMs) > limit.maxDeadlineMs)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} exceeds the deterministic semantic assessment budget.`);
}
function validateEvidenceReceipts(request) {
    const evidence = new Map(request.compactEvidence.map((item) => [item.ref, item.content]));
    for (const receipt of request.evidenceReceipts) {
        const content = evidence.get(receipt.ref);
        if (content === undefined)
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} has no supplied content.`);
        if (receipt.contentDigest !== sha256Utf8(content) || receipt.contentBytes !== Buffer.byteLength(content, "utf8"))
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} does not bind the exact supplied bytes.`);
        if (receipt.boundaryDigest !== semanticEvidenceBoundaryDigest(request.binding))
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} is outside the bound repository/candidate boundary.`);
        if (receipt.receiptDigest !== semanticEvidenceReceiptDigest(receipt))
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} digest is invalid.`);
        if ((receipt.kind === "REPOSITORY_FILE" || receipt.kind === "CANDIDATE_FILE") && (!receipt.path || normalizeEvidencePath(receipt.path) !== receipt.path || receipt.ref !== `file:${receipt.path}`))
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `file evidence receipt ${receipt.ref} has no matching normalized path.`);
    }
}
export function semanticEvidenceReceiptDigest(receipt) {
    const { receiptDigest: _ignored, ...body } = receipt;
    return sha256Canonical(body);
}
export function semanticAssessmentEvidenceDigest(request) {
    return sha256Canonical({
        refs: [...request.evidenceRefs].sort(),
        evidence: [...request.compactEvidence].sort((left, right) => left.ref.localeCompare(right.ref)),
        receipts: [...request.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref))
    });
}
export class SemanticAssessmentServiceV1 {
    options;
    cache;
    constructor(options) {
        this.options = options;
        if (!options.policyRevision.trim())
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic assessment policyRevision must be non-empty.");
        this.cache = options.cache ?? new InMemorySemanticAssessmentCacheV1();
    }
    async assess(request, options = {}) {
        const attemptBudget = options.attemptBudget ?? MAX_SEMANTIC_PAYLOAD_ATTEMPTS;
        if (!Number.isSafeInteger(attemptBudget) || attemptBudget < 1 || attemptBudget > MAX_SEMANTIC_PAYLOAD_ATTEMPTS)
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `semantic assessment attemptBudget must be an integer in [1, ${MAX_SEMANTIC_PAYLOAD_ATTEMPTS}].`);
        const parsed = semanticAssessmentRequestV1Schema.safeParse(request);
        if (!parsed.success)
            throw new AehError("SEMANTIC_ASSESSMENT_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
        const normalizedRequest = {
            ...parsed.data,
            evidenceRefs: [...parsed.data.evidenceRefs].sort((left, right) => left.localeCompare(right)),
            compactEvidence: [...parsed.data.compactEvidence].sort((left, right) => left.ref.localeCompare(right.ref)),
            evidenceReceipts: [...parsed.data.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref))
        };
        validateRequestPolicy(normalizedRequest, this.options.policyRevision);
        validateEvidenceReceipts(normalizedRequest);
        const evidenceDigest = semanticAssessmentEvidenceDigest(normalizedRequest);
        const cacheIdentity = sha256Canonical({ version: 1, assessmentType: normalizedRequest.assessmentType, evidenceDigest, binding: normalizedRequest.binding, policyRevision: normalizedRequest.policyRevision, assessorDigest: this.options.assessor.identity.identityDigest, requirement: normalizedRequest.reasoningRequirement, budget: normalizedRequest.budget });
        const cached = await this.cache.get(cacheIdentity);
        if (cached) {
            const validated = validateCachedAssessment(cached, normalizedRequest, this.options.assessor.identity, evidenceDigest, cacheIdentity);
            const result = { ...validated, cacheDisposition: "HIT" };
            await this.emitTelemetry(result, true);
            return result;
        }
        let lastInvalid;
        for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
            let run;
            const repair = attempt > 1 && lastInvalid
                ? {
                    attempt,
                    reason: [
                        `The previous reply was rejected: ${lastInvalid.message.slice(0, 400)}`,
                        `Return exactly one JSON object whose judgment.type is "${normalizedRequest.assessmentType}", includes every required field (including unknowns as an array), and whose evidenceRefs cite only these supplied refs: ${normalizedRequest.evidenceRefs.join(", ")}.`,
                        "Do not invent evidence refs and do not choose a different judgment type."
                    ].join(" ")
                }
                : undefined;
            try {
                run = await this.options.runner.assess({ request: normalizedRequest, assessor: this.options.assessor.identity, ...(repair ? { repair } : {}) });
            }
            catch (error) {
                if (!(error instanceof AehError))
                    throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `Paseo Semantic Assessor execution failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                // Bounded retry for non-authoritative invalid model output (unparseable or schema-invalid)
                // and for a real provider turn that hung past its deadline (a stuck read-only assessor
                // session is retried once). The runner classifies the timeout typed in the error details;
                // message text is never parsed for control. Other unavailability/authority failures are
                // never retried.
                const timeoutUnavailable = error.code === "SEMANTIC_ASSESSMENT_UNAVAILABLE" && error.details?.timeout === true;
                if ((error.code === "SEMANTIC_ASSESSMENT_INVALID" || timeoutUnavailable) && attempt < attemptBudget) {
                    lastInvalid = error;
                    continue;
                }
                throw error;
            }
            let payload;
            try {
                const payloadResult = semanticAssessmentPayloadV1Schema.safeParse(run.payload);
                if (!payloadResult.success)
                    throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "Paseo Semantic Assessor returned an invalid non-authoritative structured assessment payload.", { cause: payloadResult.error });
                payload = normalizePayloadUnknowns(payloadResult.data);
                validateAssessmentPayload(payload, normalizedRequest);
                validateSessionIdentity(run.paseoSession, this.options.assessor.identity);
            }
            catch (error) {
                if (error instanceof AehError && error.code === "SEMANTIC_ASSESSMENT_INVALID") {
                    const diagnosed = attachReplyDiagnostics(error, run);
                    if (attempt < attemptBudget) {
                        lastInvalid = diagnosed;
                        continue;
                    }
                    throw diagnosed;
                }
                throw error;
            }
            const assessmentDigest = semanticAssessmentDigest(normalizedRequest, evidenceDigest, this.options.assessor.identity, run.paseoSession, cacheIdentity, payload);
            const result = {
                version: 1,
                assessmentType: normalizedRequest.assessmentType,
                mechanism: "MODEL",
                binding: normalizedRequest.binding,
                policyRevision: normalizedRequest.policyRevision,
                ...payload,
                evidenceRefs: [...normalizedRequest.evidenceRefs],
                evidenceReceipts: structuredClone(normalizedRequest.evidenceReceipts),
                evidenceDigest,
                assessor: this.options.assessor.identity,
                paseoSession: run.paseoSession,
                assessmentDigest,
                cacheIdentity,
                cacheDisposition: "FRESH"
            };
            await this.cache.set(cacheIdentity, result);
            await this.emitTelemetry(result, false);
            return result;
        }
        throw lastInvalid ?? new AehError("SEMANTIC_ASSESSMENT_INVALID", "Paseo Semantic Assessor returned an invalid non-authoritative structured assessment payload after bounded attempts.");
    }
    async emitTelemetry(result, cacheHit) {
        await this.options.onTelemetry?.({ assessmentType: result.assessmentType, assessorId: result.assessor.logicalAgent, paseoAgentId: result.paseoSession.agentId, evidenceDigest: result.evidenceDigest, assessmentDigest: result.assessmentDigest, cacheHit });
    }
}
function attachReplyDiagnostics(error, run) {
    const sessionId = run.paseoSession?.agentId;
    const diagnostic = semanticReplyDiagnosticV1({ ...(sessionId ? { sessionId } : {}), ...(run.rawReply ? { fingerprint: run.rawReply } : {}) });
    if (!diagnostic)
        return error;
    const message = error.message.includes("assessorSession=") ? error.message : `${error.message}${diagnostic}`;
    return new AehError(error.code, message, {
        cause: error,
        details: {
            ...(error.details ?? {}),
            ...(sessionId ? { sessionId } : {}),
            ...(run.rawReply ? { fingerprint: run.rawReply } : {})
        }
    });
}
function validateSessionIdentity(session, assessor) {
    if (!session || session.provider !== assessor.paseoProvider || !session.agentId?.trim() || !["sdk", "cli"].includes(session.transport))
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "Paseo execution did not return a valid actual session identity for the selected AEH Semantic Assessor.");
}
function normalizePayloadUnknowns(payload) {
    const judgmentUnknowns = "unknowns" in payload.judgment ? payload.judgment.unknowns : [];
    return { ...payload, unknowns: [...new Set([...payload.unknowns, ...judgmentUnknowns])].sort() };
}
function validateAssessmentPayload(payload, request) {
    if (payload.judgment.type !== request.assessmentType)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} assessments require a typed ${request.assessmentType} judgment.`);
    const refs = [
        ...payload.judgment.evidenceRefs,
        ...(payload.judgment.type === "STACK" ? payload.judgment.signals.map((signal) => signal.evidenceRef) : []),
        ...(payload.judgment.type === "ISSUE" ? payload.judgment.explicitRequirements.flatMap((requirement) => requirement.evidenceRefs) : []),
        ...payload.claims.flatMap((claim) => claim.evidenceRefs),
        ...payload.recommendations.flatMap((recommendation) => recommendation.evidenceRefs),
        ...payload.knowledgeGaps.flatMap((gap) => gap.evidenceRefs)
    ];
    if (!refs.length || refs.some((ref) => !request.evidenceRefs.includes(ref)))
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "typed judgment or assessment payload referenced evidence outside the request evidence.");
    const judgmentRefs = new Set(payload.judgment.evidenceRefs);
    const nestedRefs = [
        ...(payload.judgment.type === "STACK" ? payload.judgment.signals.map((signal) => signal.evidenceRef) : []),
        ...(payload.judgment.type === "ISSUE" ? payload.judgment.explicitRequirements.flatMap((requirement) => requirement.evidenceRefs) : [])
    ];
    if (nestedRefs.some((ref) => !judgmentRefs.has(ref)))
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "nested typed judgments must list every evidence reference in their top-level evidenceRefs.");
}
function semanticAssessmentDigest(request, evidenceDigest, assessor, paseoSession, cacheIdentity, payload) {
    return sha256Canonical({ version: 1, mechanism: "MODEL", assessmentType: request.assessmentType, evidenceRefs: request.evidenceRefs, evidenceDigest, binding: request.binding, policyRevision: request.policyRevision, assessor, paseoSession, cacheIdentity, payload });
}
function validateCachedAssessment(cached, request, assessor, evidenceDigest, cacheIdentity) {
    try {
        const { version: _version, assessmentType: _type, mechanism: _mechanism, binding: _binding, policyRevision: _policy, evidenceRefs: _refs, evidenceReceipts: _receipts, evidenceDigest: _evidenceDigest, assessor: _assessor, paseoSession, assessmentDigest: _digest, cacheIdentity: _cacheIdentity, cacheDisposition: _disposition, ...rawPayload } = cached;
        const payload = normalizePayloadUnknowns(semanticAssessmentPayloadV1Schema.parse(rawPayload));
        validateAssessmentPayload(payload, request);
        validateEvidenceReceipts(request);
        const expectedDigest = semanticAssessmentDigest(request, evidenceDigest, assessor, paseoSession, cacheIdentity, payload);
        if (cached.version !== 1 || cached.mechanism !== "MODEL" || cached.assessmentType !== request.assessmentType || sha256Canonical(cached.binding) !== sha256Canonical(request.binding) || cached.policyRevision !== request.policyRevision || sha256Canonical(cached.evidenceRefs) !== sha256Canonical(request.evidenceRefs) || cached.evidenceDigest !== evidenceDigest || sha256Canonical(cached.evidenceReceipts) !== sha256Canonical(request.evidenceReceipts) || cached.assessmentDigest !== expectedDigest || cached.cacheIdentity !== cacheIdentity || sha256Canonical(cached.assessor) !== sha256Canonical(assessor) || cached.cacheDisposition !== "FRESH" && cached.cacheDisposition !== "HIT")
            throw new Error("cached assessment provenance or digest is invalid");
        validateSessionIdentity(paseoSession, assessor);
        return { ...cached, ...payload, cacheDisposition: "HIT" };
    }
    catch (error) {
        if (error instanceof AehError)
            throw error;
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "cached assessment is malformed, stale, replayed, or its provenance digest is invalid.", { cause: error });
    }
}
export function createSemanticAssessmentServiceV1(options) {
    return new SemanticAssessmentServiceV1(options);
}
function normalizeEvidencePath(value) {
    const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || part === "." || part === ""))
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence path '${value}' is not a normalized repository-relative path.`);
    return normalized;
}
//# sourceMappingURL=assessment.js.map