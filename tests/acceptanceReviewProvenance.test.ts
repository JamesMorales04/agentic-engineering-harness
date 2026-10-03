import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcceptanceEvidenceBundleV1, evaluateAcceptanceOracleV1, type EvidenceBundleV1 } from "../src/architecture/acceptanceOracle.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, type ExecutionBindingV3 } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { ValidationCheck, ValidationReport } from "../src/core/types.js";
import { initializeProject } from "../src/core/init.js";
import {
  bindOperationParticipantExecution,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
  recordParticipantReceipt,
  registerOperationAgent,
  saveOperation,
  type OperationParticipantRecord,
  type OperationRecordV2
} from "../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";

const digest = (value: unknown) => sha256Canonical(value);
const authorityId = "participant:0123456789abcdef";

const roots: string[] = [];
const environmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROL_ROOT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of environmentKeys) { const value = previousEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function candidate(): CandidateRevisionV1 {
  return createCandidateRevisionV1({ operationId: "OP-0100", candidateId: "candidate:OP-0100:r1", projectId: "project-0100", taskId: "TASK-0100", revision: 1, sourceDigest: digest("source-0100") });
}

function policy(current: CandidateRevisionV1) {
  return compileResolvedOperationPolicy({
    projectId: current.projectId!,
    operationId: current.operationId,
    operationExecutionRevision: 1,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    intent: "0100 review provenance",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false, independentReviewRequired: true, minimumIndependentReviewers: 1, providerDiversity: false },
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
}

function bindingFor(current: CandidateRevisionV1, sessionId: string, overrides: Partial<Parameters<typeof compileExecutionBinding>[0]> = {}): ExecutionBindingV3 {
  return compileExecutionBinding({
    operationId: current.operationId,
    operationExecutionRevision: 1,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    executionBlueprintDigest: digest("blueprint-0100"),
    operationPolicyDigest: policy(current).digest,
    participantId: authorityId,
    participantGeneration: "generation:1",
    roleInvocationPolicyDigest: digest("role-policy-0100"),
    skillManifestDigest: digest("skills-0100"),
    runtime: { runtimeId: "paseo", provider: "test", modelId: "reviewer-model", model: "reviewer-model", sessionId },
    contextManifestDigest: digest("context-0100"),
    promptManifestDigest: digest("prompt-0100"),
    outputContract: "reviewer",
    leaseIdentities: [],
    ...overrides
  });
}

function reviewCompilation(current: CandidateRevisionV1) {
  const frozen = policy(current);
  const body = {
    version: 1 as const,
    candidate: { candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest },
    impactDigest: digest("impact-0100"),
    policyDigest: frozen.digest,
    minimumAssurance: "STANDARD" as const,
    reviewAssignments: [{ reviewerIdentity: "reviewer", provider: "test", dimensions: ["behavior.correctness"], candidate: { candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest }, impactDigest: digest("impact-0100"), policyDigest: frozen.digest }],
    validationRequirements: [{ version: 1 as const, id: "command.fixture-greeting", property: "greeting must pass", kind: "command" as const, scope: ["**"], evidenceNeeded: ["passing command evidence"], requirementRefs: ["AC-1"], acceptanceRefs: ["AC-1"] }],
    acceptanceAssertions: [{ version: 1 as const, id: "AC-1", statement: "greeting passes", requirementRefs: ["AC-1"], candidate: { candidateId: current.candidateId, revision: current.revision, identityDigest: current.identityDigest }, impactDigest: digest("impact-0100"), policyDigest: frozen.digest, dimensions: [], evidenceStrength: "STANDARD" as const }],
    evidenceStrength: { minimumAssurance: "STANDARD" as const, minimumIndependentReviewers: 1, providerDiversity: false, requiredDimensions: ["behavior.correctness"] },
    blockers: [],
    status: "READY" as const
  };
  return { ...body, digest: digest(body) };
}

function reviewCheck(round: number, current: CandidateRevisionV1, sessionId: string, status: "PASS" | "FAIL" = "PASS"): ValidationCheck {
  const compilation = reviewCompilation(current);
  return {
    id: `candidate.assurance.reviewer.${round}.reviewer`,
    category: "candidate-assurance",
    status,
    message: `reviewer evidence round ${round}`,
    details: {
      reviewerIdentity: "reviewer",
      observedReviewerIdentity: "reviewer",
      provider: "test",
      dimensions: ["behavior.correctness"],
      candidate: compilation.candidate,
      impactDigest: compilation.impactDigest,
      policyDigest: compilation.policyDigest,
      sessionId
    }
  };
}

function reportFor(current: CandidateRevisionV1, sessionId: string, checks?: ValidationCheck[]): ValidationReport {
  const command: ValidationCheck = { id: "command.fixture-greeting", category: "command", status: "PASS", message: "greeting command" };
  return { version: 1, taskId: "TASK-0100", status: "PASS", candidate: current, changedFiles: ["src/greeting.mjs"], checks: checks ?? [command, reviewCheck(0, current, sessionId)] } as unknown as ValidationReport;
}

function operationWith(participants: Record<string, OperationParticipantRecord>, current = candidate()): OperationRecordV2 {
  return {
    version: 2,
    id: current.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "review",
    root: "/tmp/aeh-0100",
    payload: { request: "0100 fixture", taskId: current.taskId },
    revision: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants,
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    operationExecutionRevision: 1,
    resolvedOperationPolicy: policy(current),
    controller: { epoch: 1, ownerId: "controller-1", claimedAt: "2026-01-01T00:00:00.000Z" }
  } as OperationRecordV2;
}

function bundleFor(operation: OperationRecordV2, current = candidate(), sessionId = "reviewer-session-1"): EvidenceBundleV1 {
  return buildAcceptanceEvidenceBundleV1({ operation, compilation: reviewCompilation(current), report: reportFor(current, sessionId), implementationIdentity: "implementer" });
}

function reviewerParticipant(binding: ExecutionBindingV3, artifact?: string): OperationParticipantRecord {
  return { id: authorityId, logicalAgent: "reviewer", role: "Reviewer", status: "REGISTERED", phase: "review", registeredAt: "2026-01-01T00:00:00.000Z", executionBinding: binding, ...(artifact ? { resultArtifact: artifact } : {}) };
}

async function fixtureRoot(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${name}-`));
  roots.push(root);
  await initializeProject(root);
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), `version: 1\nproject:\n  name: ${name}\nvalidation:\n  baseRef: master\n`);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q", "-b", "master"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.email", "provenance@aeh.invalid"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile("git", ["config", "user.name", "Provenance Test"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  return root;
}

describe("AEH-V2-0100 reviewer acceptance provenance", () => {
  it("persists the receipt result artifact on the controller-issued participant identity without closing its resumable execution context", async () => {
    const root = await fixtureRoot("review-provenance");
    const operationId = "CHANGE-REVIEW-PROVENANCE";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "review", root, payload: { request: "reviewer provenance", taskId: "TASK-0100" }, createdAt: now, updatedAt: now } as never);
    await claimControllerEpoch(root, operationId, `controller:test:${operationId}`);
    const loaded = await loadOperation(root, operationId);
    const current = loaded.candidateRevision!;
    await registerOperationAgent(root, operationId, { id: authorityId, logicalAgent: "reviewer", role: "Reviewer", phase: "review" });
    const frozen = policy(current);
    await bindResolvedOperationPolicy(root, operationId, frozen);
    const binding = bindingFor(current, "reviewer-session-1", { operationPolicyDigest: frozen.digest, controllerEpoch: currentControllerEpoch(await loadOperation(root, operationId)) });
    await bindOperationParticipantExecution(root, operationId, { participantId: authorityId, logicalAgent: "reviewer", role: "Reviewer", binding });
    const artifact = `.harness/operations/${operationId}/results/reviewer/0001.json`;
    await fs.mkdir(path.dirname(path.join(root, artifact)), { recursive: true });
    await fs.writeFile(path.join(root, artifact), `${JSON.stringify({ verdict: "PASS", findings: [] })}\n`);
    await recordParticipantReceipt(root, operationId, {
      version: 1,
      receiptId: `receipt:${authorityId}:${now}`,
      operationId,
      participantId: authorityId,
      sessionId: "reviewer-session-1",
      attempt: 1,
      role: "Reviewer",
      phase: "review",
      startedAt: now,
      finishedAt: now,
      outcome: "SUCCEEDED",
      candidate: current,
      runtimeTerminal: { kind: "runtime-terminal", eventId: "runtime:reviewer-session-1", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
      contract: { contractId: "reviewer", contractDigest: digest("reviewer-contract"), valid: true },
      artifact: { artifactId: artifact, artifactDigest: digest("artifact"), persisted: true, persistedAt: now },
      provenance: { provenanceId: "provenance:reviewer", provenanceDigest: digest("provenance"), source: "test", valid: true },
      settled: true,
      createdAt: now
    });
    const after = await loadOperation(root, operationId);
    const authority = after.participants[authorityId]!;
    expect(authority.resultArtifact).toBe(artifact);
    expect(authority.executionBinding?.runtime.sessionId).toBe("reviewer-session-1");
    expect(["COMPLETED", "FAILED", "CANCELLED"]).not.toContain(authority.status);
    expect(after.participantReceipts?.[`receipt:${authorityId}:${now}`]?.participantId).toBe(authorityId);

    const oracle = evaluateAcceptanceOracleV1(bundleFor(after, current), reviewCompilation(current).evidenceStrength);
    expect(oracle.disposition).toBe("ACCEPTED");
    expect(oracle.coveredAssertionIds).toEqual(["AC-1"]);
  });

  it("rejects binding from one participant record with the artifact on another record", () => {
    const current = candidate();
    const binding = bindingFor(current, "reviewer-session-1");
    const operation = operationWith({
      [authorityId]: reviewerParticipant(binding),
      "reviewer-session-1": { id: "reviewer-session-1", status: "COMPLETED", registeredAt: "2026-01-01T00:00:00.000Z", resultArtifact: ".harness/operations/x/results/reviewer/0001.json" }
    }, current);
    const oracle = evaluateAcceptanceOracleV1(bundleFor(operation, current), reviewCompilation(current).evidenceStrength);
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT");
  });

  it("rejects session-id-only coincidence without a controller-issued execution binding", () => {
    const current = candidate();
    const operation = operationWith({
      "reviewer-session-1": { id: "reviewer-session-1", logicalAgent: "reviewer", role: "Reviewer", status: "COMPLETED", registeredAt: "2026-01-01T00:00:00.000Z", resultArtifact: ".harness/operations/x/results/reviewer/0001.json" }
    }, current);
    const oracle = evaluateAcceptanceOracleV1(bundleFor(operation, current), reviewCompilation(current).evidenceStrength);
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT");
  });

  it("rejects a stale candidate binding even when the binding and artifact share one record", () => {
    const current = candidate();
    const stale = bindingFor(current, "reviewer-session-1", { candidateDigest: digest("stale-candidate"), operationPolicyDigest: policy(current).digest });
    const operation = operationWith({ [authorityId]: reviewerParticipant(stale, ".harness/operations/x/results/reviewer/0001.json") }, current);
    const oracle = evaluateAcceptanceOracleV1(bundleFor(operation, current), reviewCompilation(current).evidenceStrength);
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT");
  });

  it("admits exactly one current-candidate review item when the report carries several rounds", () => {
    const current = candidate();
    const binding = bindingFor(current, "reviewer-session-1");
    const operation = operationWith({ [authorityId]: reviewerParticipant(binding, ".harness/operations/x/results/reviewer/0001.json") }, current);
    const supersededCandidate = candidate();
    supersededCandidate.identityDigest = digest("superseded-candidate");
    const supersededRound = reviewCheck(0, current, "reviewer-session-1");
    (supersededRound.details as Record<string, unknown>).candidate = { candidateId: supersededCandidate.candidateId, revision: supersededCandidate.revision, identityDigest: supersededCandidate.identityDigest };
    const command: ValidationCheck = { id: "command.fixture-greeting", category: "command", status: "PASS", message: "greeting command" };
    const report = reportFor(current, "reviewer-session-1", [command, supersededRound, reviewCheck(1, current, "reviewer-session-1")]);
    const bundle = buildAcceptanceEvidenceBundleV1({ operation, compilation: reviewCompilation(current), report, implementationIdentity: "implementer" });
    const reviewItems = bundle.evidence.filter((item) => item.assertionId === "AC-1" && item.kind === "REVIEW");
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]?.status).toBe("PASS");
    const oracle = evaluateAcceptanceOracleV1(bundle, reviewCompilation(current).evidenceStrength);
    expect(oracle.blockers.map((item) => item.code)).not.toContain("EVIDENCE_ITEM_INVALID");
    expect(oracle.disposition).toBe("ACCEPTED");
  });

  it("fails closed with a single failed item when only a superseded-candidate review round exists", () => {
    const current = candidate();
    const binding = bindingFor(current, "reviewer-session-1");
    const operation = operationWith({ [authorityId]: reviewerParticipant(binding, ".harness/operations/x/results/reviewer/0001.json") }, current);
    const supersededRound = reviewCheck(0, current, "reviewer-session-1");
    (supersededRound.details as Record<string, unknown>).candidate = { candidateId: current.candidateId, revision: current.revision, identityDigest: digest("superseded-candidate") };
    const command: ValidationCheck = { id: "command.fixture-greeting", category: "command", status: "PASS", message: "greeting command" };
    const report = reportFor(current, "reviewer-session-1", [command, supersededRound]);
    const bundle = buildAcceptanceEvidenceBundleV1({ operation, compilation: reviewCompilation(current), report, implementationIdentity: "implementer" });
    const reviewItems = bundle.evidence.filter((item) => item.assertionId === "AC-1" && item.kind === "REVIEW");
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]?.status).toBe("FAIL");
    const oracle = evaluateAcceptanceOracleV1(bundle, reviewCompilation(current).evidenceStrength);
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT");
  });

  it("preserves the canonical identity across a legitimately rebound reviewer turn and rejects the superseded session evidence", () => {
    const current = candidate();
    const firstBinding = bindingFor(current, "reviewer-session-1");
    const secondBinding = bindingFor(current, "reviewer-session-2", { participantGeneration: "generation:2" });
    const operation = operationWith({ [authorityId]: reviewerParticipant(secondBinding, ".harness/operations/x/results/reviewer/0002.json") }, current);
    expect(operation.participants[authorityId]).toMatchObject({ logicalAgent: "reviewer", role: "Reviewer", resultArtifact: ".harness/operations/x/results/reviewer/0002.json" });
    const freshOracle = evaluateAcceptanceOracleV1(bundleFor(operation, current, "reviewer-session-2"), reviewCompilation(current).evidenceStrength);
    expect(freshOracle.disposition).toBe("ACCEPTED");

    const supersededReport = reportFor(current, "reviewer-session-1");
    void firstBinding;
    const supersededBundle = buildAcceptanceEvidenceBundleV1({ operation, compilation: reviewCompilation(current), report: supersededReport, implementationIdentity: "implementer" });
    const supersededOracle = evaluateAcceptanceOracleV1(supersededBundle, reviewCompilation(current).evidenceStrength);
    expect(supersededOracle.disposition).toBe("REJECTED");
    expect(supersededOracle.blockers.map((item) => item.code)).toContain("VERIFICATION_REVIEW_STRENGTH_INSUFFICIENT");
  });
});
