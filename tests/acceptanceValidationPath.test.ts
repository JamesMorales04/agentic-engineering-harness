import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateImpactValidationRequirementsV1, compileCandidateAssuranceV1, type CandidateAssuranceCompilationV1 } from "../src/architecture/candidateAssurance.js";
import {
  buildAcceptanceEvidenceBundleV1,
  evaluateAcceptanceOracleV1,
  resolveVerificationRequirementsV1
} from "../src/architecture/acceptanceOracle.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { runCandidateImpactValidations } from "../src/core/run.js";
import { contractValidationRequirementsV1, dropUnresolvablePlanValidationRequirementsV1, mergeContractValidationRequirementsV1, resolveValidationRequirements, validationRequirementKindValues, type ValidationRequirementV1 } from "../src/architecture/validationRequirements.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport } from "../src/core/types.js";
import { buildRequirementEvidenceGraph } from "../src/evidence/graph.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const digest = (value: unknown) => sha256Canonical(value);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const projectId = "project-0099";

function candidate(source = "source-0099") {
  return createCandidateRevisionV1({ operationId: "OP-0099", candidateId: "candidate:OP-0099:r1", projectId, taskId: "TASK-0099", revision: 1, sourceDigest: digest(source) });
}

function frozenPolicy(current = candidate()) {
  return compileResolvedOperationPolicy({
    projectId: current.projectId!,
    operationId: current.operationId,
    operationExecutionRevision: 1,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    intent: "0099 acceptance validation path",
    route: "DIRECT",
    minimumAssurance: "NONE",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false, independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false },
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
}

function operation(current = candidate()): OperationRecordV2 {
  return {
    version: 2,
    id: current.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "review",
    root: "/tmp/aeh-0099",
    payload: { request: "0099 fixture", taskId: current.taskId },
    revision: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    operationExecutionRevision: 1,
    resolvedOperationPolicy: frozenPolicy(current),
    controller: { epoch: 1, ownerId: "controller-1", claimedAt: "2026-01-01T00:00:00.000Z" }
  } as OperationRecordV2;
}

function impact(current = candidate(), dimensions = ["public API"]) {
  const body = {
    version: 1 as const,
    candidate: { candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest },
    baseCandidate: { candidateId: current.candidateId, revision: 1, identityDigest: current.identityDigest },
    patchDigest: digest("patch-0099"),
    changedFiles: ["src/greeting.mjs"],
    changeKinds: ["source"],
    reviewDimensions: dimensions,
    requiresIndependentReview: false,
    interpretation: "MODEL" as const,
    unknowns: []
  };
  return { ...body, digest: digest(body) };
}

const configuredCommands = [{ id: "fixture-greeting", command: "node scripts/validate.mjs", required: true }];
const configuredValidators = [{ id: "contract-test", adapter: "contract-test", command: "node scripts/contract.mjs", required: true }];
const projectConfig = { version: 1, project: { name: "0099" }, validation: { commands: configuredCommands, validators: configuredValidators } } as HarnessProjectConfig;

function contractFor(validators: string[]): TaskContract {
  return {
    version: 1,
    task: { id: "TASK-0099", title: "0099" },
    git: { baseRef: "main" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", route: "DIRECT", assurance: "NONE" },
    requirements: [{ id: "AC-1", description: "greeting acceptance requirement", validators }]
  } as TaskContract;
}

async function compileFixture(input: { contractValidators: string[]; checks: ValidationCheck[]; current?: ReturnType<typeof candidate> }) {
  const current = input.current ?? candidate();
  const contract = contractFor(input.contractValidators);
  const derived = contractValidationRequirementsV1({
    requirements: contract.requirements!,
    scope: contract.scope?.allowed ?? ["**"],
    commands: configuredCommands,
    validators: configuredValidators
  });
  const impactBody = impact(current);
  const generated = candidateImpactValidationRequirementsV1(impactBody);
  const resolution = await resolveValidationRequirements({ root: "/nonexistent-0099-root", requirements: [...derived, ...generated], config: projectConfig, contract });
  const compilation = compileCandidateAssuranceV1({
    candidate: current,
    impact: impactBody,
    policy: {
      version: 1,
      digest: frozenPolicy(current).digest,
      minimumAssurance: "NONE",
      independentReviewRequired: false,
      minimumIndependentReviewers: 0,
      providerDiversity: false,
      allowedValidationKinds: [...validationRequirementKindValues],
      evidenceStrength: "NONE"
    },
    implementationIdentity: "implementer",
    risk: "low",
    reviewerCandidates: [{ identity: "reviewer", role: "Reviewer", provider: "test", readOnly: true }],
    baseValidationRequirements: derived,
    validationResolution: resolution,
    acceptanceAssertions: contract.requirements!.map((requirement) => ({ id: requirement.id, statement: requirement.description ?? requirement.id, requirementRefs: [requirement.id] }))
  });
  const report = { version: 1, taskId: contract.task.id, status: "PASS", candidate: current, changedFiles: ["src/greeting.mjs"], checks: input.checks } as unknown as ValidationReport;
  return { current, contract, compilation, report };
}

function bundleFor(compilation: CandidateAssuranceCompilationV1, report: ValidationReport, current: ReturnType<typeof candidate>) {
  return buildAcceptanceEvidenceBundleV1({ operation: operation(current), compilation, report, implementationIdentity: "implementer" });
}

function reportWithChecks(compilation: CandidateAssuranceCompilationV1, checks: ValidationCheck[], current: ReturnType<typeof candidate>): ValidationReport {
  return { version: 1, taskId: "TASK-0099", status: checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS", candidate: current, changedFiles: ["src/greeting.mjs"], checks } as unknown as ValidationReport;
}

function commandCheck(id: string, status: "PASS" | "FAIL" = "PASS"): ValidationCheck {
  return { id, category: "command", status, message: `${id} ${status}` };
}

function impactValidationCheck(compilation: CandidateAssuranceCompilationV1, requirementId: string, status: "PASS" | "FAIL" = "PASS", candidateOverride?: { candidateId: string; revision: number; identityDigest: string }): ValidationCheck {
  return {
    id: `candidate.assurance.validation.${requirementId}`,
    category: "candidate-impact-validation",
    status,
    message: `${requirementId} ${status}`,
    details: { requirementId, kind: compilation.validationRequirements.find((item) => item.id === requirementId)?.kind, candidate: candidateOverride ?? compilation.candidate, impactDigest: compilation.impactDigest, policyDigest: compilation.policyDigest }
  } as ValidationCheck;
}

describe("AEH-V2-0099 base contract assertion validation path", () => {
  it("resolves repository browser scripts and keeps their impact validations candidate-bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-browser-script-resolution-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
      browser: "npm run generic-browser-check",
      visual: "npm run generic-visual-check",
      "test:browser-e2e": "npm run build && playwright test --config tests/browser/playwright.config.ts",
      "test:browser-visual": "npm run build && tsx scripts/s11BrowserVisualCampaign.ts"
    } }));

    const current = candidate("browser-script-candidate");
    const impactBody = impact(current, ["UI/browser", "UI/visual"]);
    const requirements = candidateImpactValidationRequirementsV1(impactBody);
    const resolution = await resolveValidationRequirements({ root, requirements });

    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions.map(({ requirementId, selector, command }) => ({ requirementId, selector, command }))).toEqual([
      { requirementId: "impact-review-ui-browser", selector: "test:browser-e2e", command: "npm run test:browser-e2e" },
      { requirementId: "impact-review-ui-visual", selector: "test:browser-visual", command: "npm run test:browser-visual" }
    ]);

    const compilation = compileCandidateAssuranceV1({
      candidate: current,
      impact: impactBody,
      policy: {
        version: 1,
        digest: digest("browser-script-policy"),
        minimumAssurance: "NONE",
        independentReviewRequired: false,
        minimumIndependentReviewers: 0,
        providerDiversity: false,
        allowedValidationKinds: ["browser-test", "visual-test"],
        evidenceStrength: "NONE"
      },
      implementationIdentity: "implementer",
      risk: "low",
      reviewerCandidates: [{ identity: "reviewer", role: "Reviewer", provider: "test", readOnly: true }],
      baseValidationRequirements: [],
      validationResolution: resolution,
      acceptanceAssertions: []
    });
    expect(compilation.status).toBe("READY");
    expect(compilation.candidate).toMatchObject({ candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest });
    expect(compilation.validationRequirements.map(({ id, kind }) => [id, kind])).toEqual([
      ["impact-review-ui-browser", "browser-test"],
      ["impact-review-ui-visual", "visual-test"]
    ]);
  });

  it("reproduces the defect: a compilation without a base requirement leaves AC-1 unresolved and fails VERIFICATION_VALIDATION_PATH_MISSING", () => {
    const current = candidate();
    const compilation = compileCandidateAssuranceV1({
      candidate: current,
      impact: impact(current),
      policy: { version: 1, digest: frozenPolicy(current).digest, minimumAssurance: "NONE", independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false, allowedValidationKinds: ["command", "contract-test", "unit-test"], evidenceStrength: "NONE" },
      implementationIdentity: "implementer",
      risk: "low",
      reviewerCandidates: [],
      baseValidationRequirements: [],
      validationResolution: { version: 1, requirements: [], actions: [], blocked: [], digest: digest({ version: 1, requirements: [], actions: [], blocked: [] }) },
      acceptanceAssertions: [{ id: "AC-1", statement: "greeting passes", requirementRefs: ["AC-1"] }]
    });
    const currentOperation = operation(current);
    const requirements = resolveVerificationRequirementsV1(compilation, currentOperation.resolvedOperationPolicy!);
    expect(requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds).toEqual([]);
    const bundle = bundleFor(compilation, reportWithChecks(compilation, [], current), current);
    const oracle = evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength);
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_VALIDATION_PATH_MISSING");
  });

  it("compiles the contract requirements' bound validators into explicit requirements with exact check ids", () => {
    const derived = contractValidationRequirementsV1({
      requirements: [
        { id: "AC-1", validators: ["command.fixture-greeting", "contract-test"] },
        { id: "AC-2", validators: ["command.fixture-greeting", "mystery-validator"] }
      ],
      scope: ["src/**"],
      commands: configuredCommands,
      validators: configuredValidators
    });
    expect(derived.map((item) => item.id)).toEqual(["command.fixture-greeting", "contract-test"]);
    expect(derived.map((item) => item.kind)).toEqual(["command", "contract-test"]);
    expect(derived[0]?.requirementRefs).toEqual(["AC-1", "AC-2"]);
    expect(derived[0]?.acceptanceRefs).toEqual(["AC-1", "AC-2"]);
    expect(derived.every((item) => item.scope.length > 0 && item.evidenceNeeded.length > 0)).toBe(true);
  });

  it("replaces a plan requirement that names the same check id with the frozen contract-derived one (AEH-V2-0118)", () => {
    const plan: ValidationRequirementV1 = {
      version: 1,
      id: "contract-test",
      property: "The configured contract validator passes.",
      kind: "contract-test",
      scope: ["src/greeting.mjs"],
      evidenceNeeded: ["Run node scripts/contract.mjs."],
      requirementRefs: ["AC-1"],
      acceptanceRefs: ["AC-1"]
    };
    const derived = contractValidationRequirementsV1({ requirements: [{ id: "AC-1", validators: ["command.fixture-greeting", "contract-test"] }], scope: ["**"], commands: configuredCommands, validators: configuredValidators });
    const merged = mergeContractValidationRequirementsV1([plan], derived);
    expect(merged.map((item) => item.id)).toEqual(["contract-test", "command.fixture-greeting"]);
    const contractDerived = derived.find((item) => item.id === "contract-test")!;
    expect(merged[0]).toEqual(contractDerived);
    expect(merged[0]?.scope).toEqual(["**"]);
  });

  it("fails closed when a plan requirement reuses a contract check id with an incompatible kind", () => {
    const plan: ValidationRequirementV1 = { version: 1, id: "contract-test", property: "mismatch", kind: "unit-test", scope: ["src/**"], evidenceNeeded: ["unit evidence"], requirementRefs: ["AC-1"], acceptanceRefs: ["AC-1"] };
    const derived = contractValidationRequirementsV1({ requirements: [{ id: "AC-1", validators: ["contract-test"] }], scope: ["**"], commands: configuredCommands, validators: configuredValidators });
    expect(() => mergeContractValidationRequirementsV1([plan], derived)).toThrow(/VALIDATION_REQUIREMENT_ID_CONFLICT/);
  });

  it("keeps resolvable plan requirements and drops unresolvable advisory ones with a deterministic record (AEH-V2-0118)", async () => {
    const requirements: ValidationRequirementV1[] = [
      { version: 1, id: "fixture-greeting", property: "configured command passes", kind: "command", scope: ["src/**"], evidenceNeeded: ["run the fixture validator"], requirementRefs: ["AC-1"], acceptanceRefs: ["AC-1"] },
      { version: 1, id: "internal-format-boundary", property: "module boundary architecture holds", kind: "architecture", scope: ["src/**"], evidenceNeeded: ["architecture evidence"], requirementRefs: ["AC-1"], acceptanceRefs: ["AC-1"] }
    ];
    const resolution = await resolveValidationRequirements({ root: "/nonexistent-0099-root", requirements, config: projectConfig });
    expect(resolution.blocked.map((item) => item.requirementId)).toEqual(["internal-format-boundary"]);
    const partition = dropUnresolvablePlanValidationRequirementsV1(requirements, resolution);
    expect(partition.kept.map((item) => item.id)).toEqual(["fixture-greeting"]);
    expect(partition.dropped.map((item) => item.id)).toEqual(["internal-format-boundary"]);
    const reResolution = await resolveValidationRequirements({ root: "/nonexistent-0099-root", requirements: partition.kept, config: projectConfig });
    expect(reResolution.blocked).toEqual([]);
  });

  it("resolves the derived contract requirements to the approved configured actions", async () => {
    const derived = contractValidationRequirementsV1({ requirements: [{ id: "AC-1", validators: ["command.fixture-greeting", "contract-test"] }], scope: ["**"], commands: configuredCommands, validators: configuredValidators });
    const resolution = await resolveValidationRequirements({ root: "/nonexistent-0099-root", requirements: derived, config: projectConfig });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions.map((action) => [action.requirementId, action.source, action.selector]).sort()).toEqual([
      ["command.fixture-greeting", "configured-command", "fixture-greeting"],
      ["contract-test", "configured-validator", "contract-test"]
    ]);
  });

  it("a base contract assertion resolves its explicitly compiled validation path and no longer fails VERIFICATION_VALIDATION_PATH_MISSING", async () => {
    const { compilation, current } = await compileFixture({ contractValidators: ["command.fixture-greeting", "contract-test"], checks: [] });
    const checks = [commandCheck("command.fixture-greeting"), commandCheck("contract-test"), impactValidationCheck(compilation, "impact-review-public-api")];
    const report = reportWithChecks(compilation, checks, current);
    expect(report.status).toBe("PASS");
    const bundle = bundleFor(compilation, report, current);
    const currentOperation = operation(current);
    const requirements = resolveVerificationRequirementsV1(compilation, currentOperation.resolvedOperationPolicy!);
    expect(requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds).toEqual(["command.fixture-greeting", "contract-test"]);
    expect(bundle.requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds).toEqual(["command.fixture-greeting", "contract-test"]);
    const ac1Validation = bundle.evidence.filter((item) => item.assertionId === "AC-1" && item.kind === "VALIDATION");
    expect(ac1Validation.map((item) => [item.provenance.sourceId, item.status]).sort()).toEqual([
      ["command.fixture-greeting", "PASS"],
      ["contract-test", "PASS"]
    ]);
    const codes = evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength).blockers.map((item) => item.code);
    expect(codes).not.toContain("VERIFICATION_VALIDATION_PATH_MISSING");
    expect(codes).not.toContain("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT");
  });

  it("an unrelated passing validator cannot satisfy the assertion", async () => {
    const { compilation, current } = await compileFixture({ contractValidators: ["command.fixture-greeting"], checks: [] });
    const report = reportWithChecks(compilation, [commandCheck("command.other")], current);
    const bundle = bundleFor(compilation, report, current);
    expect(bundle.evidence.filter((item) => item.assertionId === "AC-1" && item.kind === "VALIDATION" && item.status === "PASS")).toEqual([]);
    const oracle = evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength);
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT");
    expect(oracle.blockers.some((item) => item.message.includes("command.other"))).toBe(false);
  });

  it("a missing required validation path still fails closed", async () => {
    const missing = await compileFixture({ contractValidators: ["command.fixture-greeting"], checks: [] });
    const missingBundle = bundleFor(missing.compilation, missing.report, missing.current);
    expect(missingBundle.requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds).toEqual(["command.fixture-greeting"]);
    expect(evaluateAcceptanceOracleV1(missingBundle, missing.compilation.evidenceStrength).blockers.map((item) => item.code)).toContain("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT");

    const unknown = await compileFixture({ contractValidators: ["mystery-validator"], checks: [] });
    expect(unknown.compilation.validationRequirements.map((item) => item.id)).toEqual(["impact-review-public-api"]);
    const unknownBundle = bundleFor(unknown.compilation, unknown.report, unknown.current);
    expect(unknownBundle.requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds).toEqual([]);
    expect(evaluateAcceptanceOracleV1(unknownBundle, unknown.compilation.evidenceStrength).blockers.map((item) => item.code)).toContain("VERIFICATION_VALIDATION_PATH_MISSING");
  });

  it("candidate-stale validation evidence cannot satisfy the assertion", async () => {
    const { compilation, current } = await compileFixture({ contractValidators: ["command.fixture-greeting"], checks: [] });
    const stale = { candidateId: compilation.candidate.candidateId, revision: compilation.candidate.revision, identityDigest: digest("stale-candidate") };
    const report = reportWithChecks(compilation, [commandCheck("command.fixture-greeting"), impactValidationCheck(compilation, "impact-review-public-api", "PASS", stale)], current);
    const bundle = bundleFor(compilation, report, current);
    expect(bundle.evidence.find((item) => item.assertionId === "impact-acceptance-public-api" && item.kind === "VALIDATION")?.status).toBe("FAIL");
    expect(evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength).blockers.map((item) => item.code)).toContain("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT");
  });

  it("executes a resolved plan requirement with a model-authored id so the oracle sees exactly one check (AEH-V2-0123)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-0123-"));
    roots.push(root);
    const current = candidate("source-0123");
    const commands = [{ id: "fixture-greeting", command: "node -e \"process.exit(0)\"", required: true }];
    const config = { version: 1, project: { name: "0123" }, validation: { commands } } as HarnessProjectConfig;
    const contract = contractFor(["command.fixture-greeting"]);
    const derived = contractValidationRequirementsV1({ requirements: contract.requirements!, scope: contract.scope?.allowed ?? ["**"], commands, validators: [] });
    const plan: ValidationRequirementV1 = { version: 1, id: "architecture-boundary", property: "the module boundary holds", kind: "command", scope: ["src/greeting.mjs"], evidenceNeeded: ["run the architecture check"], requirementRefs: ["AC-1"], acceptanceRefs: ["AC-1"] };
    const base = mergeContractValidationRequirementsV1([plan], derived);
    const impactBody = impact(current, []);
    const requirements = [...base, ...candidateImpactValidationRequirementsV1(impactBody)];
    const resolution = await resolveValidationRequirements({ root, requirements, config, contract });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions.map((action) => [action.requirementId, action.source]).sort()).toEqual([["architecture-boundary", "configured-command"], ["command.fixture-greeting", "configured-command"]]);
    const compilation = compileCandidateAssuranceV1({
      candidate: current,
      impact: impactBody,
      policy: { version: 1, digest: frozenPolicy(current).digest, minimumAssurance: "NONE", independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false, allowedValidationKinds: [...validationRequirementKindValues], evidenceStrength: "NONE" },
      implementationIdentity: "implementer",
      risk: "low",
      reviewerCandidates: [],
      baseValidationRequirements: base,
      validationResolution: resolution,
      acceptanceAssertions: [{ id: "AC-1", statement: "greeting passes", requirementRefs: ["AC-1"] }]
    });
    const report = reportWithChecks(compilation, [commandCheck("command.fixture-greeting")], current);
    const checks = await runCandidateImpactValidations({ root, config, contract, report, impact: impactBody, compilation, resolution, requirements: base.filter((requirement) => requirement.id === "architecture-boundary") });
    expect(checks.map((check) => [check.id, check.status])).toEqual([["candidate.assurance.validation.architecture-boundary", "PASS"]]);
    const bundle = bundleFor(compilation, reportWithChecks(compilation, [...report.checks, ...checks], current), current);
    const codes = evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength).blockers.map((item) => item.code);
    expect(codes).not.toContain("VERIFICATION_VALIDATION_EVIDENCE_INSUFFICIENT");
    expect(codes).not.toContain("VERIFICATION_VALIDATION_PATH_MISSING");
  });

  it("requirement coverage and AcceptanceOracle resolution agree for the same frozen requirement/validator relationship", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-0099-graph-"));
    roots.push(root);
    const contract = contractFor(["command.fixture-greeting"]);
    const report = { version: 1, taskId: contract.task.id, status: "PASS", changedFiles: ["src/greeting.mjs"], checks: [commandCheck("command.fixture-greeting")] } as unknown as ValidationReport;
    const graph = await buildRequirementEvidenceGraph({
      root,
      config: { version: 1, project: { name: "0099" }, evidence: { enabled: true, outputDir: ".harness/evidence" } } as HarnessProjectConfig,
      contract,
      report
    });
    expect(graph.complete).toBe(true);
    const coverage = graph.requirements.find((item) => item.requirementId === "AC-1")!;
    expect(coverage.passingValidators).toEqual(["command.fixture-greeting"]);

    expect(contractValidationRequirementsV1({ requirements: contract.requirements!, scope: contract.scope?.allowed ?? ["**"], commands: configuredCommands, validators: configuredValidators }).map((item) => item.id)).toEqual(coverage.passingValidators);
    const fixture = await compileFixture({ contractValidators: ["command.fixture-greeting"], checks: [commandCheck("command.fixture-greeting")] });
    const resolved = bundleFor(fixture.compilation, fixture.report, fixture.current).requirements.find((item) => item.assertionId === "AC-1")?.validationRequirementIds ?? [];
    expect(resolved).toEqual(coverage.passingValidators);
  });
});
