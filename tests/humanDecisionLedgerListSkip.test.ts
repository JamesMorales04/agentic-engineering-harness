import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HumanDecisionLedgerV2 } from "../src/security/index.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";

const STALE_UUID = "58f62955-0000-4000-8000-000000000000";

describe("HumanDecisionLedgerV2 lenient listing", () => {
  it("skips stale-purpose and unparseable files with a trace instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-list-skip-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const binding = createBinding();
      const dir = path.join(root, "decisions");
      const ledger = new HumanDecisionLedgerV2(dir);
      const valid = await ledger.record({
        ...binding,
        purpose: actionPurpose(),
        kind: "APPROVE",
        actorId: "human:owner:test",
        reason: "valid decision",
        createdAt: "2026-01-01T00:00:00Z",
      });
      await writeStaleExemptionFile(dir, binding);
      await fs.writeFile(path.join(dir, "corrupt.json"), "not-json{{{");
      warn.mockClear();

      const listed = await ledger.list();
      expect(listed.map((item) => item.decisionId)).toEqual([valid.decisionId]);
      const traces = warn.mock.calls.map((call) => String(call[0]));
      expect(traces.filter((line) => line.includes(`${STALE_UUID}.json`))).toHaveLength(1);
      expect(traces.filter((line) => line.includes("corrupt.json"))).toHaveLength(1);

      // Audit trail belongs to the Owner: the stale file is skipped, never deleted or migrated.
      await fs.access(path.join(dir, `${STALE_UUID}.json`));
      const preserved = JSON.parse(await fs.readFile(path.join(dir, `${STALE_UUID}.json`), "utf8")) as { purpose: { kind: string } };
      expect(preserved.purpose.kind).toBe("HARD_PROTECTION_EXEMPTION");
    } finally {
      warn.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps active() and purpose-scan consume() usable when a stale file is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-list-active-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const binding = createBinding();
      const dir = path.join(root, "decisions");
      const ledger = new HumanDecisionLedgerV2(dir);
      const valid = await ledger.record({
        ...binding,
        purpose: actionPurpose(),
        kind: "APPROVE",
        actorId: "human:owner:test",
        reason: "valid decision",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
      });
      await writeStaleExemptionFile(dir, binding);

      await expect(ledger.active(binding, new Date("2026-01-01T12:00:00Z"))).resolves.toMatchObject([{ decisionId: valid.decisionId }]);
      await expect(ledger.consume(binding, actionPurpose(), undefined, new Date("2026-01-01T12:00:00Z"))).resolves.toMatchObject({ decisionId: valid.decisionId });
    } finally {
      warn.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps strict by-id reads throwing on the stale file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-decision-list-strict-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const binding = createBinding();
      const dir = path.join(root, "decisions");
      const ledger = new HumanDecisionLedgerV2(dir);
      await ledger.record({
        ...binding,
        purpose: actionPurpose(),
        kind: "APPROVE",
        actorId: "human:owner:test",
        reason: "valid decision",
        createdAt: "2026-01-01T00:00:00Z",
      });
      await writeStaleExemptionFile(dir, binding);
      const staleId = `decision:${STALE_UUID}`;

      await expect(ledger.find(staleId)).rejects.toThrow("HARD_PROTECTION_EXEMPTION was removed");
      await expect(ledger.consumeExact(binding, actionPurpose(), staleId, "human:owner:test")).rejects.toThrow("HARD_PROTECTION_EXEMPTION was removed");
      await expect(ledger.consumedExact(binding, actionPurpose(), staleId, "human:owner:test")).rejects.toThrow("HARD_PROTECTION_EXEMPTION was removed");
    } finally {
      warn.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function writeStaleExemptionFile(dir: string, binding: ReturnType<typeof createBinding>): Promise<void> {
  const stale = {
    version: 2,
    decisionId: `decision:${STALE_UUID}`,
    ...binding,
    purpose: { kind: "HARD_PROTECTION_EXEMPTION", exemptionId: `exemption:${STALE_UUID}`, paths: ["frozen/task-contract.yaml"] },
    kind: "APPROVE",
    actorId: "human:owner:test",
    reason: "stale exemption intent (superseded purpose)",
    createdAt: "2026-01-01T00:00:00Z",
  };
  await fs.writeFile(path.join(dir, `${STALE_UUID}.json`), `${JSON.stringify(stale, null, 2)}\n`);
}

function createBinding() {
  return {
    operationId: "op-1",
    candidate: createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", revision: 1, sourceDigest: "a".repeat(64) }),
    operationExecutionRevision: 3,
    policyDigest: "b".repeat(64),
    controllerEpoch: 4,
  };
}

function actionPurpose() {
  return { kind: "ACTION_AUTHORIZATION" as const, action: "github.issue.create" as const, effectDigest: "c".repeat(64) };
}
