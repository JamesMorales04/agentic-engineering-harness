import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { bindOperationLead, bindResolvedOperationPolicy, loadOperation } from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { requestManagedLeadAcceptance } from "../src/agents/managedLeadAcceptance.js";
import type { CandidateAssuranceCompilationV1 } from "../src/architecture/candidateAssurance.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport } from "../src/core/types.js";
import { sha256Canonical } from "../src/core/digest.js";
import { continueManagedPaseoAgent } from "../src/paseo/runtime.js";

vi.mock("../src/paseo/runtime.js", () => ({
  continueManagedPaseoAgent: vi.fn(),
  inspectManagedPaseoAgent: vi.fn(async () => ({ id: "lead-session", status: "idle", workspaceId: "workspace-lead", labels: { "aeh.provider": "codex" }, raw: {} }))
}));

const roots: string[] = [];
const environmentKeys = ["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;
const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of environmentKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.mocked(continueManagedPaseoAgent).mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed Lead acceptance evidence", () => {
  it("uses the current bound Lead, returns candidate-bound opinion data, and keeps it non-authoritative", async () => {
    const setup = await fixture();
    vi.mocked(continueManagedPaseoAgent).mockResolvedValue({ exitCode: 0, stdout: `AEH_RESULT_JSON=${JSON.stringify({ assertions: [{ assertionId: "ASSERT-1", verdict: "PASS", rationale: "The candidate output matches the requested behavior." }], summary: "Assertion supported.", unresolved: [] })}`, stderr: "", transport: "sdk" });
    const evidence = await requestManagedLeadAcceptance({ root: setup.root, operationId: setup.operationId, compilation: setup.compilation, report: setup.report, implementationIdentity: "implementer" });
    expect(vi.mocked(continueManagedPaseoAgent)).toHaveBeenCalledWith(setup.root, "lead-session", expect.stringContaining("controllerEpoch"), 600, undefined, expect.objectContaining({ additionalProperties: false }), expect.objectContaining({ "aeh.lead.agentId": "lead-session", "aeh.provider": "codex" }));
    expect(evidence).toMatchObject({ status: "PASS", operationId: setup.operationId, candidate: setup.candidate, leadAgentId: "lead-session", leadGeneration: 1, assertions: [{ assertionId: "ASSERT-1", verdict: "PASS" }] });
    expect(evidence?.policyDigest).toBe((await loadOperation(setup.root, setup.operationId)).resolvedOperationPolicy?.digest);
  });

  it("rejects a Lead generation changed during assessment", async () => {
    const setup = await fixture();
    vi.mocked(continueManagedPaseoAgent).mockImplementation(async (root) => {
      await bindOperationLead(root, setup.operationId, "replacement-lead");
      return { exitCode: 0, stdout: `AEH_RESULT_JSON=${JSON.stringify({ assertions: [{ assertionId: "ASSERT-1", verdict: "PASS", rationale: "Supported." }], summary: "Supported.", unresolved: [] })}`, stderr: "", transport: "sdk" };
    });
    await expect(requestManagedLeadAcceptance({ root: setup.root, operationId: setup.operationId, compilation: setup.compilation, report: setup.report, implementationIdentity: "implementer" }))
      .rejects.toThrow("ACCEPTANCE_LEAD_BINDING_STALE");
  });

  it("does not accept an assessment that omits an assertion", async () => {
    const setup = await fixture();
    vi.mocked(continueManagedPaseoAgent).mockResolvedValue({ exitCode: 0, stdout: `AEH_RESULT_JSON=${JSON.stringify({ assertions: [], summary: "No assertion assessed.", unresolved: [] })}`, stderr: "", transport: "sdk" });
    const evidence = await requestManagedLeadAcceptance({ root: setup.root, operationId: setup.operationId, compilation: setup.compilation, report: setup.report, implementationIdentity: "implementer" });
    expect(evidence?.status).toBe("FAIL");
  });

  it("rejects reuse of the implementation actor as the managed Lead", async () => {
    const setup = await fixture();
    await expect(requestManagedLeadAcceptance({ root: setup.root, operationId: setup.operationId, compilation: setup.compilation, report: setup.report, implementationIdentity: "lead-session" }))
      .rejects.toThrow("ACCEPTANCE_LEAD_NOT_INDEPENDENT");
    expect(continueManagedPaseoAgent).not.toHaveBeenCalled();
  });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s6-managed-lead-")); roots.push(root);
  const operationId = "RUN-S6-LEAD";
  const taskId = "TASK-S6";
  const now = "2026-09-24T00:00:00.000Z";
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "accepting", root, payload: { taskId }, createdAt: now, updatedAt: now });
  await bindOperationLead(root, operationId, "lead-session");
  const operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  const config = { project: { name: candidate.projectId! } } as HarnessProjectConfig;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, intent: "test", route: "DELEGATED", minimumAssurance: "STANDARD",
    policyVersions: {}, policyDigests: {}, validationPolicy: {}, reviewPolicy: { leadAcceptance: true, leadAcceptanceDirect: false }, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  const bound = await loadOperation(root, operationId);
  const assertionBinding = { candidateId: candidate.candidateId, revision: candidate.revision, identityDigest: candidate.identityDigest };
  const assertion = { version: 1 as const, id: "ASSERT-1", statement: "The requested behavior is observable.", requirementRefs: ["REQ-1"], candidate: assertionBinding, impactDigest: sha256Canonical("impact"), policyDigest: policy.digest, dimensions: [], evidenceStrength: "STANDARD" as const };
  const compilationBody = {
    version: 1 as const, candidate: assertionBinding, impactDigest: assertion.impactDigest, policyDigest: policy.digest, minimumAssurance: "STANDARD" as const,
    reviewAssignments: [], validationRequirements: [], acceptanceAssertions: [assertion],
    evidenceStrength: { minimumAssurance: "STANDARD" as const, minimumIndependentReviewers: 0, providerDiversity: false, requiredDimensions: [] as string[] }, blockers: [], status: "READY" as const
  };
  const compilation: CandidateAssuranceCompilationV1 = { ...compilationBody, digest: sha256Canonical(compilationBody) };
  const report: ValidationReport = { version: 1, taskId, status: "PASS", startedAt: now, finishedAt: now, checks: [], changedFiles: [], candidate, metadata: { project: config.project.name, baseRef: "main" } };
  return { root, operationId, candidate: bound.candidateRevision!, compilation, report };
}
