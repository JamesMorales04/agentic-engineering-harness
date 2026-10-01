import { sha256Canonical } from "../core/digest.js";
import { assertCandidateRevisionV1 } from "../operations/v2Contracts.js";
import { validationRequirementSchema } from "./validationRequirements.js";
export const CANDIDATE_ASSURANCE_VERSION = 1;
const candidateAssuranceProviderAdapters = {
    "browser-test": { playwright: "playwright" },
    "visual-test": { playwright: "visual" },
    "static-security": { opengrep: "opengrep" },
    "dependency-security": { trivy: "trivy" }
};
export function candidateAssuranceProviderAdapterV1(kind, provider) {
    return candidateAssuranceProviderAdapters[kind]?.[provider];
}
/**
 * The canonical typed CandidateImpact review-dimension vocabulary. The semantic assessment contract
 * is constrained to exactly these typed dimensions so model output cannot fabricate a validation
 * obligation for a free-form dimension: every accepted dimension has one deterministic
 * validation-kind mapping (and a bounded assurance floor), and the model cannot widen it.
 */
export const candidateReviewDimensionValues = [
    "security",
    "authentication/authorization",
    "public API",
    "migration/schema",
    "dependency/supply chain",
    "UI/browser",
    "UI/visual",
    "architecture",
    "concurrency",
    "operations",
    "behavior.correctness"
];
const reviewDimensionRules = {
    security: { kind: "static-security", floor: "CRITICAL" },
    "authentication/authorization": { kind: "integration-test", floor: "CRITICAL" },
    "public API": { kind: "contract-test", floor: "ELEVATED" },
    "migration/schema": { kind: "integration-test", floor: "CRITICAL" },
    "dependency/supply chain": { kind: "dependency-security", floor: "CRITICAL" },
    "UI/browser": { kind: "browser-test", floor: "ELEVATED" },
    "UI/visual": { kind: "visual-test", floor: "ELEVATED" },
    architecture: { kind: "architecture", floor: "ELEVATED" },
    concurrency: { kind: "integration-test", floor: "CRITICAL" },
    operations: { kind: "integration-test", floor: "ELEVATED" },
    "behavior.correctness": { kind: "unit-test", floor: "STANDARD" }
};
const unknownReviewDimensionRule = { kind: "unit-test", floor: "ELEVATED" };
const assuranceRanks = { NONE: 0, STANDARD: 1, ELEVATED: 2, CRITICAL: 3 };
const digestPattern = /^[a-f0-9]{64}$/;
function reject(message) {
    throw new Error(`CANDIDATE_ASSURANCE_REJECTED: ${message}`);
}
function reviewDimensionRule(dimension) {
    return Object.hasOwn(reviewDimensionRules, dimension) ? reviewDimensionRules[dimension] : unknownReviewDimensionRule;
}
function assuranceRank(level) {
    const rank = assuranceRanks[level];
    if (rank === undefined)
        reject(`assurance level '${String(level)}' is not supported.`);
    return rank;
}
function maxAssurance(...levels) {
    let selected = "NONE";
    for (const level of levels)
        if (assuranceRank(level) > assuranceRank(selected))
            selected = level;
    return selected;
}
function dimensionSlug(dimension) {
    const slug = dimension.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || sha256Canonical(dimension).slice(0, 12);
}
function requireReviewDimensions(impact) {
    if (!Array.isArray(impact.reviewDimensions))
        reject("impact.reviewDimensions must be an array.");
    const normalized = impact.reviewDimensions.map((dimension) => (typeof dimension === "string" ? dimension.trim() : ""));
    if (normalized.some((dimension) => !dimension))
        reject("impact.reviewDimensions must contain only non-empty strings.");
    return [...new Set(normalized)].sort();
}
function requireChangedFiles(impact) {
    if (!Array.isArray(impact.changedFiles))
        reject("impact.changedFiles must be an array.");
    const normalized = impact.changedFiles.map((file) => (typeof file === "string" ? file.trim() : ""));
    if (normalized.some((file) => !file))
        reject("impact.changedFiles must contain only non-empty strings.");
    const unique = [...new Set(normalized)].sort();
    return unique.length ? unique : ["**"];
}
function requireUnknowns(impact) {
    const unknowns = impact.unknowns ?? [];
    if (!Array.isArray(unknowns))
        reject("impact.unknowns must be an array when present.");
    const normalized = unknowns.map((unknown) => (typeof unknown === "string" ? unknown.trim() : ""));
    if (normalized.some((unknown) => !unknown))
        reject("impact.unknowns must contain only non-empty strings.");
    return [...new Set(normalized)].sort();
}
function buildImpactValidationRequirements(dimensions, changedFiles) {
    const usedIds = new Set();
    return dimensions.map((dimension) => {
        const rule = reviewDimensionRule(dimension);
        const slug = dimensionSlug(dimension);
        let id = `impact-review-${slug}`;
        if (usedIds.has(id))
            id = `impact-review-${slug}-${sha256Canonical(dimension).slice(0, 8)}`;
        usedIds.add(id);
        return {
            version: 1,
            id,
            property: `Impact review dimension '${dimension}' must be validated before candidate acceptance.`,
            kind: rule.kind,
            scope: [...changedFiles],
            evidenceNeeded: [`${rule.kind} evidence for impact review dimension '${dimension}'.`],
            requirementRefs: [],
            acceptanceRefs: []
        };
    });
}
export function candidateImpactValidationRequirementsV1(impact) {
    if (!impact || typeof impact !== "object")
        reject("candidate impact must be an object.");
    return buildImpactValidationRequirements(requireReviewDimensions(impact), requireChangedFiles(impact));
}
function validatedPolicy(policy) {
    if (!policy || typeof policy !== "object")
        reject("policy must be an object.");
    if (policy.version !== 1)
        reject("policy.version must be 1.");
    if (typeof policy.digest !== "string" || !digestPattern.test(policy.digest))
        reject("policy.digest must be a lowercase SHA-256 digest.");
    assuranceRank(policy.minimumAssurance);
    assuranceRank(policy.evidenceStrength);
    if (typeof policy.independentReviewRequired !== "boolean")
        reject("policy.independentReviewRequired must be a boolean.");
    if (typeof policy.providerDiversity !== "boolean")
        reject("policy.providerDiversity must be a boolean.");
    if (!Number.isSafeInteger(policy.minimumIndependentReviewers) || policy.minimumIndependentReviewers < 0)
        reject("policy.minimumIndependentReviewers must be a non-negative integer.");
    if (!Array.isArray(policy.allowedValidationKinds))
        reject("policy.allowedValidationKinds must be an array.");
    if (policy.allowedValidationKinds.some((kind) => !["unit-test", "integration-test", "bdd", "contract-test", "browser-test", "visual-test", "static-security", "dependency-security", "architecture", "policy", "command"].includes(kind)))
        reject("policy.allowedValidationKinds contains an unsupported validation kind.");
    return policy;
}
function validateResolution(resolution) {
    if (!resolution || typeof resolution !== "object" || resolution.version !== 1 || !Array.isArray(resolution.requirements) || !Array.isArray(resolution.actions) || !Array.isArray(resolution.blocked))
        reject("validationResolution must be a complete version 1 result.");
    if (typeof resolution.digest !== "string" || !digestPattern.test(resolution.digest))
        reject("validationResolution.digest must be a lowercase SHA-256 digest.");
    const { digest, ...body } = resolution;
    if (sha256Canonical(body) !== digest)
        reject("validationResolution digest does not match its content.");
    for (const requirement of resolution.requirements) {
        if (!validationRequirementSchema.safeParse(requirement).success)
            reject(`validationResolution contains an invalid requirement '${String(requirement?.id)}'.`);
    }
    const actionIds = resolution.actions.map((action) => action?.requirementId);
    if (new Set(actionIds).size !== actionIds.length)
        reject("validationResolution contains duplicate actions for a requirement.");
}
function assertCandidateImpactBinding(candidate, impact) {
    if (!candidate || typeof candidate !== "object")
        reject("candidate revision must be an object.");
    if (!impact || typeof impact !== "object")
        reject("candidate impact must be an object.");
    const bound = impact.candidate;
    if (!bound || typeof bound !== "object")
        reject("candidate/impact binding is missing from the impact.");
    if (bound.candidateId !== candidate.candidateId || bound.revision !== candidate.revision || bound.identityDigest !== candidate.identityDigest) {
        reject(`candidate/impact binding mismatch: candidate ${String(candidate.candidateId)}@r${String(candidate.revision)} does not match impact candidate ${String(bound.candidateId)}@r${String(bound.revision)}.`);
    }
    return { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest };
}
function verifiedImpactDigest(impact) {
    if (typeof impact.version !== "number" || impact.version !== 1)
        reject("impact.version must be 1.");
    if (impact.interpretation !== "MODEL" && impact.interpretation !== "BLOCKED")
        reject("impact.interpretation must be MODEL or BLOCKED.");
    if (typeof impact.requiresIndependentReview !== "boolean")
        reject("impact.requiresIndependentReview must be a boolean.");
    if (typeof impact.digest !== "string" || !digestPattern.test(impact.digest))
        reject("impact digest must be a lowercase SHA-256 digest.");
    const { digest, ...payload } = impact;
    if (sha256Canonical(payload) !== digest)
        reject("impact digest does not match the impact payload.");
    return digest;
}
function eligibleReviewers(input, providerDiversity) {
    if (!Array.isArray(input.reviewerCandidates))
        reject("reviewerCandidates must be an array.");
    const implementer = typeof input.implementationIdentity === "string" ? input.implementationIdentity.trim() : "";
    const byIdentity = new Map();
    for (const candidate of input.reviewerCandidates) {
        if (!candidate || typeof candidate !== "object")
            continue;
        if (candidate.role !== "Reviewer" || candidate.readOnly !== true)
            continue;
        const identity = typeof candidate.identity === "string" ? candidate.identity.trim() : "";
        if (!identity || identity === implementer)
            continue;
        const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
        if (providerDiversity && !provider)
            continue;
        const existing = byIdentity.get(identity);
        if (!existing || provider < existing.provider)
            byIdentity.set(identity, { identity, provider });
    }
    return [...byIdentity.values()].sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0);
}
function selectReviewers(eligible, count, providerDiversity) {
    if (count === 0)
        return { selected: [], blockers: [] };
    const selected = [];
    if (providerDiversity) {
        const usedProviders = new Set();
        for (const reviewer of eligible) {
            if (selected.length >= count)
                break;
            if (usedProviders.has(reviewer.provider))
                continue;
            usedProviders.add(reviewer.provider);
            selected.push(reviewer);
        }
    }
    else {
        selected.push(...eligible.slice(0, count));
    }
    if (selected.length >= count)
        return { selected, blockers: [] };
    const distinctProviders = new Set(eligible.map((reviewer) => reviewer.provider)).size;
    if (providerDiversity && distinctProviders < count) {
        return { selected: [], blockers: [`INDEPENDENT_REVIEW_DIVERSITY_UNSATISFIED: independent reviewer assignments require ${count} distinct providers but only ${distinctProviders} are available.`] };
    }
    return { selected: [], blockers: [`INDEPENDENT_REVIEW_UNSATISFIED: independent reviewer assignments require ${count} eligible configured Reviewer candidate(s) but only ${eligible.length} are available.`] };
}
function cloneRequirement(requirement) {
    return {
        ...requirement,
        scope: [...requirement.scope],
        evidenceNeeded: [...requirement.evidenceNeeded],
        requirementRefs: [...requirement.requirementRefs],
        acceptanceRefs: [...requirement.acceptanceRefs]
    };
}
export function compileCandidateAssuranceV1(input) {
    if (!input || typeof input !== "object")
        reject("assurance compilation input must be an object.");
    const policy = validatedPolicy(input.policy);
    const binding = assertCandidateImpactBinding(input.candidate, input.impact);
    assertCandidateRevisionV1(input.candidate);
    const impactDigest = verifiedImpactDigest(input.impact);
    const dimensions = requireReviewDimensions(input.impact);
    const changedFiles = requireChangedFiles(input.impact);
    const unknowns = requireUnknowns(input.impact);
    if (input.risk !== "low" && input.risk !== "medium" && input.risk !== "high")
        reject("risk must be low, medium, or high.");
    if (!Array.isArray(input.baseValidationRequirements))
        reject("baseValidationRequirements must be an array.");
    if (!Array.isArray(input.acceptanceAssertions))
        reject("acceptanceAssertions must be an array.");
    validateResolution(input.validationResolution);
    for (const requirement of input.baseValidationRequirements) {
        if (!validationRequirementSchema.safeParse(requirement).success)
            reject(`base validation requirement '${String(requirement?.id)}' is invalid.`);
    }
    for (const assertion of input.acceptanceAssertions) {
        if (!assertion || typeof assertion.id !== "string" || !assertion.id.trim() || typeof assertion.statement !== "string" || !assertion.statement.trim() || !Array.isArray(assertion.requirementRefs) || assertion.requirementRefs.some((ref) => typeof ref !== "string" || !ref.trim()))
            reject("acceptanceAssertions must contain non-empty ids, statements, and requirement refs.");
    }
    const generatedRequirements = buildImpactValidationRequirements(dimensions, changedFiles);
    const validationRequirements = [...input.baseValidationRequirements.map(cloneRequirement), ...generatedRequirements];
    const blockers = [];
    if (input.risk === "high" && (input.impact.interpretation === "BLOCKED" || unknowns.length > 0)) {
        blockers.push("UNRESOLVED_HIGH_RISK_IMPACT: high-risk candidate impact is BLOCKED or retains unresolved unknowns.");
    }
    const allowedKinds = new Set(policy.allowedValidationKinds);
    const blockedRequirementIds = new Set(input.validationResolution.blocked.map((entry) => entry.requirementId));
    const resolvedActionById = new Map(input.validationResolution.actions.map((entry) => [entry.requirementId, entry]));
    const resolvedRequirementById = new Map(input.validationResolution.requirements.map((entry) => [entry.id, entry]));
    for (const requirement of generatedRequirements) {
        if (!allowedKinds.has(requirement.kind))
            blockers.push(`DISALLOWED_VALIDATION_KIND: ${requirement.id} requires '${requirement.kind}' which the frozen policy disallows.`);
        if (blockedRequirementIds.has(requirement.id))
            blockers.push(`UNRESOLVED_VALIDATION_REQUIREMENT: ${requirement.id} is blocked by the validation resolution.`);
        else {
            const resolvedRequirement = resolvedRequirementById.get(requirement.id);
            const action = resolvedActionById.get(requirement.id);
            if (!resolvedRequirement || sha256Canonical(resolvedRequirement) !== sha256Canonical(requirement))
                blockers.push(`UNRESOLVED_VALIDATION_REQUIREMENT: ${requirement.id} is absent or changed in the validation resolution.`);
            if (!action)
                blockers.push(`UNRESOLVED_VALIDATION_REQUIREMENT: ${requirement.id} has no approved validation action.`);
            else if (action.kind !== requirement.kind || sha256Canonical(action.scope) !== sha256Canonical(requirement.scope) || sha256Canonical(action.evidenceNeeded) !== sha256Canonical(requirement.evidenceNeeded))
                blockers.push(`UNRESOLVED_VALIDATION_REQUIREMENT: ${requirement.id} action does not preserve its compiled kind, scope, and evidence needs.`);
        }
    }
    const independentReviewRequired = policy.independentReviewRequired || input.impact.requiresIndependentReview;
    const minimumIndependentReviewers = Math.max(policy.minimumIndependentReviewers, independentReviewRequired ? 1 : 0, dimensions.length > 0 ? 1 : 0);
    const selection = selectReviewers(eligibleReviewers(input, policy.providerDiversity), minimumIndependentReviewers, policy.providerDiversity);
    blockers.push(...selection.blockers);
    const minimumAssurance = maxAssurance(policy.minimumAssurance, policy.evidenceStrength, ...dimensions.map((dimension) => reviewDimensionRule(dimension).floor));
    const assertionAssurance = (forDimensions) => maxAssurance(policy.minimumAssurance, policy.evidenceStrength, ...forDimensions.map((dimension) => reviewDimensionRule(dimension).floor));
    const reviewAssignments = selection.selected.map((reviewer) => ({
        reviewerIdentity: reviewer.identity,
        provider: reviewer.provider,
        dimensions: [...dimensions],
        candidate: binding,
        impactDigest,
        policyDigest: policy.digest
    }));
    const dimensionByRequirementId = new Map(generatedRequirements.map((requirement, index) => [requirement.id, dimensions[index]]));
    const boundBaseAssertions = input.acceptanceAssertions.map((assertion) => {
        const dimensionsForAssertion = [...new Set(assertion.requirementRefs.map((ref) => dimensionByRequirementId.get(ref)).filter((dimension) => Boolean(dimension)))].sort();
        return {
            version: 1,
            id: assertion.id,
            statement: assertion.statement,
            requirementRefs: [...new Set(assertion.requirementRefs)].sort(),
            candidate: binding,
            impactDigest,
            policyDigest: policy.digest,
            dimensions: dimensionsForAssertion,
            evidenceStrength: assertionAssurance(dimensionsForAssertion)
        };
    });
    const generatedAssertions = generatedRequirements.map((requirement, index) => {
        const dimension = dimensions[index];
        return {
            version: 1,
            id: `impact-acceptance-${requirement.id.replace(/^impact-review-/, "")}`,
            statement: `Impact review dimension '${dimension}' requires ${requirement.kind} evidence before candidate acceptance.`,
            requirementRefs: [requirement.id],
            candidate: binding,
            impactDigest,
            policyDigest: policy.digest,
            dimensions: [dimension],
            evidenceStrength: assertionAssurance([dimension])
        };
    });
    const orderedBlockers = [...new Set(blockers)].sort();
    const status = orderedBlockers.length ? "BLOCKED" : "READY";
    const evidenceStrength = {
        minimumAssurance,
        minimumIndependentReviewers,
        providerDiversity: policy.providerDiversity,
        requiredDimensions: [...dimensions]
    };
    const compilationWithoutDigest = {
        version: CANDIDATE_ASSURANCE_VERSION,
        candidate: binding,
        impactDigest,
        policyDigest: policy.digest,
        minimumAssurance,
        reviewAssignments,
        validationRequirements,
        acceptanceAssertions: [...boundBaseAssertions, ...generatedAssertions],
        evidenceStrength,
        blockers: orderedBlockers,
        status
    };
    return { ...compilationWithoutDigest, digest: sha256Canonical(compilationWithoutDigest) };
}
//# sourceMappingURL=candidateAssurance.js.map