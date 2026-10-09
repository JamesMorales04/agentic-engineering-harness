import { describe, expect, it } from "vitest";
import { isOwnerExemptionLineageDescendant } from "../src/security/ownerExemption.js";
import { createCandidateAssemblyReceiptV1 } from "../src/operations/v2Contracts.js";

const OP = "H-PROV-R2";
const anchorId = `candidate:${OP}:r1`;
const anchorRev = 1;
const anchorDigest = "a".repeat(64);
const honestLiveId = `candidate:${OP}:r2`;
const honestLiveRev = 2;
const honestLiveDigest = "b".repeat(64);
const forgedLiveDigest = "f".repeat(64);

function honestReceipt() {
  return createCandidateAssemblyReceiptV1({
    operationId: OP,
    taskId: "T",
    workUnitId: "W",
    participantId: "P",
    baseCandidateId: anchorId,
    baseRevision: anchorRev,
    baseIdentityDigest: anchorDigest,
    sourceBaseRevision: anchorRev,
    sourceBaseIdentityDigest: anchorDigest,
    sourceChangeSetDigest: "c".repeat(64),
    candidateId: honestLiveId,
    revision: honestLiveRev,
    identityDigest: honestLiveDigest,
    changeSetDigest: "d".repeat(64),
    patchDigest: "e".repeat(64),
    operationExecutionRevision: 2,
    controllerEpoch: 0,
    createdAt: new Date().toISOString(),
  });
}

function forgedReceiptForLive(liveDigest: string) {
  return createCandidateAssemblyReceiptV1({
    operationId: OP,
    taskId: "T",
    workUnitId: "W",
    participantId: "P",
    baseCandidateId: anchorId,
    baseRevision: anchorRev,
    baseIdentityDigest: anchorDigest,
    sourceBaseRevision: anchorRev,
    sourceBaseIdentityDigest: anchorDigest,
    sourceChangeSetDigest: "c".repeat(64),
    candidateId: honestLiveId,
    revision: honestLiveRev,
    identityDigest: liveDigest,
    changeSetDigest: "d".repeat(64),
    patchDigest: "e".repeat(64),
    operationExecutionRevision: 2,
    controllerEpoch: 0,
    createdAt: new Date().toISOString(),
  });
}

describe("H-NEW-12 R2 provenance binding", () => {
  it("honest durable chain grants (anchor child, op-bound, parent-linked)", () => {
    const durable = [honestReceipt()];
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest, parentCandidateId: anchorId },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: durable,
    })).toBe(true);
  });

  it("RED: forged self-consistent receipt alone (correct op, anchor base) refuses without durable confirmation", () => {
    // Attacker forges a live sibling (same r2 id, different digest) + a
    // self-consistent receipt naming it as child of the anchor. Honest durable
    // state contains only the honest r2 receipt, NOT the forged one.
    const honestDurable = [honestReceipt()];
    const forgedLive = { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: forgedLiveDigest, parentCandidateId: anchorId };
    const forgedHint = forgedReceiptForLive(forgedLiveDigest);
    // Walk of the forged live against HONEST durable alone: no durable hop
    // matches the forged digest → refuse.
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: forgedLive,
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: honestDurable,
    })).toBe(false);
    // Same, with the forged receipt supplied as an untrusted hint: the hint
    // is absent from durable (forged live digest never recorded) and the
    // durable walk still refuses.
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: forgedLive,
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: honestDurable,
      hintAssemblies: [forgedHint],
    })).toBe(false);
  });

  it("hint shadowing a durable hop with a mismatched digest refuses", () => {
    const durable = [honestReceipt()];
    // Self-consistent hint with the SAME assemblyId (same candidate) but a
    // DIFFERENT base digest → different digest → must refuse on mismatch.
    const hintMismatch = createCandidateAssemblyReceiptV1({
      operationId: OP,
      taskId: "T",
      workUnitId: "W",
      participantId: "P",
      baseCandidateId: anchorId,
      baseRevision: anchorRev,
      baseIdentityDigest: "9".repeat(64),
      sourceBaseRevision: anchorRev,
      sourceBaseIdentityDigest: "9".repeat(64),
      sourceChangeSetDigest: "c".repeat(64),
      candidateId: honestLiveId,
      revision: honestLiveRev,
      identityDigest: honestLiveDigest,
      changeSetDigest: "d".repeat(64),
      patchDigest: "e".repeat(64),
      operationExecutionRevision: 2,
      controllerEpoch: 0,
      createdAt: new Date().toISOString(),
    });
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest, parentCandidateId: anchorId },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: durable,
      hintAssemblies: [hintMismatch as never],
    })).toBe(false);
  });

  it("cross-operation hops never grant (wrong operationId bound)", () => {
    const otherOp = "H-OTHER-OP";
    const crossReceipt = createCandidateAssemblyReceiptV1({
      operationId: otherOp,
      taskId: "T",
      workUnitId: "W",
      participantId: "P",
      baseCandidateId: `candidate:${otherOp}:r1`,
      baseRevision: 1,
      baseIdentityDigest: anchorDigest,
      sourceBaseRevision: 1,
      sourceBaseIdentityDigest: anchorDigest,
      sourceChangeSetDigest: "c".repeat(64),
      candidateId: `candidate:${otherOp}:r2`,
      revision: 2,
      identityDigest: honestLiveDigest,
      changeSetDigest: "d".repeat(64),
      patchDigest: "e".repeat(64),
      operationExecutionRevision: 2,
      controllerEpoch: 0,
      createdAt: new Date().toISOString(),
    });
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest, parentCandidateId: anchorId },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: [crossReceipt],
    })).toBe(false);
  });

  it("parent-link mismatch refuses (forged base despite valid self-hash)", () => {
    // Honest durable receipt exists for honest live (parent anchorId), but the
    // caller claims a live whose durable parent link points elsewhere.
    const durable = [honestReceipt()];
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest, parentCandidateId: `candidate:${OP}:r999` },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: durable,
    })).toBe(false);
  });

  it("missing expectedOperationId fails closed", () => {
    const durable = [honestReceipt()];
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: "",
      assemblies: durable,
    })).toBe(false);
  });

  it("plain bind without receipt fails closed beyond anchor equality", () => {
    // No durable receipts (e.g., plain bindOperationCandidate gap): descendant
    // cannot prove parent digest → refuse; anchor equality still honors.
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: honestLiveId, revision: honestLiveRev, identityDigest: honestLiveDigest, parentCandidateId: anchorId },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: [],
    })).toBe(false);
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: { candidateId: anchorId, revision: anchorRev, identityDigest: anchorDigest },
      anchoredCandidateId: anchorId,
      anchoredRevision: anchorRev,
      anchoredIdentityDigest: anchorDigest,
      expectedOperationId: OP,
      assemblies: [],
    })).toBe(true);
  });
});
