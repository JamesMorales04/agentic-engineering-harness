import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { createSemanticEvidenceReceiptV1, semanticModelDeadlineMsV1 } from "../semantic/assessment.js";
export const failureTypeValues = ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"];
const failureTypeSchema = z.enum(failureTypeValues);
export const failureAssessmentSchema = z.object({ version: z.literal(1), mechanism: z.enum(["MODEL", "HYBRID"]), classification: failureTypeSchema, evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(16), semanticAssessmentDigest: z.string().trim().length(64), assessmentDigest: z.string().trim().length(64) }).strict();
export function failureAssessmentDigest(assessment) {
    const { assessmentDigest: _ignored, ...digestInput } = assessment;
    return sha256Canonical(digestInput);
}
export function classifyFailure(evidence) {
    return classifyFailureDecision(evidence).classification;
}
export function classifyFailureDecision(evidence) {
    const deterministic = deterministicFailureDecision(evidence);
    if (deterministic)
        return deterministic;
    if (evidence.worker && evidence.worker.exitCode !== 0)
        return { classification: "TOOL_FAILURE", mechanism: "DETERMINISTIC", evidenceRefs: evidenceRefsFor(evidence) };
    return { classification: "AMBIGUOUS_OUTPUT", mechanism: "DETERMINISTIC", evidenceRefs: evidenceRefsFor(evidence) };
}
export async function classifyFailureWithSemanticAssessment(evidence, options) {
    const deterministic = deterministicFailureDecision(evidence);
    if (deterministic)
        return deterministic;
    const compactEvidence = compactFailureEvidence(evidence);
    if (!compactEvidence.length)
        return { classification: "AMBIGUOUS_OUTPUT", mechanism: "DETERMINISTIC", evidenceRefs: [] };
    const binding = options.binding;
    const assessment = await options.service.assess({
        version: 1,
        assessmentType: "FAILURE",
        evidenceRefs: compactEvidence.map((item) => item.ref),
        compactEvidence,
        evidenceReceipts: compactEvidence.map((item) => createSemanticEvidenceReceiptV1({ binding, ref: item.ref, content: item.content, kind: "OBSERVED_FACT" })),
        requiredOutputSchema: "semantic-assessment-v1",
        reasoningRequirement: { reasoningClass: "LIGHT", structuredOutputRequired: true, independenceRequired: false, externalKnowledgeRequired: false, maxContextClass: "STANDARD", riskClass: "STANDARD" },
        binding,
        budget: { maxInputTokens: 2_000, maxOutputTokens: 300, deadlineMs: semanticModelDeadlineMsV1 },
        policyRevision: options.policyRevision
    });
    if (assessment.judgment?.type !== "FAILURE")
        throw new AehError("FAILURE_ASSESSMENT_INVALID", "semantic failure assessment did not contain a typed failure judgment.");
    const candidateWithoutDigest = { version: 1, mechanism: "HYBRID", classification: assessment.judgment.classification, evidenceRefs: [...assessment.judgment.evidenceRefs], semanticAssessmentDigest: assessment.assessmentDigest };
    const candidate = { ...candidateWithoutDigest, assessmentDigest: failureAssessmentDigest(candidateWithoutDigest) };
    const validated = validateFailureAssessment(evidence, candidate);
    return { classification: validated.classification, mechanism: "HYBRID", evidenceRefs: validated.evidenceRefs, assessmentDigest: validated.assessmentDigest, unknowns: [...assessment.unknowns] };
}
function deterministicFailureDecision(evidence) {
    if (evidence.conflicting)
        return { classification: "CONFLICTING_RESULTS", mechanism: "DETERMINISTIC", evidenceRefs: ["state:conflicting"] };
    if (evidence.wrongAgent)
        return { classification: "WRONG_AGENT", mechanism: "DETERMINISTIC", evidenceRefs: ["state:wrong-agent"] };
    if (evidence.missingContext)
        return { classification: "MISSING_CONTEXT", mechanism: "DETERMINISTIC", evidenceRefs: ["state:missing-context"] };
    if (evidence.reviewFailure)
        return { classification: "REVIEW_FAILURE", mechanism: "DETERMINISTIC", evidenceRefs: ["state:review-failure"] };
    if (evidence.report?.checks.some((check) => check.status === "FAIL"))
        return { classification: "VALIDATION_FAILURE", mechanism: "DETERMINISTIC", evidenceRefs: ["report:checks"] };
    return undefined;
}
function validateFailureAssessment(evidence, assessment) {
    const parsed = failureAssessmentSchema.safeParse(assessment);
    if (!parsed.success)
        throw new AehError("FAILURE_ASSESSMENT_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "assessment"}: ${issue.message}`).join("; "));
    const available = new Set();
    if (evidence.worker?.stdout?.trim())
        available.add("worker:stdout");
    if (evidence.worker?.stderr?.trim())
        available.add("worker:stderr");
    if (evidence.report?.checks.length)
        available.add("report:checks");
    if (evidence.conflicting)
        available.add("state:conflicting");
    if (evidence.wrongAgent)
        available.add("state:wrong-agent");
    if (evidence.missingContext)
        available.add("state:missing-context");
    if (evidence.reviewFailure)
        available.add("state:review-failure");
    if (parsed.data.evidenceRefs.some((ref) => !available.has(ref)))
        throw new AehError("FAILURE_ASSESSMENT_INVALID", "failure assessment evidenceRefs are not bound to observed failure evidence.");
    if (parsed.data.assessmentDigest !== failureAssessmentDigest(parsed.data))
        throw new AehError("FAILURE_ASSESSMENT_INVALID", "failure assessment digest does not match its typed claim.");
    return parsed.data;
}
function compactFailureEvidence(evidence) {
    const values = [];
    if (evidence.worker?.stderr?.trim())
        values.push({ ref: "worker:stderr", content: evidence.worker.stderr.trim().slice(-4_000) });
    if (evidence.worker?.stdout?.trim())
        values.push({ ref: "worker:stdout", content: evidence.worker.stdout.trim().slice(-4_000) });
    if (evidence.report?.checks.length)
        values.push({ ref: "report:checks", content: JSON.stringify(evidence.report.checks.map((check) => ({ id: check.id, category: check.category, status: check.status, message: check.message })).slice(0, 32)).slice(0, 4_000) });
    if (evidence.conflicting)
        values.push({ ref: "state:conflicting", content: "Independent results conflict." });
    if (evidence.wrongAgent)
        values.push({ ref: "state:wrong-agent", content: "The assigned participant identity was incorrect." });
    if (evidence.missingContext)
        values.push({ ref: "state:missing-context", content: "Required task context was unavailable." });
    if (evidence.reviewFailure)
        values.push({ ref: "state:review-failure", content: "A review stage failed." });
    return values;
}
function evidenceRefsFor(evidence) {
    return compactFailureEvidence(evidence).map((item) => item.ref);
}
export function resolveRecoveryStep(recovery, failureType, attempt) {
    const policy = recovery[failureType] ?? [{ action: "same-agent" }, { action: "lead" }];
    const index = Math.min(Math.max(attempt - 1, 0), policy.length - 1);
    return policy[index] ?? { action: "stop" };
}
export function formatRecoveryAction(step, currentAgent) {
    switch (step.action) {
        case "same-agent": return `retry:${currentAgent}`;
        case "reroute": return "reroute";
        case "lead": return "escalate:lead";
        case "stop": return "stop";
    }
}
//# sourceMappingURL=recovery.js.map