import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HumanDecisionError, HumanDecisionLedgerV2 } from "../src/security/index.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";

describe("HumanDecisionLedgerV2", () => {
  it("persists typed, attributable decisions bound to current policy and epoch identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-"));
    try {
      const binding = createBinding();
      const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
      const decision = await ledger.record({ ...binding, purpose: actionPurpose(), kind: "APPROVE", actorId: "human:control-center:test", reason: "reviewed exact effect", createdAt: "2026-01-01T00:00:00Z" });
      expect((await ledger.active(binding)).map((item) => item.decisionId)).toContain(decision.decisionId);
      await expect(ledger.record({ ...binding, purpose: actionPurpose(), kind: "APPROVE", actorId: "model:untrusted", reason: "self approve" })).rejects.toThrow(HumanDecisionError);
      await expect(ledger.record({ ...binding, purpose: actionPurpose(), kind: "CHOOSE", actorId: "human:test", reason: "wrong type" })).rejects.toThrow("action authorization requires APPROVE or REJECT");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("consumes only an exact current decision once and rejects scope, epoch, and replay mismatches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-consume-"));
    try {
      const binding = createBinding();
      const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
      const purpose = actionPurpose();
      const decision = await ledger.record({ ...binding, purpose, kind: "APPROVE", actorId: "human:control-center:test", reason: "approved exact effect", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z" });
      await expect(ledger.consume({ ...binding, controllerEpoch: 5 }, purpose, undefined, new Date("2026-01-01T12:00:00Z"))).rejects.toThrow("no current HumanDecision");
      await expect(ledger.consume(binding, { ...purpose, effectDigest: "f".repeat(64) }, undefined, new Date("2026-01-01T12:00:00Z"))).rejects.toThrow("no current HumanDecision");
      await expect(ledger.consume(binding, purpose, undefined, new Date("2026-01-01T12:00:00Z"))).resolves.toMatchObject({ decisionId: decision.decisionId });
      await expect(ledger.consume(binding, purpose, undefined, new Date("2026-01-01T12:00:00Z"))).rejects.toThrow("consumed or replayed");
      expect(await ledger.active(binding, new Date("2026-01-01T12:00:00Z"))).toEqual([]);
      await expect(ledger.consume(binding, purpose, undefined, new Date("2026-01-03T00:00:00Z"))).rejects.toThrow("expired");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reserves one exact product choice per request and recovers it only under the same binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-product-choice-"));
    try {
      const binding = createBinding();
      const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
      const requestId = "request:product-choice-test";
      const input = {
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE" as const, requestId, choiceId: "keep-current" },
        kind: "CHOOSE" as const,
        actorId: "human:control-center:paired-session",
        reason: "Keep the existing product behavior.",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-02T00:00:00Z"
      };
      const decision = await ledger.recordProductChoice(input, requestId);
      await expect(ledger.recordProductChoice(input, requestId)).rejects.toThrow("already been submitted or replayed");
      await expect(ledger.productChoiceForRequest(requestId, { ...binding, controllerEpoch: 9 }, ["keep-current"])).rejects.toThrow("does not match");
      await expect(ledger.productChoiceForRequest(requestId, binding, ["different-choice"])).rejects.toThrow("does not match");
      await expect(ledger.productChoiceForRequest(requestId, binding, ["keep-current"])).resolves.toMatchObject({ decisionId: decision.decisionId, actorId: input.actorId });
      const purpose = { kind: "PRODUCT_CHOICE" as const, requestId, choiceId: "keep-current" };
      await expect(ledger.consumeExact(binding, purpose, decision.decisionId, input.actorId, new Date("2026-01-01T12:00:00Z"))).resolves.toMatchObject({ decisionId: decision.decisionId });
      await expect(ledger.consumeExact(binding, purpose, decision.decisionId, input.actorId, new Date("2026-01-01T12:00:00Z"))).rejects.toThrow("consumed or replayed");
      expect(await ledger.consumedExact(binding, purpose, decision.decisionId, input.actorId)).toMatchObject({ decisionId: decision.decisionId });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit migration for legacy ledger files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-v1-"));
    try {
      const ledgerPath = path.join(root, "decisions.json");
      await fs.writeFile(ledgerPath, JSON.stringify([{ version: 1 }]), { mode: 0o600 });
      await expect(new HumanDecisionLedgerV2(ledgerPath).list()).rejects.toThrow("UNSUPPORTED_HUMAN_DECISION_VERSION");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function createBinding() {
  return {
    operationId: "op-1",
    candidate: createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", revision: 1, sourceDigest: "a".repeat(64) }),
    operationExecutionRevision: 3,
    policyDigest: "b".repeat(64),
    controllerEpoch: 4
  };
}

function actionPurpose() {
  return { kind: "ACTION_AUTHORIZATION" as const, action: "github.issue.create" as const, effectDigest: "c".repeat(64) };
}
