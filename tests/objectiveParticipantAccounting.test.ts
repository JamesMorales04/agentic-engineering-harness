import { describe, expect, it } from "vitest";
import { evaluateObjectiveCompletionV1, type ObjectiveCompletionIdentityV1 } from "../src/architecture/objectiveCompletion.js";
import { objectiveParticipantAccountingV1 } from "../src/core/run.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { OperationParticipantRecord, OperationRecordV2 } from "../src/operations/state.js";
import { createCandidateAssemblyReceiptV1, createCandidateRevisionV1, evaluateTerminalGate, resolveCandidateLineageReceiptV1, type CandidateAssemblyReceiptV1, type CandidateRevisionV1, type ParticipantReceiptV1 } from "../src/operations/v2Contracts.js";

const digest = (value: unknown) => sha256Canonical(value);

function candidate(revision = 1, source = "source-0101"): CandidateRevisionV1 {
  return createCandidateRevisionV1({ operationId: "OP-0101", candidateId: `candidate:OP-0101:r${revision}`, projectId: "project-0101", taskId: "TASK-0101", revision, sourceDigest: digest(source) });
}

function receipt(participantId: string, sessionId: string, current: CandidateRevisionV1, outcome: "SUCCEEDED" | "FAILED", settled = true) {
  return { receiptId: `receipt:${participantId}`, operationId: current.operationId, participantId, sessionId, outcome, settled, candidate: current } as never;
}

function operation(current: CandidateRevisionV1, participants: Record<string, OperationParticipantRecord>, receipts: Record<string, unknown>, assemblies: Record<string, CandidateAssemblyReceiptV1> = {}): OperationRecordV2 {
  return {
    version: 2,
    id: current.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "review",
    root: "/tmp/aeh-0101",
    payload: { request: "0101 fixture", taskId: current.taskId },
    revision: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants,
    participantReceipts: receipts as never,
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    candidateAssemblyReceipts: assemblies,
    operationExecutionRevision: 1
  } as OperationRecordV2;
}

function assemblyReceipt(base: CandidateRevisionV1, assembled: CandidateRevisionV1, source: ParticipantReceiptV1, overrides: Partial<CandidateAssemblyReceiptV1> = {}): CandidateAssemblyReceiptV1 {
  return createCandidateAssemblyReceiptV1({
    operationId: assembled.operationId,
    taskId: "TASK-0101",
    workUnitId: "direct:TASK-0101",
    participantId: source.participantId,
    baseCandidateId: base.candidateId,
    baseRevision: base.revision,
    baseIdentityDigest: base.identityDigest,
    sourceBaseRevision: base.revision,
    sourceBaseIdentityDigest: base.identityDigest,
    sourceReceiptId: source.receiptId,
    sourceReceiptDigest: sha256Canonical(source),
    sourceChangeSetDigest: digest("changeset-0106"),
    candidateId: assembled.candidateId,
    revision: assembled.revision,
    identityDigest: assembled.identityDigest,
    changeSetDigest: digest("changeset-0106"),
    patchDigest: digest("patch-0106"),
    operationExecutionRevision: 1,
    controllerEpoch: 1,
    createdAt: assembled.createdAt ?? "2026-01-01T00:00:01.000Z",
    ...overrides
  });
}

function assembledCandidate(base: CandidateRevisionV1, source = "assembled-source"): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId: base.operationId,
    candidateId: `candidate:${base.operationId}:r${base.revision + 1}`,
    projectId: base.projectId!,
    taskId: base.taskId,
    revision: base.revision + 1,
    parentCandidateId: base.candidateId,
    sourceDigest: digest(source),
    createdAt: "2026-01-01T00:00:01.000Z"
  });
}

function identity(current: CandidateRevisionV1): ObjectiveCompletionIdentityV1 {
  return { operationId: current.operationId, candidate: current, policyDigest: digest("policy-0101"), operationExecutionRevision: 1, controllerEpoch: 1 };
}

function objectiveInput(current: CandidateRevisionV1, participants: Array<{ id: string; required: boolean; status: string }>) {
  const currentIdentity = identity(current);
  return {
    version: 1 as const,
    identity: currentIdentity,
    workspaceCandidate: current,
    workGraph: { requiredWorkUnitIds: ["direct:TASK-0101"], accountedWorkUnitIds: ["direct:TASK-0101"] },
    validation: { requiredAssertionIds: [], evidence: [] },
    review: { requiredAssertionIds: [], evidence: [] },
    acceptance: { disposition: "ACCEPTED" as const, requiredAssertionIds: [], coveredAssertionIds: [], identity: currentIdentity },
    certification: { required: false },
    delivery: { required: false, disposition: "NOT_REQUIRED" as const },
    findings: [],
    participants: participants as never,
    terminalIdentity: currentIdentity
  };
}

describe("AEH-V2-0101 objective participant accounting", () => {
  it("counts a controller-issued identity complete from its candidate-bound settled receipt", () => {
    const current = candidate();
    const participants = {
      "participant:aaaaaaaaaaaaaaaa": { id: "participant:aaaaaaaaaaaaaaaa", role: "Implementer", logicalAgent: "implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" },
      "session-aaaa": { id: "session-aaaa", role: "Implementer", logicalAgent: "implementer", status: "COMPLETED", registeredAt: "2026-01-01T00:00:00.000Z" }
    };
    const operationRecord = operation(current, participants as never, { "receipt:participant:aaaaaaaaaaaaaaaa": receipt("participant:aaaaaaaaaaaaaaaa", "session-aaaa", current, "SUCCEEDED") });
    const accounting = objectiveParticipantAccountingV1(operationRecord, current);
    expect(accounting).toEqual([
      { id: "participant:aaaaaaaaaaaaaaaa", required: true, status: "COMPLETED" },
      { id: "session-aaaa", required: true, status: "COMPLETED" }
    ]);
    const decision = evaluateObjectiveCompletionV1(objectiveInput(current, accounting));
    expect(decision.blockers.map((item) => item.code)).not.toContain("PARTICIPANT_INCOMPLETE");
    expect(decision.complete).toBe(true);
  });

  it("resolves a receipt bound by session provenance to the matching session participant", () => {
    const current = candidate();
    const participants = { "session-bbbb": { id: "session-bbbb", role: "Reviewer", logicalAgent: "reviewer", status: "RUNNING", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const operationRecord = operation(current, participants as never, { "receipt:participant:bbbbbbbbbbbbbbbb": receipt("participant:bbbbbbbbbbbbbbbb", "session-bbbb", current, "SUCCEEDED") });
    expect(objectiveParticipantAccountingV1(operationRecord, current)).toEqual([{ id: "session-bbbb", required: true, status: "COMPLETED" }]);
  });

  it("keeps in-flight participants fail-closed without a settled current receipt", () => {
    const current = candidate();
    const participants = { "participant:cccccccccccccccc": { id: "participant:cccccccccccccccc", role: "Reviewer", logicalAgent: "reviewer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const operationRecord = operation(current, participants as never, {});
    const accounting = objectiveParticipantAccountingV1(operationRecord, current);
    expect(accounting).toEqual([{ id: "participant:cccccccccccccccc", required: true, status: "REGISTERED" }]);
    const decision = evaluateObjectiveCompletionV1(objectiveInput(current, accounting));
    expect(decision.complete).toBe(false);
    expect(decision.blockers.map((item) => item.code)).toContain("PARTICIPANT_INCOMPLETE");
  });

  it("does not let a stale candidate receipt close a participant", () => {
    const current = candidate();
    const stale = candidate(2, "stale-source");
    const participants = { "participant:dddddddddddddddd": { id: "participant:dddddddddddddddd", role: "Implementer", logicalAgent: "implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const operationRecord = operation(current, participants as never, { "receipt:stale": receipt("participant:dddddddddddddddd", "session-stale", stale, "SUCCEEDED") });
    expect(objectiveParticipantAccountingV1(operationRecord, current)).toEqual([{ id: "participant:dddddddddddddddd", required: true, status: "REGISTERED" }]);
    const decision = evaluateObjectiveCompletionV1(objectiveInput(current, objectiveParticipantAccountingV1(operationRecord, current)));
    expect(decision.blockers.map((item) => item.code)).toContain("PARTICIPANT_INCOMPLETE");
  });

  it("documents the AEH-V2-0106 assembly-lineage gap: a receipt bound to the pre-assembly candidate closes neither the participant nor the terminal gate", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = createCandidateRevisionV1({ operationId: base.operationId, candidateId: "candidate:OP-0101:r3", projectId: base.projectId!, taskId: base.taskId, revision: 3, parentCandidateId: base.candidateId, sourceDigest: digest("assembled-source") });
    const participants = { "participant:9999999999999999": { id: "participant:9999999999999999", role: "Implementer", logicalAgent: "implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const implementerReceipt = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED");
    const operationRecord = operation(assembled, participants as never, { "receipt:implementer": implementerReceipt });
    expect(objectiveParticipantAccountingV1(operationRecord, assembled)).toEqual([{ id: "participant:9999999999999999", required: true, status: "REGISTERED" }]);
    const terminal = evaluateTerminalGate(implementerReceipt, { operationId: assembled.operationId, candidate: assembled });
    expect(terminal.allowed).toBe(false);
    expect(terminal.reasons.map((item) => item.code)).toContain("CANDIDATE_MISMATCH");
  });

  it("counts a pre-assembly receipt complete through a verified assembly receipt chain (AEH-V2-0106)", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = assembledCandidate(base);
    const implementer = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED");
    const assembly = assemblyReceipt(base, assembled, implementer as ParticipantReceiptV1);
    const participants = { "participant:9999999999999999": { id: "participant:9999999999999999", role: "Implementer", logicalAgent: "implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const operationRecord = operation(assembled, participants as never, { "receipt:implementer": implementer }, { [assembly.assemblyId]: assembly });
    expect(objectiveParticipantAccountingV1(operationRecord, assembled)).toEqual([{ id: "participant:9999999999999999", required: true, status: "COMPLETED" }]);
    expect(evaluateObjectiveCompletionV1(objectiveInput(assembled, objectiveParticipantAccountingV1(operationRecord, assembled))).complete).toBe(true);
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: assembled, assemblies: [assembly] })).toEqual({ kind: "ASSEMBLY", assembly });
    expect(evaluateTerminalGate(implementer, { operationId: assembled.operationId, candidate: base }).reasons.map((item) => item.code)).not.toContain("CANDIDATE_MISMATCH");
    expect(evaluateTerminalGate(implementer, { operationId: assembled.operationId, candidate: assembled }).reasons.map((item) => item.code)).toContain("CANDIDATE_MISMATCH");
  });

  it("counts non-producing ancestor-bound work complete without an assembly source naming (AEH-V2-0124)", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = assembledCandidate(base);
    const implementer = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED") as ParticipantReceiptV1 & { role?: string };
    implementer.role = "Implementer";
    const explorer = receipt("participant:7777777777777777", "session-explore", base, "SUCCEEDED") as ParticipantReceiptV1 & { role?: string };
    explorer.role = "Explorer";
    const assembly = assemblyReceipt(base, assembled, implementer);
    expect(resolveCandidateLineageReceiptV1({ receipt: explorer, current: assembled, assemblies: [assembly] })).toEqual({ kind: "ANCESTOR" });
    // A producer receipt that no assembly names is never completion evidence, even on the ancestry.
    const explorerSourcedAssembly = assemblyReceipt(base, assembled, explorer);
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer, current: assembled, assemblies: [explorerSourcedAssembly] })).toBeUndefined();
    const participants = {
      "participant:7777777777777777": { id: "participant:7777777777777777", role: "Explorer", status: "FAILED", registeredAt: "2026-01-01T00:00:00.000Z" },
      "participant:9999999999999999": { id: "participant:9999999999999999", role: "Implementer", status: "COMPLETED", registeredAt: "2026-01-01T00:00:00.000Z" }
    };
    const operationRecord = operation(assembled, participants as never, { "receipt:explorer": explorer, "receipt:implementer": implementer }, { [assembly.assemblyId]: assembly });
    // The resumable Explorer identity carries a transient live FAILED from a retried attempt; its
    // settled ancestor-bound receipt is the authoritative completion evidence.
    const accounting = objectiveParticipantAccountingV1(operationRecord, assembled);
    expect(accounting.find((item) => item.id === "participant:7777777777777777")?.status).toBe("COMPLETED");
    expect(accounting.find((item) => item.id === "participant:9999999999999999")?.status).toBe("COMPLETED");
    expect(evaluateObjectiveCompletionV1(objectiveInput(assembled, accounting)).blockers.map((item) => item.code)).not.toContain("PARTICIPANT_INCOMPLETE");
    // The terminal gate evaluates an ancestor-bound receipt against the candidate the work observed.
    expect(evaluateTerminalGate(explorer, { operationId: assembled.operationId, candidate: base }).reasons.map((item) => item.code)).not.toContain("CANDIDATE_MISMATCH");
  });

  it("accepts a multi-hop repair lineage receipt through consecutive assembly receipts", () => {
    const base = candidate(1, "hop-source-1");
    const second = assembledCandidate(base, "hop-source-2");
    const third = assembledCandidate(second, "hop-source-3");
    const implementer = receipt("participant:1111111111111111", "session-hop", base, "SUCCEEDED");
    const firstAssembly = assemblyReceipt(base, second, implementer as ParticipantReceiptV1);
    const repairer = receipt("participant:2222222222222222", "session-repair", second, "SUCCEEDED");
    const secondAssembly = assemblyReceipt(second, third, repairer as ParticipantReceiptV1, { workUnitId: "repair:TASK-0101:1", participantId: "participant:2222222222222222" });
    const participants = {
      "participant:1111111111111111": { id: "participant:1111111111111111", role: "Implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" },
      "participant:2222222222222222": { id: "participant:2222222222222222", role: "Repairer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" }
    };
    const operationRecord = operation(third, participants as never, { "receipt:implementer": implementer, "receipt:repairer": repairer } as never, { [firstAssembly.assemblyId]: firstAssembly, [secondAssembly.assemblyId]: secondAssembly });
    expect(objectiveParticipantAccountingV1(operationRecord, third)).toEqual([
      { id: "participant:1111111111111111", required: true, status: "COMPLETED" },
      { id: "participant:2222222222222222", required: true, status: "COMPLETED" }
    ]);
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: third, assemblies: [firstAssembly, secondAssembly] })?.kind).toBe("ASSEMBLY");
    expect(resolveCandidateLineageReceiptV1({ receipt: repairer as ParticipantReceiptV1, current: third, assemblies: [firstAssembly, secondAssembly] })?.kind).toBe("ASSEMBLY");
  });

  it("rejects an assembly receipt that does not name the settled source receipt", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = assembledCandidate(base);
    const implementer = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED");
    const impostor = receipt("participant:8888888888888888", "session-impl", base, "SUCCEEDED");
    const assembly = assemblyReceipt(base, assembled, impostor as ParticipantReceiptV1);
    const participants = { "participant:9999999999999999": { id: "participant:9999999999999999", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    const operationRecord = operation(assembled, participants as never, { "receipt:implementer": implementer }, { [assembly.assemblyId]: assembly });
    expect(objectiveParticipantAccountingV1(operationRecord, assembled)).toEqual([{ id: "participant:9999999999999999", required: true, status: "REGISTERED" }]);
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: assembled, assemblies: [assembly] })).toBeUndefined();
  });

  it("rejects a receipt whose candidate is not an assembly ancestor of the current candidate", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = assembledCandidate(base);
    const unrelated = createCandidateRevisionV1({ operationId: base.operationId, candidateId: `candidate:${base.operationId}:r${base.revision}:divergent`, projectId: base.projectId!, taskId: base.taskId, revision: base.revision, sourceDigest: digest("unrelated-source") });
    const implementer = receipt("participant:9999999999999999", "session-impl", unrelated, "SUCCEEDED");
    const assembly = assemblyReceipt(base, assembled, implementer as ParticipantReceiptV1, { sourceBaseRevision: unrelated.revision, sourceBaseIdentityDigest: unrelated.identityDigest });
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: assembled, assemblies: [assembly] })).toBeUndefined();
    const participants = { "participant:9999999999999999": { id: "participant:9999999999999999", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" } };
    expect(objectiveParticipantAccountingV1(operation(assembled, participants as never, { "receipt:implementer": implementer }, { [assembly.assemblyId]: assembly }), assembled)).toEqual([{ id: "participant:9999999999999999", required: true, status: "REGISTERED" }]);
  });

  it("fails closed on a broken assembly ancestry chain or a tampered assembly digest", () => {
    const base = candidate(2, "pre-assembly-source");
    const middle = assembledCandidate(base);
    const top = assembledCandidate(middle);
    const implementer = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED");
    const firstAssembly = assemblyReceipt(base, middle, implementer as ParticipantReceiptV1);
    const secondAssembly = assemblyReceipt(middle, top, implementer as ParticipantReceiptV1, { participantId: (implementer as ParticipantReceiptV1).participantId });
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: top, assemblies: [secondAssembly] })).toBeUndefined();
    const tampered = { ...firstAssembly, digest: digest("tampered-digest") } as CandidateAssemblyReceiptV1;
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: middle, assemblies: [tampered] })).toBeUndefined();
    expect(resolveCandidateLineageReceiptV1({ receipt: implementer as ParticipantReceiptV1, current: top, assemblies: [tampered, secondAssembly] })).toBeUndefined();
  });

  it("keeps the controller-issued launch identity resumable while its lineage receipt accounts completion", () => {
    const base = candidate(2, "pre-assembly-source");
    const assembled = assembledCandidate(base);
    const implementer = receipt("participant:9999999999999999", "session-impl", base, "SUCCEEDED");
    const assembly = assemblyReceipt(base, assembled, implementer as ParticipantReceiptV1);
    const participants = { "participant:9999999999999999": { id: "participant:9999999999999999", role: "Implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z", resultArtifact: ".harness/operations/x/results/implementer/0001.json" } };
    const operationRecord = operation(assembled, participants as never, { "receipt:implementer": implementer }, { [assembly.assemblyId]: assembly });
    expect(objectiveParticipantAccountingV1(operationRecord, assembled)).toEqual([{ id: "participant:9999999999999999", required: true, status: "COMPLETED" }]);
    expect(operationRecord.participants["participant:9999999999999999"]?.status).toBe("REGISTERED");
    expect(operationRecord.participants["participant:9999999999999999"]?.resultArtifact).toBe(".harness/operations/x/results/implementer/0001.json");
  });

  it("does not let an unsettled receipt close a participant and preserves failed terminal outcomes", () => {
    const current = candidate();
    const participants = {
      "participant:eeeeeeeeeeeeeeee": { id: "participant:eeeeeeeeeeeeeeee", role: "Implementer", logicalAgent: "implementer", status: "REGISTERED", registeredAt: "2026-01-01T00:00:00.000Z" },
      "participant:ffffffffffffffff": { id: "participant:ffffffffffffffff", role: "Reviewer", logicalAgent: "reviewer", status: "RUNNING", registeredAt: "2026-01-01T00:00:00.000Z" }
    };
    const operationRecord = operation(current, participants as never, {
      "receipt:unsettled": receipt("participant:eeeeeeeeeeeeeeee", "session-e", current, "SUCCEEDED", false),
      "receipt:failed": receipt("participant:ffffffffffffffff", "session-f", current, "FAILED")
    });
    expect(objectiveParticipantAccountingV1(operationRecord, current)).toEqual([
      { id: "participant:eeeeeeeeeeeeeeee", required: true, status: "REGISTERED" },
      { id: "participant:ffffffffffffffff", required: true, status: "FAILED" }
    ]);
  });
});
