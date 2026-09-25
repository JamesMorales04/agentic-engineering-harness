import { describe, expect, it } from "vitest";
import { compileCandidateAssuranceV1, candidateImpactValidationRequirementsV1, candidateAssuranceProviderAdapterV1 } from "../src/architecture/candidateAssurance.js";
import type { CandidateImpactV1 } from "../src/candidates/assembler.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { ValidationRequirementV1, ValidationResolutionV1 } from "../src/architecture/validationRequirements.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { sha256Canonical } from "../src/core/digest.js";

const digest = (label: string) => sha256Canonical(label);

function candidate(): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId: "OP-S4",
    candidateId: "candidate:OP-S4:r2",
    projectId: "project-s4",
    taskId: "TASK-S4",
    revision: 2,
    sourceDigest: digest("candidate-source")
  });
}

function impactFor(candidateValue: CandidateRevisionV1, overrides: Partial<Omit<CandidateImpactV1, "version" | "candidate" | "digest">> = {}): CandidateImpactV1 {
  const body = {
    version: 1 as const,
    candidate: { candidateId: candidateValue.candidateId, revision: candidateValue.revision, identityDigest: candidateValue.identityDigest },
    changedFiles: ["src/auth.ts"],
    changeKinds: ["source", "security"],
    reviewDimensions: ["authentication/authorization", "behavior.correctness"],
    requiresIndependentReview: true,
    interpretation: "MODEL" as const,
    unknowns: [],
    ...overrides
  };
  return { ...body, digest: sha256Canonical(body) };
}

function baseRequirement(): ValidationRequirementV1 {
  return {
    version: 1,
    id: "TASK-S4-R1",
    property: "The requested behavior is preserved.",
    kind: "unit-test",
    scope: ["src/auth.ts"],
    evidenceNeeded: ["Passing unit tests"],
    requirementRefs: ["TASK-S4-R1"],
    acceptanceRefs: ["TASK-S4-A1"]
  };
}

function resolutionFor(requirements: ValidationRequirementV1[], blocked: ValidationResolutionV1["blocked"] = []): ValidationResolutionV1 {
  const actions = requirements.map((requirement) => ({
    version: 1 as const,
    requirementId: requirement.id,
    kind: requirement.kind,
    source: "project-script" as const,
    selector: requirement.kind,
    command: "npm test",
    scope: requirement.scope,
    evidenceNeeded: requirement.evidenceNeeded
  }));
  const body = { version: 1 as const, requirements, actions, blocked };
  return { ...body, digest: sha256Canonical(body) };
}

function input(overrides: {
  impact?: CandidateImpactV1;
  minimumAssurance?: "NONE" | "STANDARD" | "ELEVATED" | "CRITICAL";
  independentReviewRequired?: boolean;
  minimumIndependentReviewers?: number;
  providerDiversity?: boolean;
  allowedValidationKinds?: ValidationRequirementV1["kind"][];
  reviewers?: Array<{ identity: string; role: string; provider: string; readOnly: boolean }>;
  implementationIdentity?: string;
  risk?: "low" | "medium" | "high";
  blockedValidationIds?: string[];
} = {}) {
  const candidateValue = candidate();
  const impact = overrides.impact ?? impactFor(candidateValue);
  const baseValidationRequirements = [baseRequirement()];
  const validationRequirements = [...baseValidationRequirements, ...candidateImpactValidationRequirementsV1(impact)];
  const blockedIds = new Set(overrides.blockedValidationIds ?? []);
  const resolution = resolutionFor(
    validationRequirements,
    validationRequirements.filter((requirement) => blockedIds.has(requirement.id)).map((requirement) => ({ requirementId: requirement.id, reason: "no approved validator resolves this requirement" }))
  );
  return {
    candidate: candidateValue,
    impact,
    policy: {
      version: 1 as const,
      digest: digest("frozen-policy"),
      minimumAssurance: overrides.minimumAssurance ?? "STANDARD",
      independentReviewRequired: overrides.independentReviewRequired ?? false,
      minimumIndependentReviewers: overrides.minimumIndependentReviewers ?? 0,
      providerDiversity: overrides.providerDiversity ?? false,
      allowedValidationKinds: overrides.allowedValidationKinds ?? ["unit-test", "integration-test", "contract-test", "browser-test", "static-security", "dependency-security", "architecture", "policy", "command", "bdd"] as ValidationRequirementV1["kind"][],
      evidenceStrength: overrides.minimumAssurance ?? "STANDARD"
    },
    implementationIdentity: overrides.implementationIdentity ?? "implementer-1",
    risk: overrides.risk ?? "low" as const,
    reviewerCandidates: overrides.reviewers ?? [
      { identity: "reviewer-a", role: "Reviewer", provider: "provider-a", readOnly: true },
      { identity: "reviewer-b", role: "Reviewer", provider: "provider-b", readOnly: true }
    ],
    baseValidationRequirements,
    validationResolution: resolution,
    acceptanceAssertions: [{ id: "TASK-S4-A1", statement: "The requested behavior is observable.", requirementRefs: ["TASK-S4-R1"] }]
  };
}

describe("candidate impact assurance recompilation", () => {
  it("uses a specialized adapter only for its matching approved provider", () => {
    expect(candidateAssuranceProviderAdapterV1("browser-test", "playwright")).toBe("playwright");
    expect(candidateAssuranceProviderAdapterV1("static-security", "opengrep")).toBe("opengrep");
    expect(candidateAssuranceProviderAdapterV1("dependency-security", "trivy")).toBe("trivy");
    expect(candidateAssuranceProviderAdapterV1("browser-test", "project-native-test")).toBeUndefined();
    expect(candidateAssuranceProviderAdapterV1("architecture", "project-native-test")).toBeUndefined();
  });

  it("binds compilation and generated validation needs to the exact assembled candidate", () => {
    const candidateValue = candidate();
    const impact = impactFor(candidateValue);
    const requirements = candidateImpactValidationRequirementsV1(impact);
    expect(requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "integration-test", scope: ["src/auth.ts"] }),
      expect.objectContaining({ kind: "unit-test", scope: ["src/auth.ts"] })
    ]));
    const result = compileCandidateAssuranceV1(input({ impact }));
    expect(result).toMatchObject({
      status: "READY",
      candidate: { candidateId: candidateValue.candidateId, revision: candidateValue.revision, identityDigest: candidateValue.identityDigest },
      impactDigest: impact.digest,
      minimumAssurance: "CRITICAL",
      evidenceStrength: { minimumAssurance: "CRITICAL", minimumIndependentReviewers: 1, requiredDimensions: ["authentication/authorization", "behavior.correctness"] }
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never lowers the frozen assurance floor and only raises it for impact", () => {
    expect(compileCandidateAssuranceV1(input({ minimumAssurance: "CRITICAL" })).minimumAssurance).toBe("CRITICAL");
    expect(compileCandidateAssuranceV1(input({ minimumAssurance: "NONE" })).minimumAssurance).toBe("CRITICAL");
  });

  it("rejects missing impact instead of falling back to weaker assurance", () => {
    expect(() => compileCandidateAssuranceV1({ ...input(), impact: undefined as unknown as CandidateImpactV1 })).toThrow(/candidate impact/i);
  });

  it("assigns configured read-only independent reviewers to every required dimension", () => {
    const result = compileCandidateAssuranceV1(input({
      reviewers: [
        { identity: "implementer-1", role: "Reviewer", provider: "provider-a", readOnly: true },
        { identity: "writable-reviewer", role: "Reviewer", provider: "provider-a", readOnly: false },
        { identity: "wrong-role", role: "Implementer", provider: "provider-b", readOnly: true },
        { identity: "reviewer-a", role: "Reviewer", provider: "provider-a", readOnly: true },
        { identity: "reviewer-b", role: "Reviewer", provider: "provider-b", readOnly: true }
      ],
      minimumIndependentReviewers: 2,
      providerDiversity: true
    }));
    expect(result.reviewAssignments).toEqual([
      expect.objectContaining({ reviewerIdentity: "reviewer-a", dimensions: ["authentication/authorization", "behavior.correctness"] }),
      expect.objectContaining({ reviewerIdentity: "reviewer-b", dimensions: ["authentication/authorization", "behavior.correctness"] })
    ]);
  });

  it("blocks when independent review is required but no eligible Reviewer identity exists", () => {
    const result = compileCandidateAssuranceV1(input({ reviewers: [] }));
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.join(" ")).toMatch(/independent reviewer/i);
    expect(result.reviewAssignments).toEqual([]);
  });

  it("does not count an unlabeled provider toward a provider-diversity floor", () => {
    const result = compileCandidateAssuranceV1(input({
      reviewers: [
        { identity: "reviewer-a", role: "Reviewer", provider: "provider-a", readOnly: true },
        { identity: "reviewer-b", role: "Reviewer", provider: "", readOnly: true }
      ],
      minimumIndependentReviewers: 2,
      providerDiversity: true
    }));
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.join(" ")).toMatch(/distinct providers/);
    expect(result.reviewAssignments).toEqual([]);
  });

  it("blocks an unresolved impact dimension with no approved validation resolution", () => {
    const setup = input();
    const requirement = candidateImpactValidationRequirementsV1(setup.impact)[0];
    const blocked = input({ blockedValidationIds: [requirement.id] });
    const result = compileCandidateAssuranceV1(blocked);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.join(" ")).toContain(requirement.id);
  });

  it("binds acceptance assertions and required evidence to candidate, impact, and policy", () => {
    const result = compileCandidateAssuranceV1(input());
    expect(result.acceptanceAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimensions: ["authentication/authorization"],
        candidate: { candidateId: "candidate:OP-S4:r2", revision: 2, identityDigest: expect.any(String) },
        impactDigest: result.impactDigest,
        policyDigest: digest("frozen-policy"),
        evidenceStrength: "CRITICAL"
      })
    ]));
  });

  it("blocks unresolved high-risk candidate impact and rejects stale impact binding", () => {
    const candidateValue = candidate();
    const unresolved = impactFor(candidateValue, { interpretation: "BLOCKED", reviewDimensions: [], unknowns: ["impact could not be determined"] });
    expect(compileCandidateAssuranceV1(input({ impact: unresolved, risk: "high" })).status).toBe("BLOCKED");

    const staleCandidate = { ...candidateValue, revision: candidateValue.revision + 1 };
    expect(() => compileCandidateAssuranceV1({ ...input(), candidate: staleCandidate })).toThrow(/candidate.*impact|impact.*candidate/i);
  });

  it("rejects a tampered impact or validation resolution instead of accepting stale evidence", () => {
    const setup = input();
    const tamperedImpact = { ...setup.impact, reviewDimensions: ["security"] };
    expect(() => compileCandidateAssuranceV1(input({ impact: tamperedImpact }))).toThrow(/impact digest/i);

    const changedResolution = {
      ...setup.validationResolution,
      actions: setup.validationResolution.actions.map((action, index) => index === 0 ? { ...action, scope: ["different/path.ts"] } : action)
    };
    expect(() => compileCandidateAssuranceV1({ ...setup, validationResolution: changedResolution })).toThrow(/validationResolution digest/i);
  });

  it("blocks when policy disallows an impact validation kind without lowering the assurance floor", () => {
    const setup = input({ allowedValidationKinds: ["unit-test"] });
    const result = compileCandidateAssuranceV1(setup);
    expect(result.status).toBe("BLOCKED");
    expect(result.minimumAssurance).toBe("CRITICAL");
    expect(result.blockers.join(" ")).toMatch(/DISALLOWED_VALIDATION_KIND/);
  });

  it("produces a stable digest without mutating the impact, policy, or validation inputs", () => {
    const setup = input();
    const before = structuredClone(setup);
    const first = compileCandidateAssuranceV1(setup);
    const second = compileCandidateAssuranceV1(setup);
    expect(first.digest).toBe(second.digest);
    expect(setup).toEqual(before);
  });
});
