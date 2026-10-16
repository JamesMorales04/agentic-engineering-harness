import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutedContract } from "../src/core/contract.js";
import { sealTask, verifyTaskSeal } from "../src/core/seal.js";
import { sha256Canonical } from "../src/core/digest.js";
import { contractValidationRequirementsV1, resolveValidationRequirements, validationRequirementKindValues } from "../src/architecture/validationRequirements.js";
import { contractValidationSourcesForContractV1 } from "../src/core/contract.js";
import { compileCandidateAssuranceV1 } from "../src/architecture/candidateAssurance.js";
import { buildAcceptanceEvidenceBundleV1, evaluateAcceptanceOracleV1 } from "../src/architecture/acceptanceOracle.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { buildRequirementEvidenceGraph } from "../src/evidence/graph.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { triageChange } from "../src/core/triage.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport } from "../src/core/types.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const digest = (value: unknown) => sha256Canonical(value);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function tmpRoot(packageJson?: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d24-direct-proposal-"));
  roots.push(root);
  if (packageJson !== undefined) await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

const bareConfig = { version: 1, project: { name: "d24-fixture" } } as HarnessProjectConfig;
const acceptance = [
  "range(n) iterates while i < n per REQ-RANGE",
  "the only source change is the loop bound in src/tasks.js"
];

function candidate(source = "source-d24") {
  return createCandidateRevisionV1({ operationId: "OP-D24", candidateId: "candidate:OP-D24:r1", projectId: "project-d24", taskId: "TASK-D24", revision: 1, sourceDigest: digest(source) });
}

function frozenPolicy(current = candidate()) {
  return compileResolvedOperationPolicy({
    projectId: current.projectId!,
    operationId: current.operationId,
    operationExecutionRevision: 1,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    intent: "d24 direct proposal",
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
    root: "/tmp/aeh-d24",
    payload: { request: "d24 fixture", taskId: current.taskId },
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

function emptyImpact(current = candidate()) {
  const body = {
    version: 1 as const,
    candidate: { candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest },
    baseCandidate: { candidateId: current.candidateId, revision: 1, identityDigest: current.identityDigest },
    patchDigest: digest("patch-d24"),
    changedFiles: ["src/tasks.js"],
    changeKinds: ["source"],
    reviewDimensions: [] as string[],
    requiresIndependentReview: false,
    interpretation: "MODEL" as const,
    unknowns: []
  };
  return { ...body, digest: digest(body) };
}

describe("D24 DIRECT test-script authoring proposal", () => {
  it("proposes the project test script as a declared AC validator for DIRECT when no validation is configured", async () => {
    const root = await tmpRoot({ scripts: { test: "playwright test --reporter=list" } });
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-A", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    expect(contract.routing?.route).toBe("DIRECT");
    expect(contract.requirements?.map((item) => [item.id, item.validators])).toEqual([
      ["AC-1", ["command.test"]],
      ["AC-2", ["command.test"]]
    ]);
    expect(contract.verification?.commands).toEqual([expect.objectContaining({ id: "test", command: "npm test", required: true })]);
  });

  it("leaves validator-less ACs unchanged when no test script exists", async () => {
    const root = await tmpRoot({ scripts: { start: "node src/server.js" } });
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-B", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    expect(contract.routing?.route).toBe("DIRECT");
    expect(contract.requirements?.map((item) => item.validators)).toEqual([[], []]);
    expect(contract.verification).toBeUndefined();
  });

  it("leaves validator-less ACs unchanged when package.json is absent", async () => {
    const root = await tmpRoot();
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-C", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    expect(contract.requirements?.map((item) => item.validators)).toEqual([[], []]);
    expect(contract.verification).toBeUndefined();
  });

  it("explicit user-declared validators take precedence and are never overwritten", async () => {
    const root = await tmpRoot({ scripts: { test: "vitest run" } });
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-D", {
      title: "Explicit validation", request: "add an export", scope: ["src/greeting.mjs"],
      requirements: [{ id: "R-1", description: "explicitly validated", validators: ["custom-check"] }]
    });
    expect(contract.requirements).toEqual([expect.objectContaining({ id: "R-1", validators: ["custom-check"] })]);
    expect(contract.verification).toBeUndefined();
  });

  it("suppresses the proposal entirely when any input requirement declares explicit validators", async () => {
    const root = await tmpRoot({ scripts: { test: "vitest run" } });
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-D2", {
      title: "Mixed validation", request: "add an export", scope: ["src/greeting.mjs"],
      requirements: [
        { id: "R-1", description: "explicitly validated", validators: ["custom-check"] },
        { id: "R-2", description: "left bare" },
      ]
    });
    // A partially explicit intent signals manual validation design: auto-attaching
    // `npm test` to the remaining bare requirement would surprise, so the proposal
    // stays off and the bare requirement keeps the fail-closed empty set.
    expect(contract.requirements).toEqual([
      expect.objectContaining({ id: "R-1", validators: ["custom-check"] }),
      expect.objectContaining({ id: "R-2", validators: [] }),
    ]);
    expect(contract.verification).toBeUndefined();
  });

  it("configured project validators win over the test-script proposal", async () => {
    const root = await tmpRoot({ scripts: { test: "vitest run" } });
    const config = {
      version: 1,
      project: { name: "d24-fixture" },
      validation: { commands: [{ id: "fixture-greeting", command: "node scripts/validate.mjs", required: true }] }
    } as HarnessProjectConfig;
    const { contract } = await createRoutedContract(root, config, "TASK-D24-E", {
      title: "Configured validation", request: "add an export", scope: ["src/greeting.mjs"], acceptance: ["greeting passes"]
    });
    expect(contract.requirements).toEqual([expect.objectContaining({ id: "AC-1", validators: ["command.fixture-greeting"] })]);
    expect(contract.verification).toBeUndefined();
  });

  it("non-DIRECT routes are untouched by the proposal", async () => {
    const root = await tmpRoot({ scripts: { test: "vitest run" } });
    const floor = triageChange(bareConfig, { request: "fix range(n) loop bound", files: ["src/tasks.js"], risk: "low" });
    const delegated = { ...floor, route: "DELEGATED" as const, assurance: "STANDARD" as const };
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-F", {
      title: "Delegated fix", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance, routeDecision: delegated
    });
    expect(contract.routing?.route).toBe("DELEGATED");
    expect(contract.requirements?.map((item) => item.validators)).toEqual([[], []]);
    expect(contract.verification).toBeUndefined();
  });

  it("the proposal flows to a passing oracle gate in a synthetic compilation", async () => {
    const root = await tmpRoot({ scripts: { test: "playwright test --reporter=list" } });
    const { contract } = await createRoutedContract(root, bareConfig, "TASK-D24-G", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    const current = candidate("source-d24-g");
    const derived = contractValidationRequirementsV1(contractValidationSourcesForContractV1(contract, bareConfig));
    expect(derived.map((item) => [item.id, item.kind])).toEqual([["command.test", "command"]]);

    const resolution = await resolveValidationRequirements({ root, requirements: derived, config: bareConfig, contract });
    expect(resolution.blocked).toEqual([]);
    expect(resolution.actions.map((action) => [action.requirementId, action.source, action.selector, action.command])).toEqual([
      ["command.test", "configured-command", "test", "npm test"]
    ]);

    const impactBody = emptyImpact(current);
    const compilation = compileCandidateAssuranceV1({
      candidate: current,
      impact: impactBody,
      policy: {
        version: 1, digest: frozenPolicy(current).digest, minimumAssurance: "NONE",
        independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false,
        allowedValidationKinds: [...validationRequirementKindValues], evidenceStrength: "NONE"
      },
      implementationIdentity: "implementer",
      risk: "low",
      reviewerCandidates: [],
      baseValidationRequirements: derived,
      validationResolution: resolution,
      acceptanceAssertions: (contract.requirements ?? []).map((requirement) => ({
        id: requirement.id, statement: requirement.description ?? requirement.id, requirementRefs: [requirement.id]
      }))
    });
    expect(compilation.status).toBe("READY");

    const checks: ValidationCheck[] = [{ id: "command.test", category: "command", status: "PASS", message: "test passed." }];
    const report = { version: 1, taskId: contract.task.id, status: "PASS", candidate: current, changedFiles: ["src/tasks.js"], checks } as unknown as ValidationReport;
    const bundle = buildAcceptanceEvidenceBundleV1({ operation: operation(current), compilation, report, implementationIdentity: "implementer" });
    const oracle = evaluateAcceptanceOracleV1(bundle, compilation.evidenceStrength, undefined, ["src/tasks.js"]);
    expect(oracle.blockers).toEqual([]);
    expect(oracle.disposition).toBe("ACCEPTED");

    const graphReport = { version: 1, taskId: contract.task.id, status: "PASS", changedFiles: ["src/tasks.js"], checks } as unknown as ValidationReport;
    const graph = await buildRequirementEvidenceGraph({
      root,
      config: { version: 1, project: { name: "d24-fixture" }, evidence: { enabled: true, outputDir: ".harness/evidence" } } as unknown as HarnessProjectConfig,
      contract: contract as TaskContract,
      report: graphReport
    });
    expect(graph.complete).toBe(true);
  });

  it("sealed digests reflect the proposal", async () => {
    const root = await tmpRoot({ scripts: { test: "vitest run" } });
    const { contract, file } = await createRoutedContract(root, bareConfig, "TASK-D24-H", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    await sealTask(root, bareConfig, contract);
    expect((await verifyTaskSeal(root, contract, true)).status).toBe("PASS");

    const YAML = await import("yaml");
    const tampered = { ...contract, requirements: contract.requirements?.map((item) => ({ ...item, validators: [] as string[] })) } as TaskContract;
    await fs.writeFile(file, YAML.stringify(tampered));
    const tamperedSeal = await verifyTaskSeal(root, tampered, true);
    expect(tamperedSeal.status).toBe("FAIL");
    expect(tamperedSeal.message).toContain(file.replace(/\\/g, "/").split("/").at(-1) ?? ".harness/contracts/TASK-D24-H.yaml");

    const plainRoot = await tmpRoot({ scripts: { start: "node src/server.js" } });
    const plain = await createRoutedContract(plainRoot, bareConfig, "TASK-D24-H", {
      title: "Fix range(n) off-by-one", request: "fix range(n) loop bound", scope: ["src/tasks.js"], acceptance
    });
    expect(sha256Canonical(contract.requirements)).not.toBe(sha256Canonical(plain.contract.requirements));
  });
});
