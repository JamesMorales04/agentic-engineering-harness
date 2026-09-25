import fs from "node:fs/promises";
import path from "node:path";
import { assertExecutionBindingV2 } from "./executionIdentity.js";
import type { ResolvedOperationPolicyV1 } from "./executionIdentity.js";
import { assertResolvedOperationPolicyV1 } from "./executionIdentity.js";
import type { CandidateAssuranceCompilationV1 } from "./candidateAssurance.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { OperationRecordV2 } from "../operations/state.js";
import type { ValidationCheck, ValidationReport } from "../core/types.js";
import { sha256Canonical } from "../core/digest.js";
import type { AssuranceLevel } from "./contracts.js";
import type { ObjectiveCompletionIdentityV1 } from "./objectiveCompletion.js";

export interface VerificationRequirementV1 {
  version: 1;
  id: string;
  assertionId: string;
  statement: string;
  minimumAssurance: AssuranceLevel;
  validationRequirementIds: string[];
  reviewDimensions: string[];
  leadRequired: boolean;
}

export interface AcceptanceEvidenceItemV1 {
  version: 1;
  id: string;
  assertionId: string;
  kind: "VALIDATION" | "REVIEW" | "LEAD" | "CERTIFICATION";
  status: "PASS" | "FAIL";
  identity: ObjectiveCompletionIdentityV1;
  strength: AssuranceLevel;
  provenance: { sourceId: string; digest: string; artifact?: string; executionBindingDigest?: string; actorId?: string; actorGeneration?: number; promptDigest?: string; assessment?: string };
  dimension?: string;
  reviewerIdentity?: string;
  provider?: string;
}

export interface EvidenceBundleV1 {
  version: 1;
  identity: ObjectiveCompletionIdentityV1;
  candidate: CandidateRevisionV1;
  impactDigest: string;
  compilationDigest: string;
  requirements: VerificationRequirementV1[];
  evidence: AcceptanceEvidenceItemV1[];
  digest: string;
}

export interface AcceptanceOracleDispositionV1 {
  version: 1;
  disposition: "ACCEPTED" | "REJECTED";
  identity: ObjectiveCompletionIdentityV1;
  evidenceBundleDigest: string;
  requiredAssertionIds: string[];
  coveredAssertionIds: string[];
  certificationRequired: boolean;
  certification?: { status: "PASS" | "FAIL"; identity: ObjectiveCompletionIdentityV1; provenanceDigest: string };
  blockers: Array<{ code: string; message: string }>;
  digest: string;
}

export interface ManagedLeadAcceptanceEvidenceV1 {
  version: 1;
  status: "PASS" | "FAIL";
  operationId: string;
  candidate: CandidateRevisionV1;
  policyDigest: string;
  operationExecutionRevision: number;
  controllerEpoch: number;
  leadAgentId: string;
  leadGeneration: number;
  assertions: Array<{ assertionId: string; verdict: "PASS" | "FAIL"; rationale: string }>;
  summary: string;
  unresolved: string[];
  promptDigest: string;
  responseDigest: string;
}

export interface AcceptanceOracleArtifactV1 {
  version: 1;
  operationId: string;
  identity: ObjectiveCompletionIdentityV1;
  evidenceBundle: EvidenceBundleV1;
  disposition: AcceptanceOracleDispositionV1;
  persistedAt: string;
}

const assuranceRank: Readonly<Record<AssuranceLevel, number>> = { NONE: 0, STANDARD: 1, ELEVATED: 2, CRITICAL: 3 };
const validationStrength: Readonly<Record<string, AssuranceLevel>> = {
  "unit-test": "STANDARD", bdd: "STANDARD", "integration-test": "ELEVATED", "contract-test": "ELEVATED",
  "browser-test": "ELEVATED", architecture: "ELEVATED", policy: "ELEVATED", command: "STANDARD",
  "static-security": "CRITICAL", "dependency-security": "CRITICAL"
};

function blocker(code: string, message: string): { code: string; message: string } { return { code, message }; }

export function currentObjectiveIdentityV1(operation: OperationRecordV2): ObjectiveCompletionIdentityV1 {
  const candidate = operation.candidateRevision;
  const policy = operation.resolvedOperationPolicy;
  const executionRevision = operation.operationExecutionRevision;
  if (!candidate || !policy || !Number.isSafeInteger(executionRevision) || executionRevision! < 1) {
    throw new Error("ACCEPTANCE_IDENTITY_REQUIRED: current candidate, frozen policy, and operation execution revision are required.");
  }
  assertResolvedOperationPolicyV1(policy);
  const controllerEpoch = operation.controller?.epoch ?? 0;
  assertPolicyMatchesOperation(policy, operation, candidate, executionRevision!, controllerEpoch);
  return { operationId: operation.id, candidate, policyDigest: policy.digest, operationExecutionRevision: executionRevision!, controllerEpoch };
}

function assertPolicyMatchesOperation(policy: ResolvedOperationPolicyV1, operation: OperationRecordV2, candidate: CandidateRevisionV1, executionRevision: number, controllerEpoch: number): void {
  if (policy.operationId !== operation.id || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.operationExecutionRevision !== executionRevision || policy.controllerEpoch !== controllerEpoch
    || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new Error("ACCEPTANCE_POLICY_STALE: policy is not the current operation/candidate/execution/epoch policy; caller-supplied digest equality is insufficient.");
  }
}

export function leadAcceptanceRequiredV1(policy: ResolvedOperationPolicyV1): boolean {
  const review = policy.reviewPolicy;
  if (!review || typeof review !== "object") throw new Error("ACCEPTANCE_POLICY_INVALID: frozen reviewPolicy is required.");
  const values = review as Record<string, unknown>;
  if (typeof values.leadAcceptance !== "boolean" || typeof values.leadAcceptanceDirect !== "boolean") {
    throw new Error("ACCEPTANCE_POLICY_INVALID: frozen reviewPolicy must bind leadAcceptance and leadAcceptanceDirect.");
  }
  return values.leadAcceptance && (policy.route !== "DIRECT" || values.leadAcceptanceDirect);
}

export function resolveVerificationRequirementsV1(compilation: CandidateAssuranceCompilationV1, policy: ResolvedOperationPolicyV1): VerificationRequirementV1[] {
  assertCompilationCurrent(compilation, policy);
  const leadRequired = leadAcceptanceRequiredV1(policy);
  const validations = compilation.validationRequirements;
  return compilation.acceptanceAssertions.map((assertion) => {
    const refs = new Set(assertion.requirementRefs);
    const validationRequirementIds = validations
      .filter((requirement) => refs.has(requirement.id) || requirement.requirementRefs.some((ref) => refs.has(ref)) || requirement.acceptanceRefs.includes(assertion.id))
      .map((requirement) => requirement.id).sort();
    const reviewDimensions = (assertion.dimensions.length ? assertion.dimensions : compilation.evidenceStrength.requiredDimensions).slice().sort();
    return {
      version: 1 as const,
      id: `verification:${assertion.id}`,
      assertionId: assertion.id,
      statement: assertion.statement,
      minimumAssurance: assertion.evidenceStrength,
      validationRequirementIds: [...new Set(validationRequirementIds)],
      reviewDimensions: [...new Set(reviewDimensions)],
      leadRequired
    };
  }).sort((a, b) => a.assertionId.localeCompare(b.assertionId));
}

function assertCompilationCurrent(compilation: CandidateAssuranceCompilationV1, policy: ResolvedOperationPolicyV1): void {
  if (!compilation || compilation.version !== 1 || !Array.isArray(compilation.acceptanceAssertions) || !Array.isArray(compilation.validationRequirements)) {
    throw new Error("ACCEPTANCE_COMPILATION_INVALID: candidate assurance compilation is required.");
  }
  const { digest, ...body } = compilation;
  if (digest !== sha256Canonical(body)) throw new Error("ACCEPTANCE_COMPILATION_INVALID: candidate assurance digest does not match its content.");
  if (compilation.policyDigest !== policy.digest || compilation.candidate.revision !== policy.candidateRevision || compilation.candidate.identityDigest !== policy.candidateDigest) {
    throw new Error("ACCEPTANCE_COMPILATION_STALE: candidate assurance compilation is not bound to the current candidate and policy.");
  }
  const seen = new Set<string>();
  for (const assertion of compilation.acceptanceAssertions) {
    if (seen.has(assertion.id)) throw new Error(`ACCEPTANCE_COMPILATION_INVALID: duplicate AcceptanceAssertion '${assertion.id}'.`);
    seen.add(assertion.id);
    if (!sameCandidateBinding(assertion.candidate, compilation.candidate) || assertion.policyDigest !== compilation.policyDigest || assertion.impactDigest !== compilation.impactDigest) {
      throw new Error(`ACCEPTANCE_COMPILATION_STALE: AcceptanceAssertion '${assertion.id}' does not bind the compilation candidate, impact, and policy.`);
    }
  }
}

function sameCandidateBinding(left: { candidateId: string; revision: number; identityDigest: string }, right: { candidateId: string; revision: number; identityDigest: string }): boolean {
  return left.candidateId === right.candidateId && left.revision === right.revision && left.identityDigest === right.identityDigest;
}

export function buildAcceptanceEvidenceBundleV1(input: {
  operation: OperationRecordV2;
  compilation: CandidateAssuranceCompilationV1;
  report: ValidationReport;
  implementationIdentity: string;
  leadEvidence?: ManagedLeadAcceptanceEvidenceV1;
  certification?: { status: "PASS" | "FAIL"; identity: ObjectiveCompletionIdentityV1; provenanceDigest: string };
}): EvidenceBundleV1 {
  const identity = currentObjectiveIdentityV1(input.operation);
  const compilation = input.compilation;
  const policy = input.operation.resolvedOperationPolicy!;
  assertCompilationCurrent(compilation, policy);
  if (!input.report.candidate || !candidateRevisionsEqual(input.report.candidate, identity.candidate)) throw new Error("ACCEPTANCE_REPORT_STALE: validation report does not describe the current candidate.");
  const requirements = resolveVerificationRequirementsV1(compilation, policy);
  const evidence: AcceptanceEvidenceItemV1[] = [];
  for (const requirement of requirements) {
    const assertion = compilation.acceptanceAssertions.find((item) => item.id === requirement.assertionId)!;
    for (const requirementId of requirement.validationRequirementIds) {
      const validation = validationForRequirement(input.report.checks, requirementId);
      if (!validation) {
        evidence.push(makeEvidence({ id: `validation:${requirementId}:${assertion.id}`, assertionId: assertion.id, kind: "VALIDATION", status: "FAIL", identity, strength: validationStrength[compilation.validationRequirements.find((item) => item.id === requirementId)?.kind ?? ""] ?? "NONE", sourceId: requirementId, sourceDigest: sha256Canonical({ missing: requirementId, report: sha256Canonical(input.report) }) }));
        continue;
      }
      const details = validation.details && typeof validation.details === "object" ? validation.details as Record<string, unknown> : {};
      const detailCandidate = details.candidate as { candidateId?: unknown; revision?: unknown; identityDigest?: unknown } | undefined;
      const bindingValid = (!detailCandidate || sameCandidateBinding(detailCandidate as never, compilation.candidate))
        && (details.policyDigest === undefined || details.policyDigest === policy.digest)
        && (details.impactDigest === undefined || details.impactDigest === compilation.impactDigest)
        && (details.requirementId === undefined || details.requirementId === requirementId);
      evidence.push(makeEvidence({
        id: `validation:${requirementId}:${assertion.id}`,
        assertionId: assertion.id,
        kind: "VALIDATION",
        status: validation.status === "PASS" && bindingValid ? "PASS" : "FAIL",
        identity,
        strength: validationStrength[compilation.validationRequirements.find((item) => item.id === requirementId)?.kind ?? ""] ?? "NONE",
        sourceId: validation.id,
        sourceDigest: sha256Canonical(validation),
        artifact: typeof details.artifact === "string" ? details.artifact : undefined
      }));
    }
    for (const dimension of requirement.reviewDimensions) {
      const reviews = currentReviewEvidence(input.operation, input.report.checks, compilation, identity, dimension);
      for (const review of reviews) evidence.push(makeEvidence({
        id: `review:${review.reviewerIdentity}:${dimension}:${assertion.id}`,
        assertionId: assertion.id,
        kind: "REVIEW",
        status: review.status,
        identity,
        strength: compilation.evidenceStrength.minimumAssurance,
        sourceId: review.sourceId,
        sourceDigest: review.digest,
        artifact: review.artifact,
        executionBindingDigest: review.executionBindingDigest,
        dimension,
        reviewerIdentity: review.reviewerIdentity,
        provider: review.provider
      }));
      if (!reviews.length) evidence.push(makeEvidence({ id: `review:missing:${dimension}:${assertion.id}`, assertionId: assertion.id, kind: "REVIEW", status: "FAIL", identity, strength: "NONE", sourceId: `missing:${dimension}`, sourceDigest: sha256Canonical({ missing: dimension, assertion: assertion.id }) , dimension }));
    }
    if (requirement.leadRequired) {
      const lead = input.leadEvidence;
      const validLead = lead && lead.status === "PASS" && lead.operationId === identity.operationId
        && candidateRevisionsEqual(lead.candidate, identity.candidate) && lead.policyDigest === identity.policyDigest
        && lead.operationExecutionRevision === identity.operationExecutionRevision && lead.controllerEpoch === identity.controllerEpoch
        && input.operation.lead?.agentId === lead.leadAgentId && input.operation.lead.generation === lead.leadGeneration
        && lead.leadAgentId !== input.implementationIdentity
        && input.operation.participants[lead.leadAgentId]?.logicalAgent !== input.implementationIdentity
        && lead.assertions.some((item) => item.assertionId === assertion.id && item.verdict === "PASS");
      const leadAssertion = lead?.assertions.find((item) => item.assertionId === assertion.id);
      evidence.push(makeEvidence({
        id: `lead:${assertion.id}`,
        assertionId: assertion.id,
        kind: "LEAD",
        status: validLead ? "PASS" : "FAIL",
        identity,
        strength: "NONE",
        sourceId: lead?.leadAgentId ?? "missing-lead",
        sourceDigest: lead?.responseDigest ?? sha256Canonical({ missing: "lead", assertion: assertion.id }),
        actorId: lead?.leadAgentId,
        actorGeneration: lead?.leadGeneration,
        promptDigest: lead?.promptDigest,
        assessment: leadAssertion?.rationale
      }));
    }
  }
  const withoutDigest = { version: 1 as const, identity, candidate: identity.candidate, impactDigest: compilation.impactDigest, compilationDigest: compilation.digest, requirements, evidence };
  return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}

function validationForRequirement(checks: ValidationCheck[], requirementId: string): ValidationCheck | undefined {
  const matches = checks.filter((check) => check.id === requirementId || check.id === `candidate-impact-${requirementId}`
    || check.id === `candidate.assurance.validation.${requirementId}`
    || (check.details && typeof check.details === "object" && (check.details as Record<string, unknown>).requirementId === requirementId));
  if (matches.length !== 1) return undefined;
  return matches[0];
}

function currentReviewEvidence(operation: OperationRecordV2, checks: ValidationCheck[], compilation: CandidateAssuranceCompilationV1, identity: ObjectiveCompletionIdentityV1, dimension: string): Array<{ status: "PASS" | "FAIL"; reviewerIdentity: string; provider: string; sourceId: string; digest: string; artifact?: string; executionBindingDigest?: string }> {
  const assignments = compilation.reviewAssignments.filter((assignment) => assignment.dimensions.includes(dimension));
  const output = [] as Array<{ status: "PASS" | "FAIL"; reviewerIdentity: string; provider: string; sourceId: string; digest: string; artifact?: string; executionBindingDigest?: string }>;
  for (const assignment of assignments) {
    const matches = checks.filter((check) => check.category === "candidate-assurance" && check.id.startsWith("candidate.assurance.reviewer.")
      && check.details && typeof check.details === "object" && (check.details as Record<string, unknown>).reviewerIdentity === assignment.reviewerIdentity);
    for (const check of matches) {
      const details = check.details as Record<string, unknown>;
      const sessionId = details.sessionId;
      const participant = Object.values(operation.participants).find((candidate) => candidate.executionBinding?.runtime.sessionId === sessionId);
      let bindingValid = false;
      try {
        if (participant?.executionBinding) {
          assertExecutionBindingV2(participant.executionBinding);
          const binding = participant.executionBinding;
          bindingValid = binding.operationId === identity.operationId && binding.operationExecutionRevision === identity.operationExecutionRevision
            && binding.candidateRevision === identity.candidate.revision && binding.candidateDigest === identity.candidate.identityDigest
            && binding.operationPolicyDigest === identity.policyDigest && binding.controllerEpoch === identity.controllerEpoch
            && binding.roleInvocationPolicyDigest.length > 0 && participant.role === "Reviewer"
            && participant.logicalAgent === assignment.reviewerIdentity && participant.resultArtifact !== undefined;
        }
      } catch { bindingValid = false; }
      const detailCandidate = details.candidate as { candidateId?: unknown; revision?: unknown; identityDigest?: unknown } | undefined;
      const detailDimensions = Array.isArray(details.dimensions) ? details.dimensions : [];
      const status = check.status === "PASS" && bindingValid && details.observedReviewerIdentity === assignment.reviewerIdentity
        && details.policyDigest === identity.policyDigest && details.impactDigest === compilation.impactDigest
        && detailCandidate !== undefined && sameCandidateBinding(detailCandidate as never, compilation.candidate)
        && detailDimensions.includes(dimension) && details.provider === assignment.provider ? "PASS" : "FAIL";
      output.push({ status, reviewerIdentity: assignment.reviewerIdentity, provider: assignment.provider, sourceId: String(sessionId ?? check.id), digest: sha256Canonical(check), artifact: participant?.resultArtifact, executionBindingDigest: participant?.executionBinding?.digest });
    }
  }
  return output;
}

function makeEvidence(input: { id: string; assertionId: string; kind: AcceptanceEvidenceItemV1["kind"]; status: AcceptanceEvidenceItemV1["status"]; identity: ObjectiveCompletionIdentityV1; strength: AssuranceLevel; sourceId: string; sourceDigest: string; artifact?: string; executionBindingDigest?: string; actorId?: string; actorGeneration?: number; promptDigest?: string; assessment?: string; dimension?: string; reviewerIdentity?: string; provider?: string }): AcceptanceEvidenceItemV1 {
  return { version: 1, id: input.id, assertionId: input.assertionId, kind: input.kind, status: input.status, identity: input.identity, strength: input.strength, provenance: { sourceId: input.sourceId, digest: input.sourceDigest, ...(input.artifact ? { artifact: input.artifact } : {}), ...(input.executionBindingDigest ? { executionBindingDigest: input.executionBindingDigest } : {}), ...(input.actorId ? { actorId: input.actorId } : {}), ...(input.actorGeneration !== undefined ? { actorGeneration: input.actorGeneration } : {}), ...(input.promptDigest ? { promptDigest: input.promptDigest } : {}), ...(input.assessment ? { assessment: input.assessment } : {}) }, ...(input.dimension ? { dimension: input.dimension } : {}), ...(input.reviewerIdentity ? { reviewerIdentity: input.reviewerIdentity } : {}), ...(input.provider ? { provider: input.provider } : {}) };
}

export function evaluateAcceptanceOracleV1(bundle: EvidenceBundleV1, evidenceStrength: CandidateAssuranceCompilationV1["evidenceStrength"], certification?: AcceptanceOracleDispositionV1["certification"]): AcceptanceOracleDispositionV1 {
  const blockers: Array<{ code: string; message: string }> = [];
  if (!bundle || bundle.version !== 1 || !bundle.identity || !Array.isArray(bundle.requirements) || !Array.isArray(bundle.evidence)) {
    blockers.push(blocker("EVIDENCE_BUNDLE_INVALID", "EvidenceBundle must have version 1 identity, requirements, and evidence arrays."));
  }
  const { digest, ...body } = bundle;
  if (digest !== sha256Canonical(body)) blockers.push(blocker("EVIDENCE_BUNDLE_DIGEST_INVALID", "EvidenceBundle digest does not match its content."));
  const assertionIds = bundle.requirements.map((item) => item.assertionId).sort();
  if (new Set(assertionIds).size !== assertionIds.length) blockers.push(blocker("VERIFICATION_REQUIREMENT_DUPLICATE", "each AcceptanceAssertion must have exactly one VerificationRequirement."));
  const evidenceIds = new Set<string>();
  for (const item of bundle.evidence) {
    if (!item || item.version !== 1 || !item.id || evidenceIds.has(item.id)) blockers.push(blocker("EVIDENCE_ITEM_INVALID", `Evidence item '${String(item?.id)}' is invalid or duplicated.`));
    evidenceIds.add(item.id);
    if (sha256Canonical(item.identity) !== sha256Canonical(bundle.identity)) blockers.push(blocker("EVIDENCE_IDENTITY_STALE", `Evidence item '${item.id}' is not bound to the current objective identity.`));
    if (!/^[a-f0-9]{64}$/.test(item.provenance.digest)) blockers.push(blocker("EVIDENCE_PROVENANCE_INVALID", `Evidence item '${item.id}' lacks a canonical provenance digest.`));
  }
  for (const assertionId of assertionIds) {
    const requirement = bundle.requirements.find((item) => item.assertionId === assertionId)!;
    if (requirement.validationRequirementIds.length === 0) blockers.push(blocker("VERIFICATION_VALIDATION_PATH_MISSING", `assertion '${assertionId}' has no resolved candidate-bound validation requirement.`));
    for (const validationId of requirement.validationRequirementIds) {
      const items = bundle.evidence.filter((item) => item.kind === "VALIDATION" && item.assertionId === assertionId && item.id.startsWith(`validation:${validationId}:`));
      if (items.length !== 1 || items[0]?.status !== "PASS") blockers.push(blocker("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT", `assertion '${assertionId}' requires exactly one passing validation item for '${validationId}'.`));
    }
    for (const dimension of requirement.reviewDimensions) {
      const items = bundle.evidence.filter((item) => item.kind === "REVIEW" && item.assertionId === assertionId && item.dimension === dimension && item.status === "PASS");
      const reviewers = new Set(items.map((item) => item.reviewerIdentity).filter((value): value is string => Boolean(value)));
      if (reviewers.size < evidenceStrength.minimumIndependentReviewers) blockers.push(blocker("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT", `assertion '${assertionId}' has ${reviewers.size} independent reviewers for '${dimension}', below ${evidenceStrength.minimumIndependentReviewers}.`));
      if (evidenceStrength.providerDiversity && new Set(items.map((item) => item.provider).filter(Boolean)).size < Math.min(2, evidenceStrength.minimumIndependentReviewers)) blockers.push(blocker("VERIFICATION_REVIEW_DIVERSITY_INSUFFICIENT", `assertion '${assertionId}' lacks required provider diversity for '${dimension}'.`));
    }
    if (requirement.leadRequired) {
      const items = bundle.evidence.filter((item) => item.kind === "LEAD" && item.assertionId === assertionId);
      if (items.length !== 1 || items[0]?.status !== "PASS") blockers.push(blocker("VERIFICATION_LEAD_EVIDENCE_INSUFFICIENT", `assertion '${assertionId}' requires current independent Lead semantic evidence.`));
    }
    const supportedStrength = Math.max(0, ...bundle.evidence.filter((item) => item.assertionId === assertionId && item.status === "PASS" && item.kind !== "LEAD").map((item) => assuranceRank[item.strength]));
    if (supportedStrength < assuranceRank[requirement.minimumAssurance]) blockers.push(blocker("VERIFICATION_STRENGTH_INSUFFICIENT", `current non-Lead evidence for assertion '${assertionId}' is below ${requirement.minimumAssurance}.`));
  }
  if (evidenceStrength.requiredDimensions.some((dimension) => !bundle.requirements.some((item) => item.reviewDimensions.includes(dimension)))) blockers.push(blocker("VERIFICATION_REVIEW_DIMENSION_UNCOVERED", "not every policy-required review dimension maps to an AcceptanceAssertion."));
  const certificationRequired = certification !== undefined;
  if (certificationRequired && (certification!.status !== "PASS" || sha256Canonical(certification!.identity) !== sha256Canonical(bundle.identity) || !/^[a-f0-9]{64}$/.test(certification!.provenanceDigest))) blockers.push(blocker("CERTIFICATION_EVIDENCE_INSUFFICIENT", "policy-required CertificationCore evidence is missing, failed, stale, or lacks provenance."));
  const orderedBlockers = [...new Map(blockers.map((item) => [`${item.code}\0${item.message}`, item])).values()].sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  const coveredAssertionIds = orderedBlockers.length === 0 ? assertionIds : [];
  const withoutDigest = {
    version: 1 as const,
    disposition: orderedBlockers.length === 0 ? "ACCEPTED" as const : "REJECTED" as const,
    identity: bundle.identity,
    evidenceBundleDigest: bundle.digest,
    requiredAssertionIds: assertionIds,
    coveredAssertionIds,
    certificationRequired,
    ...(certification ? { certification } : {}),
    blockers: orderedBlockers
  };
  return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}

export function candidateForAcceptance(operation: OperationRecordV2): CandidateRevisionV1 {
  if (!operation.candidateRevision) throw new Error("ACCEPTANCE_CANDIDATE_REQUIRED: current operation candidate is required.");
  return operation.candidateRevision;
}

export async function persistAcceptanceOracleArtifactV1(root: string, bundle: EvidenceBundleV1, disposition: AcceptanceOracleDispositionV1): Promise<string> {
  if (disposition.evidenceBundleDigest !== bundle.digest
    || sha256Canonical(disposition.identity) !== sha256Canonical(bundle.identity)) {
    throw new Error("ACCEPTANCE_ORACLE_PERSIST_REJECTED: only a matching controller-evaluated disposition can be persisted as the current acceptance artifact.");
  }
  const { digest: bundleDigest, ...bundleBody } = bundle;
  const { digest: dispositionDigest, ...dispositionBody } = disposition;
  if (bundleDigest !== sha256Canonical(bundleBody) || dispositionDigest !== sha256Canonical(dispositionBody)) throw new Error("ACCEPTANCE_ORACLE_PERSIST_REJECTED: bundle or disposition digest is invalid.");
  const directory = path.join(operationArtifactDirectory(root, bundle.identity.operationId), "acceptance");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `oracle-${sha256Canonical(bundle.identity)}.json`);
  const artifact: AcceptanceOracleArtifactV1 = {
    version: 1,
    operationId: bundle.identity.operationId,
    identity: bundle.identity,
    evidenceBundle: bundle,
    disposition,
    persistedAt: new Date().toISOString()
  };
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  return path.relative(path.resolve(root), file).replaceAll("\\", "/");
}

export async function loadCurrentAcceptanceOracleArtifactV1(root: string, operation: OperationRecordV2): Promise<AcceptanceOracleArtifactV1 | undefined> {
  const identity = currentObjectiveIdentityV1(operation);
  const file = path.join(operationArtifactDirectory(root, operation.id), "acceptance", `oracle-${sha256Canonical(identity)}.json`);
  let artifact: AcceptanceOracleArtifactV1;
  try { artifact = JSON.parse(await fs.readFile(file, "utf8")) as AcceptanceOracleArtifactV1; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  if (artifact.version !== 1 || artifact.operationId !== operation.id
    || sha256Canonical(artifact.identity) !== sha256Canonical(identity)
    || sha256Canonical(artifact.evidenceBundle.identity) !== sha256Canonical(identity)
    || sha256Canonical(artifact.disposition.identity) !== sha256Canonical(identity)
    || artifact.evidenceBundle.digest !== artifact.disposition.evidenceBundleDigest
    || !["ACCEPTED", "REJECTED"].includes(artifact.disposition.disposition)
    || artifact.disposition.disposition === "ACCEPTED" && sha256Canonical(artifact.disposition.requiredAssertionIds) !== sha256Canonical(artifact.disposition.coveredAssertionIds)) {
    throw new Error("ACCEPTANCE_ORACLE_ARTIFACT_STALE: persisted disposition is not the current accepted candidate/policy/execution/epoch result.");
  }
  const { digest: dispositionDigest, ...dispositionBody } = artifact.disposition;
  if (dispositionDigest !== sha256Canonical(dispositionBody)) throw new Error("ACCEPTANCE_ORACLE_ARTIFACT_INVALID: disposition digest does not match its content.");
  const { digest: bundleDigest, ...bundleBody } = artifact.evidenceBundle;
  if (bundleDigest !== sha256Canonical(bundleBody)) throw new Error("ACCEPTANCE_ORACLE_ARTIFACT_INVALID: EvidenceBundle digest does not match its content.");
  return artifact;
}

export async function requireAcceptedCurrentOracleV1(root: string, operation: OperationRecordV2, candidate: CandidateRevisionV1): Promise<AcceptanceOracleArtifactV1> {
  const artifact = await loadCurrentAcceptanceOracleArtifactV1(root, operation);
  if (!artifact || artifact.disposition.disposition !== "ACCEPTED" || !operation.candidateRevision || !candidateRevisionsEqual(candidate, operation.candidateRevision)) {
    throw new Error("ACCEPTANCE_ORACLE_REQUIRED: delivery effects require a persisted accepted AcceptanceOracle disposition bound to the current candidate, policy, execution revision, and controller epoch.");
  }
  return artifact;
}

function operationArtifactDirectory(root: string, operationId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new Error("ACCEPTANCE_OPERATION_ID_INVALID: operation artifact identity is malformed.");
  return path.resolve(root, ".harness", "operations", operationId);
}
