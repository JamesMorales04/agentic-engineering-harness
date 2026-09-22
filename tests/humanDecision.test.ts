import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HumanDecisionError, HumanDecisionLedgerV1 } from "../src/security/index.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";

describe("HumanDecisionLedgerV1", () => {
  it("persists external authority decisions bound to the current candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-"));
    const candidate = createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", revision: 1, sourceDigest: "a".repeat(64) });
    const ledger = new HumanDecisionLedgerV1(path.join(root, "decisions.json"));
    const decision = await ledger.record({ operationId: "op-1", candidate, kind: "APPROVE", actorId: "human:james", reason: "reviewed evidence", createdAt: "2026-01-01T00:00:00Z" });
    expect((await ledger.active("op-1", candidate)).map((item) => item.decisionId)).toContain(decision.decisionId);
    await expect(ledger.record({ operationId: "op-1", candidate, kind: "APPROVE", actorId: "model:untrusted", reason: "self approve" })).rejects.toThrow(HumanDecisionError);
    await expect(ledger.record({ operationId: "op-1", candidate, kind: "FORGE" as never, actorId: "human:james", reason: "invalid kind" })).rejects.toThrow("unsupported human decision kind");
  });
});
