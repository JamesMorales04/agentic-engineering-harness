import { describe, expect, it } from "vitest";
import type { SupervisorOutput } from "../src/agents/outputContracts.js";
import type { WorkerSession } from "../src/core/types.js";
import { handoffPrompt, operationSupervisorTurnTimeoutSeconds, supervisorConsolidationContractCorrectionPromptV1, supervisorConsolidationCorrectionPromptV1, supervisorGenerationCandidateCurrentV1, supervisorTurnTimedOutV1, withBoundedSupervisorConsolidationCorrectionV1 } from "../src/operations/supervisor.js";

function output(sourceFindingIds: string[]): SupervisorOutput {
  return { summary: "consolidated", consolidatedFindings: [], sourceFindingIds, conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" };
}

function session(): WorkerSession {
  return { provider: "test", logicalAgent: "operation-supervisor", exitCode: 0, stdout: "", stderr: "" };
}

const findings = [{ id: "reviewer:REVIEW-2" }] as never;

describe("AEH-V2-0120 supervisor candidate rotation", () => {
  const operation = { candidateRevision: { identityDigest: "candidate-r3" } } as never;
  it("keeps the rotation handoff turn a bounded readiness barrier that does not invite file reads", () => {
    const prompt = handoffPrompt({ id: "CHANGE-1", status: "RUNNING", candidateRevision: { revision: 3, identityDigest: "candidate-r3" }, operationExecutionRevision: 4, supervision: { required: true, materialized: true, generations: [] }, progress: {}, participants: {}, stages: {} } as never, 2, ".harness/operations/CHANGE-1/supervisors/generation-1.json");
    expect(prompt).toContain("[AEH_SUPERVISOR_HANDOFF]");
    expect(prompt).toContain("session-readiness turn barrier");
    expect(prompt).toContain("do not read files, run commands, or perform semantic work on this turn");
    expect(prompt).toContain("continuity authority for later turns");
    expect(prompt).toContain("Acknowledge the handoff compactly and become idle.");
  });
  it("keeps a generation only while its bound candidate is current", () => {
    expect(supervisorGenerationCandidateCurrentV1({ status: "BOUND", candidate: { identityDigest: "candidate-r3" } }, operation)).toBe(true);
    expect(supervisorGenerationCandidateCurrentV1({ status: "BOUND", candidate: { identityDigest: "candidate-r2" } }, operation)).toBe(false);
  });
  it("treats missing provenance as not-yet-rotatable and missing candidates as stale", () => {
    expect(supervisorGenerationCandidateCurrentV1(undefined, operation)).toBe(true);
    expect(supervisorGenerationCandidateCurrentV1({ status: "UNSUPPORTED" }, operation)).toBe(true);
    expect(supervisorGenerationCandidateCurrentV1({ status: "BOUND", candidate: { identityDigest: "candidate-r2" } }, { candidateRevision: undefined } as never)).toBe(false);
  });
});

describe("AEH-V2-0102/0105 supervisor consolidation correction", () => {
  it("bounds persistent supervisor continuation turns and identifies timeout outcomes explicitly", () => {
    const config = { orchestration: { operations: { supervision: { turnTimeoutSeconds: 900 } } } } as never;
    expect(operationSupervisorTurnTimeoutSeconds(config)).toBe(300);
    expect(operationSupervisorTurnTimeoutSeconds(config) * 1000).toBe(300_000);
    expect(supervisorTurnTimedOutV1({ exitCode: 124, stdout: "", stderr: "" })).toBe(true);
    expect(supervisorTurnTimedOutV1({ exitCode: 1, stdout: "", stderr: "provider timed out" })).toBe(true);
    expect(supervisorTurnTimedOutV1({ exitCode: 1, stdout: "", stderr: "invalid response" })).toBe(false);
  });
  it("accepts the exact source set on the first turn without a correction", async () => {
    const prompts: string[] = [];
    const result = await withBoundedSupervisorConsolidationCorrectionV1({
      expectedFindingIds: ["reviewer:REVIEW-2"],
      initialPrompt: "initial",
      provenanceCorrectionPrompt: () => "provenance-correction",
      contractCorrectionPrompt: () => "contract-correction",
      requestTurn: async (prompt) => { prompts.push(prompt); return { session: session(), output: output(["reviewer:REVIEW-2"]) }; }
    });
    expect(prompts).toEqual(["initial"]);
    expect(result.output.sourceFindingIds).toEqual(["reviewer:REVIEW-2"]);
  });

  it("issues exactly one bounded correction when a superseded finding id is echoed", async () => {
    const prompts: string[] = [];
    const result = await withBoundedSupervisorConsolidationCorrectionV1({
      expectedFindingIds: ["reviewer:REVIEW-2"],
      initialPrompt: "initial",
      provenanceCorrectionPrompt: () => "provenance-correction",
      contractCorrectionPrompt: () => "contract-correction",
      requestTurn: async (prompt) => {
        prompts.push(prompt);
        return prompt === "initial"
          ? { session: session(), output: output(["reviewer:REVIEW-2", "reviewer:REVIEW-1"]) }
          : { session: session(), output: output(["reviewer:REVIEW-2"]) };
      }
    });
    expect(prompts).toEqual(["initial", "provenance-correction"]);
    expect(result.output.sourceFindingIds).toEqual(["reviewer:REVIEW-2"]);
    expect(result.prompt).toBe("provenance-correction");
  });

  it("fails closed after one provenance correction and never sends a third turn", async () => {
    let calls = 0;
    await expect(withBoundedSupervisorConsolidationCorrectionV1({
      expectedFindingIds: ["reviewer:REVIEW-2"],
      initialPrompt: "initial",
      provenanceCorrectionPrompt: () => "provenance-correction",
      contractCorrectionPrompt: () => "contract-correction",
      requestTurn: async () => { calls += 1; return { session: session(), output: output(["reviewer:REVIEW-1"]) }; }
    })).rejects.toThrow("AEH_OPERATION_SUPERVISOR_PROVENANCE");
    expect(calls).toBe(2);
  });

  it("issues one bounded contract correction for a schema-invalid supervisor response", async () => {
    const prompts: string[] = [];
    const result = await withBoundedSupervisorConsolidationCorrectionV1({
      expectedFindingIds: ["reviewer:REVIEW-2"],
      initialPrompt: "initial",
      provenanceCorrectionPrompt: () => "provenance-correction",
      contractCorrectionPrompt: (failure) => `contract-correction:${failure}`,
      requestTurn: async (prompt) => {
        prompts.push(prompt);
        return prompt === "initial"
          ? { session: session(), failure: "SCHEMA_VALIDATION_FAILED: summary missing" }
          : { session: session(), output: output(["reviewer:REVIEW-2"]) };
      }
    });
    expect(prompts[0]).toBe("initial");
    expect(prompts[1]).toContain("contract-correction:SCHEMA_VALIDATION_FAILED");
    expect(result.output.sourceFindingIds).toEqual(["reviewer:REVIEW-2"]);
  });

  it("fails closed with AEH_OPERATION_SUPERVISOR_CONTRACT when the bounded correction is still invalid", async () => {
    let calls = 0;
    await expect(withBoundedSupervisorConsolidationCorrectionV1({
      expectedFindingIds: ["reviewer:REVIEW-2"],
      initialPrompt: "initial",
      provenanceCorrectionPrompt: () => "provenance-correction",
      contractCorrectionPrompt: () => "contract-correction",
      requestTurn: async () => { calls += 1; return { session: session(), failure: "SCHEMA_VALIDATION_FAILED: still invalid" }; }
    })).rejects.toThrow("AEH_OPERATION_SUPERVISOR_CONTRACT");
    expect(calls).toBe(2);
  });

  it("names the exact required ids and the superseded ids in the provenance correction prompt", () => {
    const prompt = supervisorConsolidationCorrectionPromptV1({ key: "review-round-2", purpose: "quality review round 2", findings }, ["reviewer:REVIEW-2"], ["reviewer:REVIEW-2", "reviewer:REVIEW-1"]);
    expect(prompt).toContain('"reviewer:REVIEW-2"');
    expect(prompt).toContain("Superseded finding ids");
    expect(prompt).toContain('"reviewer:REVIEW-1"');
    expect(prompt).toContain("add no ids and omit none");
  });

  it("names the contract failure and the required id set in the contract correction prompt", () => {
    const prompt = supervisorConsolidationContractCorrectionPromptV1({ key: "review-round-2", purpose: "quality review round 2", findings }, ["reviewer:REVIEW-2"], "SCHEMA_VALIDATION_FAILED: summary missing");
    expect(prompt).toContain("SCHEMA_VALIDATION_FAILED: summary missing");
    expect(prompt).toContain('"reviewer:REVIEW-2"');
    expect(prompt).toContain("missingEvidence (array of strings)");
  });
});
