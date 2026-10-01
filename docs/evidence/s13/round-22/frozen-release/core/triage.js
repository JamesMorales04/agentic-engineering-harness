import { requiresDelegatedPlanningV1, resolveImplementationRoute } from "../agents/routingV2.js";
import { assuranceLevelSchema, implementationRouteSchema, routeEvidenceSchema } from "../architecture/contracts.js";
import { sha256Canonical } from "./digest.js";
import { AehError } from "./errors.js";
import { createSemanticEvidenceReceiptV1, decisionMechanismSchema, semanticAssessmentBindingV1Schema, semanticModelDeadlineMsV1 } from "../semantic/assessment.js";
import { z } from "zod";
const triageFlagValues = ["architecture", "security", "authentication", "authorization", "schema", "migration", "public-api", "breaking-change", "new-dependency", "cross-module", "ambiguous"];
export const triageDecisionV1Schema = z.object({
    route: implementationRouteSchema,
    assurance: assuranceLevelSchema,
    mechanism: decisionMechanismSchema,
    assessmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    routeEvidence: z.array(routeEvidenceSchema).min(1).max(16),
    reasons: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32).optional(),
    evidence: z.object({
        request: z.string().min(1).max(24_000),
        files: z.array(z.string().trim().min(1).max(500)).max(256),
        domains: z.array(z.string().trim().min(1).max(200)).max(64),
        risk: z.enum(["low", "medium", "high"]),
        flags: z.array(z.enum(triageFlagValues)).max(32)
    }).strict()
}).strict();
export const changePreflightV1Schema = z.object({
    version: z.literal(1),
    triage: triageDecisionV1Schema,
    binding: semanticAssessmentBindingV1Schema
}).strict().superRefine((value, context) => {
    if (value.binding.operationId !== undefined || value.binding.candidateId !== undefined || value.binding.candidateRevision !== undefined || value.binding.candidateDigest !== undefined) {
        context.addIssue({ code: "custom", path: ["binding"], message: "pre-operation route triage must not claim an operation or candidate binding" });
    }
});
export function assertChangePreflightV1(value, expected) {
    const parsed = changePreflightV1Schema.safeParse(value);
    if (!parsed.success)
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "persisted CHANGE preflight is malformed or has unsupported identity.", { cause: parsed.error });
    const normalized = normalizeTriageEvidence(expected.evidence);
    const actual = parsed.data;
    if (actual.binding.projectId !== expected.binding.projectId
        || actual.binding.repositoryDigest !== expected.binding.repositoryDigest
        || actual.binding.repositoryRootDigest !== expected.binding.repositoryRootDigest
        || actual.binding.intentDigest !== expected.binding.intentDigest
        || actual.triage.evidence.request !== normalized.request
        || JSON.stringify(actual.triage.evidence.files) !== JSON.stringify(normalized.files)
        || JSON.stringify(actual.triage.evidence.domains) !== JSON.stringify(normalized.domains)
        || actual.triage.evidence.risk !== normalized.risk
        || JSON.stringify(actual.triage.evidence.flags) !== JSON.stringify(normalized.flags)) {
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "persisted CHANGE preflight does not match the current repository and request identity.");
    }
    return actual;
}
export function normalizeTriageEvidence(input) {
    return {
        request: input.request,
        files: [...new Set(input.files ?? [])],
        domains: [...new Set(input.domains ?? [])],
        risk: input.risk ?? "low",
        flags: [...new Set(input.flags ?? [])]
    };
}
const defaultDisallowedDomains = ["security", "auth", "authentication", "authorization", "architecture", "database", "schema", "migration", "api-contract", "multi-tenancy"];
export function triageChange(config, input) {
    return triageChangeUsingAssessment(config, input);
}
export async function triageChangeWithSemanticAssessment(config, input, options) {
    const files = [...new Set(input.files ?? [])];
    const domains = [...new Set(input.domains ?? [])];
    const risk = input.risk ?? "low";
    const flags = [...new Set(input.flags ?? [])];
    const compactEvidence = [
        { ref: "request", content: input.request.trim() },
        { ref: "scope", content: files.length ? files.join("\n") : "No concrete file scope was supplied." },
        { ref: "domains", content: domains.length ? domains.join(", ") : "No domain labels were supplied." },
        { ref: "risk", content: risk },
        { ref: "flags", content: flags.length ? flags.join(", ") : "No escalation flags were supplied." }
    ];
    const binding = { ...options.binding, intentDigest: options.binding.intentDigest ?? sha256Canonical({ request: input.request, files, domains, risk, flags }) };
    const assessment = await options.service.assess({
        version: 1,
        assessmentType: "ROUTE",
        evidenceRefs: compactEvidence.map((item) => item.ref),
        compactEvidence,
        evidenceReceipts: compactEvidence.map((item) => createSemanticEvidenceReceiptV1({ binding, ref: item.ref, content: item.content, kind: "REQUEST" })),
        requiredOutputSchema: "semantic-assessment-v1",
        reasoningRequirement: { reasoningClass: "STANDARD", structuredOutputRequired: true, independenceRequired: false, externalKnowledgeRequired: false, maxContextClass: "STANDARD", riskClass: risk === "high" ? "HIGH" : risk === "medium" ? "STANDARD" : "LOW" },
        binding,
        budget: { maxInputTokens: 2_000, maxOutputTokens: 500, deadlineMs: semanticModelDeadlineMsV1 },
        policyRevision: options.policyRevision
    });
    if (assessment.judgment?.type !== "ROUTE")
        throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "ROUTE assessment did not contain a typed route judgment.");
    const judgment = assessment.judgment;
    const deterministicDelegationFloor = requiresDelegatedPlanningV1({ files, crossModule: flags.includes("cross-module"), scopeConfidence: judgment.scopeClarity === "LOW" ? "low" : "high", decompositionNeed: judgment.decompositionNeed, coordinationNeed: judgment.coordinationNeed });
    const recommendedRoute = deterministicDelegationFloor && judgment.recommendedRoute === "DIRECT" ? "DELEGATED" : judgment.recommendedRoute;
    const semanticAssessment = { ...judgment, recommendedRoute };
    return {
        ...triageChangeUsingAssessment(config, input, semanticAssessment, assessment.assessmentDigest),
        unknowns: [...new Set([...assessment.unknowns, ...judgment.unknowns])].sort()
    };
}
function triageChangeUsingAssessment(config, input, semanticAssessment, assessmentDigest) {
    const files = [...new Set(input.files ?? [])];
    const domains = [...new Set(input.domains ?? [])];
    const risk = input.risk ?? "low";
    const flags = [...new Set(input.flags ?? [])];
    const reasons = [];
    const maxFiles = 5;
    const disallowed = defaultDisallowedDomains;
    if (!files.length)
        reasons.push("a bounded file scope was not supplied");
    const nonConcrete = files.filter((file) => /[*?\[\]{}]/.test(file));
    if (nonConcrete.length)
        reasons.push(`scope requires concrete file paths, not wildcard paths: ${nonConcrete.join(", ")}`);
    if (files.length > maxFiles)
        reasons.push(`scope contains ${files.length} files/patterns; delegated planning is required beyond ${maxFiles}`);
    if (risk !== "low")
        reasons.push(`risk is ${risk}; elevated assurance is required`);
    if (flags.length)
        reasons.push(`explicit escalation flags: ${flags.join(", ")}`);
    const blockedDomains = domains.filter((domain) => disallowed.some((pattern) => domain.toLowerCase().includes(pattern.toLowerCase()) || pattern.toLowerCase().includes(domain.toLowerCase())));
    if (blockedDomains.length)
        reasons.push(`domains require elevated assurance and review: ${blockedDomains.join(", ")}`);
    const routingEvidence = {
        intent: input.request,
        ambiguity: flags.includes("ambiguous"),
        architecture: flags.includes("architecture") || domains.some((domain) => /architecture/i.test(domain)),
        crossModule: flags.includes("cross-module") || files.length > maxFiles,
        scopeConfidence: files.length === 0 || nonConcrete.length > 0 ? "low" : "high",
        risk,
        publicContractImpact: flags.includes("public-api") || flags.includes("breaking-change") || domains.some((domain) => /public-api|breaking|contract/i.test(domain)),
        dataOrSchemaImpact: flags.includes("schema") || flags.includes("migration") || domains.some((domain) => /schema|migration|database/i.test(domain)),
        securityBoundary: flags.some((flag) => ["security", "authentication", "authorization"].includes(flag)) || domains.some((domain) => /security|auth|permission/i.test(domain)),
        files,
        semanticAssessment
    };
    const route = resolveImplementationRoute(routingEvidence);
    const finalReasons = [...reasons, ...(route.route === "FORMAL_SDD" ? [route.routeEvidence[0].statement] : [])];
    return { route: route.route, assurance: route.assurance, mechanism: route.mechanism, ...(assessmentDigest ? { assessmentDigest } : {}), routeEvidence: route.routeEvidence, reasons: finalReasons.length ? finalReasons : ["bounded request classified by explicit evidence and canonical route policy"], evidence: { request: input.request, files, domains, risk, flags } };
}
export function formatTriageDecision(decision) { return `${decision.route}/${decision.assurance} — ${decision.reasons.join("; ")}`; }
//# sourceMappingURL=triage.js.map