import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateRevisionV1, type ParticipantReceiptV1 } from "../src/operations/v2Contracts.js";
import { bindOperationCandidate, loadOperation, patchOperation, recordParticipantReceipt, registerOperationAgent, saveOperation, transitionOperationToTerminal } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("operation candidate identity and participant terminal gates", () => {
  it("prevents in-place CandidateRevision replacement and requires a direct parent for N+1", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-candidate-immutable-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "AUDIT-IMMUTABLE", kind: "audit", status: "RUNNING", phase: "executing", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
    const current = (await loadOperation(root, "AUDIT-IMMUTABLE")).candidateRevision!;
    const replacement = createCandidateRevisionV1({ ...current, candidateId: "replacement-at-same-revision" });
    await expect(patchOperation(root, "AUDIT-IMMUTABLE", { candidateRevision: replacement })).rejects.toThrow("V2_CANDIDATE_IMMUTABLE");
    await expect(bindOperationCandidate(root, "AUDIT-IMMUTABLE", createCandidateRevisionV1({ ...current, candidateId: "candidate-without-parent", revision: 2 })))
      .rejects.toThrow("parent must be the current CandidateRevision");
    const next = createCandidateRevisionV1({ ...current, candidateId: "candidate-r2", revision: 2, parentCandidateId: current.candidateId });
    await expect(bindOperationCandidate(root, "AUDIT-IMMUTABLE", next)).resolves.toMatchObject({ candidateRevision: { identityDigest: next.identityDigest } });
  });

  it("persists the current candidate and accepts only a fully evidenced participant receipt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-v2-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "AUDIT-1", kind: "audit", status: "RUNNING", phase: "executing", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
    const candidate = (await loadOperation(root, "AUDIT-1")).candidateRevision!;
    await registerOperationAgent(root, "AUDIT-1", { id: "worker-1", role: "implementer" });
    const receipt: ParticipantReceiptV1 = {
      version: 1, receiptId: "receipt-1", operationId: "AUDIT-1", participantId: "worker-1", candidate, outcome: "SUCCEEDED", createdAt: now,
      runtimeTerminal: { kind: "runtime-terminal", eventId: "event-1", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
      contract: { contractId: "contract-1", contractDigest: "b".repeat(64), valid: true },
      artifact: { artifactId: "artifact-1", artifactDigest: "c".repeat(64), persisted: true, persistedAt: now },
      provenance: { provenanceId: "provenance-1", provenanceDigest: "d".repeat(64), source: "test", valid: true }
    };
    const updated = await recordParticipantReceipt(root, "AUDIT-1", receipt);
    expect(updated.participantReceipts?.["receipt-1"]).toEqual(receipt);
    expect((await loadOperation(root, "AUDIT-1")).participants["worker-1"].status).toBe("COMPLETED");
    expect((await transitionOperationToTerminal(root, "AUDIT-1", { status: "SUCCEEDED" })).transitioned).toBe(true);
  });

  it("does not allow a candidate-bound operation to succeed without participant receipts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-v2-gate-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "AUDIT-2", kind: "audit", status: "RUNNING", phase: "executing", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
    await registerOperationAgent(root, "AUDIT-2", { id: "worker-2", role: "reviewer" });
    await expect(transitionOperationToTerminal(root, "AUDIT-2", { status: "SUCCEEDED" })).rejects.toThrow("V2_TERMINAL_GATE_REJECTED");
  });

  it("rejects valid terminal evidence from an unregistered participant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-v2-unregistered-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "AUDIT-3", kind: "audit", status: "RUNNING", phase: "executing", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
    const candidate = (await loadOperation(root, "AUDIT-3")).candidateRevision!;
    await registerOperationAgent(root, "AUDIT-3", { id: "worker-expected", role: "reviewer" });
    const receipt: ParticipantReceiptV1 = {
      version: 1, receiptId: "receipt-unregistered", operationId: "AUDIT-3", participantId: "worker-not-registered", candidate, outcome: "SUCCEEDED", createdAt: now,
      runtimeTerminal: { kind: "runtime-terminal", eventId: "event-3", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
      contract: { contractId: "contract-3", contractDigest: "b".repeat(64), valid: true },
      artifact: { artifactId: "artifact-3", artifactDigest: "c".repeat(64), persisted: true, persistedAt: now },
      provenance: { provenanceId: "provenance-3", provenanceDigest: "d".repeat(64), source: "test", valid: true }
    };
    await expect(recordParticipantReceipt(root, "AUDIT-3", receipt)).rejects.toThrow("participant 'worker-not-registered' is not registered");
    expect((await loadOperation(root, "AUDIT-3")).participantReceipts).toBeUndefined();
    await expect(transitionOperationToTerminal(root, "AUDIT-3", { status: "SUCCEEDED" })).rejects.toThrow("V2_TERMINAL_GATE_REJECTED");
  });
});
