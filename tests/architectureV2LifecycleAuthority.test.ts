import { describe, expect, it } from "vitest";
import {
  createCandidateRevisionV1,
  evaluateTerminalGate,
  type ParticipantReceiptV1,
} from "../src/operations/v2Contracts.js";
import {
  createCapabilityLease,
  evaluatePermissionRequest,
  type PermissionRequestV1,
} from "../src/security/authorityV2.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const now = "2026-01-01T00:00:00.000Z";
const candidate = createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", revision: 1, sourceDigest: digest });

function receipt(overrides: Partial<ParticipantReceiptV1> = {}): ParticipantReceiptV1 {
  return {
    version: 1,
    receiptId: "receipt-1",
    operationId: candidate.operationId,
    participantId: "worker-1",
    candidate,
    outcome: "SUCCEEDED",
    runtimeTerminal: { kind: "runtime-terminal", eventId: "event-1", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
    contract: { contractId: "contract-1", contractDigest: digest, valid: true },
    artifact: { artifactId: "artifact-1", artifactDigest: digest, persisted: true, persistedAt: now },
    provenance: { provenanceId: "prov-1", provenanceDigest: digest, source: "runtime", valid: true },
    createdAt: now,
    ...overrides,
  };
}

function request(overrides: Partial<PermissionRequestV1> = {}): PermissionRequestV1 {
  return {
    version: 1,
    requestId: "request-1",
    operationId: candidate.operationId,
    participantId: "worker-1",
    candidate,
    capability: "read",
    requestedEnvelope: { version: 1, level: 1, capabilities: ["read"] },
    requestedAt: "2025-12-31T23:59:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    ...overrides,
  };
}

describe("AEH v2 identity, lifecycle, and authority contracts", () => {
  it("rejects a stale candidate receipt even when its participant claims success", () => {
    const stale = createCandidateRevisionV1({ ...candidate, revision: 2, sourceDigest: otherDigest });
    const decision = evaluateTerminalGate(receipt({ candidate: stale }), { operationId: candidate.operationId, candidate, now });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("CANDIDATE_MISMATCH");
  });

  it("does not convert a success-shaped receipt into completion without runtime terminal evidence", () => {
    const decision = evaluateTerminalGate(receipt({ runtimeTerminal: undefined }), { operationId: candidate.operationId, candidate, now });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("RUNTIME_TERMINAL_EVIDENCE_REQUIRED");
  });

  it("denies child authority escalation beyond a parent envelope", () => {
    const parent = createCapabilityLease(request(), { operationId: candidate.operationId, candidate, now });
    const child = evaluatePermissionRequest(request({ requestId: "child-1", capability: "write", requestedEnvelope: { version: 1, level: 2, capabilities: ["read", "write"] }, parentLeaseId: parent.leaseId }), { operationId: candidate.operationId, candidate, now, parentLease: parent });
    expect(child.allowed).toBe(false);
    expect(child.reasons.map((reason) => reason.code)).toContain("AUTHORITY_ESCALATION");
  });

  it("denies expired permission requests deterministically", () => {
    const decision = evaluatePermissionRequest(request({ expiresAt: "2025-12-31T23:59:59.000Z" }), { operationId: candidate.operationId, candidate, now });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("EXPIRED");
  });

  it("rejects a valid-looking request crossing operation or candidate boundaries", () => {
    const decision = evaluatePermissionRequest(request({ operationId: "op-2", candidate: createCandidateRevisionV1({ ...candidate, operationId: "op-2" }) }), { operationId: candidate.operationId, candidate, now });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["OPERATION_MISMATCH", "CANDIDATE_MISMATCH"]));
  });

  it("does not let a project-scoped authority request cross project identity", () => {
    const projectCandidate = createCandidateRevisionV1({ ...candidate, projectId: "project-a" });
    const decision = evaluatePermissionRequest(request({ candidate: projectCandidate, projectId: "project-b" }), { operationId: candidate.operationId, projectId: "project-a", candidate: projectCandidate, now });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("PROJECT_MISMATCH");
  });
});
