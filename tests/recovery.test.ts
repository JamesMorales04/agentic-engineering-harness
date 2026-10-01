import { describe, expect, it } from "vitest";
import { classifyFailure, classifyFailureDecision, classifyFailureWithSemanticAssessment, resolveRecoveryStep } from "../src/agents/recovery.js";
import { resolveAgentTopology } from "../src/agents/config.js";
import type { AgentTopologySource } from "../src/agents/types.js";
import type { WorkerSession } from "../src/core/types.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";

describe("recovery", () => {
  it("classifies deterministic validator failures", () => { expect(classifyFailure({ report: { version: 1, taskId: "T", status: "FAIL", startedAt: "", finishedAt: "", changedFiles: [], metadata: { project: "p", baseRef: "main" }, checks: [{ id: "test", category: "test", status: "FAIL", message: "failed" }] } })).toBe("VALIDATION_FAILURE"); });
  it("uses the bounded semantic service to distinguish worker failure classes", async () => {
    const service = semanticTestService({ payload: (request) => semanticPayload(request, { judgment: { type: "FAILURE", classification: "PATCH_CONTEXT_MISMATCH", evidenceRefs: ["worker:stderr"] } }) });
    const result = await classifyFailureWithSemanticAssessment({ worker: { stderr: "patch apply failed: hunk context mismatch", stdout: "", exitCode: 1 } as WorkerSession }, {
      service, binding: { projectId: "recovery-test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(result).toMatchObject({ classification: "PATCH_CONTEXT_MISMATCH", mechanism: "HYBRID", evidenceRefs: ["worker:stderr"], assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(classifyFailure({ worker: { stderr: "patch apply failed: hunk context mismatch", stdout: "", exitCode: 1 } as WorkerSession })).toBe("TOOL_FAILURE");
  });

  it("keeps observed deterministic failure state authoritative over semantic output", async () => {
    let calls = 0;
    const service = semanticTestService({ runner: { assess: async () => { calls += 1; throw new Error("must not execute"); } } });
    const result = await classifyFailureWithSemanticAssessment({ conflicting: true, worker: { stderr: "timeout", stdout: "", exitCode: 1 } as WorkerSession }, {
      service, binding: { projectId: "recovery-test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(result).toMatchObject({ classification: "CONFLICTING_RESULTS", mechanism: "DETERMINISTIC", evidenceRefs: ["state:conflicting"] });
    expect(calls).toBe(0);
    expect(classifyFailureDecision({ conflicting: true }).mechanism).toBe("DETERMINISTIC");
  });

  it("rejects semantic failure judgments that cite unobserved evidence", async () => {
    const service = semanticTestService({ payload: () => ({ judgment: { type: "FAILURE", classification: "TOOL_FAILURE", evidenceRefs: ["worker:stdout"] }, claims: [], assumptions: [], unknowns: [], recommendations: [], knowledgeGaps: [] }) });
    await expect(classifyFailureWithSemanticAssessment({ worker: { stderr: "provider timeout", stdout: "", exitCode: 1 } as WorkerSession }, {
      service, binding: { projectId: "recovery-test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });
  it("uses versioned recovery policy by attempt", () => { const source: AgentTopologySource = { version: 1, runtimes: { x: { adapter: "x" } }, models: { m: { runtime: "x", model: "m" } }, agents: { worker: { role: "implementer", execution: { model: "@m" } } }, recovery: { VALIDATION_FAILURE: [{ action: "same-agent" }, { action: "lead" }] } }; const topology = resolveAgentTopology(source); expect(resolveRecoveryStep(topology.recovery, "VALIDATION_FAILURE", 1).action).toBe("same-agent"); expect(resolveRecoveryStep(topology.recovery, "VALIDATION_FAILURE", 2).action).toBe("lead"); });
});
