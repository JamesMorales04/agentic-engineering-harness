import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listPaseoSdkAgentsWithClient } from "../src/paseo/sdk.js";
import { retryOrphanedAssessorCleanupV1 } from "../src/semantic/runtime.js";

async function mkRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

async function rmRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

function orphan(id: string, status = "idle") {
  return { id, labels: { "aeh.kind": "semantic-assessment" }, status, raw: {} };
}

async function ledgerAttempts(root: string): Promise<Record<string, number>> {
  const raw = await fs.readFile(path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"), "utf8").catch(() => "");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as { attempts?: Record<string, { attempts: number }> };
  return Object.fromEntries(Object.entries(parsed.attempts ?? {}).map(([id, e]) => [id, e.attempts]));
}

async function telemetryEvents(root: string): Promise<Array<{ name: string; attributes: Record<string, unknown> }>> {
  const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
}

describe("P-NEW-3 round-3 RED", () => {
  it("G1a: ledger entry for a LIVE working agent (absent from the filtered set) is never pruned", async () => {
    const root = await mkRoot("aeh-pnew3r3-g1a-");
    try {
      await fs.writeFile(
        path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"),
        JSON.stringify({ version: 1, attempts: { "live-working-01": { attempts: 2, updatedAt: "2026-10-01T00:00:00.000Z" } } }),
        "utf8"
      );
      // Unfiltered listing CONTAINS the live working agent (any status);
      // the pre-op filter excludes it, but the gone-proof must still see it.
      const list = vi.fn(async () => [orphan("live-working-01", "working")]);
      const archiveAgent = vi.fn(async () => undefined);
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      expect(archiveAgent).not.toHaveBeenCalled();
      const after = await ledgerAttempts(root);
      expect(after["live-working-01"]).toBe(2);
    } finally {
      await rmRoot(root);
    }
  });

  it("G1b: SDK listing paginates through ALL pages (loop until exhausted)", async () => {
    const sdkAgent = (id: string) => ({ id, labels: { "aeh.kind": "semantic-assessment" }, status: "idle" });
    const list = vi.fn(async (options?: Record<string, unknown>) => {
      if ((options as { cursor?: string } | undefined)?.cursor === "page-2") {
        return { entries: [{ agent: sdkAgent("page2-b") }] };
      }
      return { entries: [{ agent: sdkAgent("page1-a") }], nextCursor: "page-2" };
    });
    const client = { agents: { create: vi.fn(), ref: vi.fn(), list }, connect: vi.fn(), close: vi.fn() };
    const records = await listPaseoSdkAgentsWithClient(client as never, { "aeh.kind": "semantic-assessment" });
    expect(records.map((r) => r.id).sort()).toEqual(["page1-a", "page2-b"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ cursor: "page-2" }));
  });

  it("G2: missing cursor resumes from the first id GREATER than the cursor (never restarts head mid-pass)", async () => {
    const root = await mkRoot("aeh-pnew3r3-g2-");
    try {
      const ids = Array.from({ length: 12 }, (_, i) => `g2-${String(i).padStart(2, "0")}`);
      await fs.writeFile(
        path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"),
        JSON.stringify({ version: 1, attempts: {}, cursor: "g2-04~" }),
        "utf8"
      );
      const list = vi.fn(async () => ids.map((id) => orphan(id)));
      const archived: string[] = [];
      const archiveAgent = vi.fn(async (_r: string, id: string) => { archived.push(id); });
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      // Forward progress: resume at g2-05, not g2-00.
      expect(archived[0]).toBe("g2-05");
      expect(archived).toContain("g2-11");
    } finally {
      await rmRoot(root);
    }
  });

  it("G2b: cursor past the end wraps to head (full pass completed)", async () => {
    const root = await mkRoot("aeh-pnew3r3-g2b-");
    try {
      const ids = Array.from({ length: 12 }, (_, i) => `g2-${String(i).padStart(2, "0")}`);
      await fs.writeFile(
        path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"),
        JSON.stringify({ version: 1, attempts: {}, cursor: "zzz-past-end" }),
        "utf8"
      );
      const list = vi.fn(async () => ids.map((id) => orphan(id)));
      const archived: string[] = [];
      const archiveAgent = vi.fn(async (_r: string, id: string) => { archived.push(id); });
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      expect(archived[0]).toBe("g2-00");
    } finally {
      await rmRoot(root);
    }
  });

  it("G3: skipped working/running sessions emit a visible trace signal", async () => {
    const root = await mkRoot("aeh-pnew3r3-g3-");
    try {
      const list = vi.fn(async () => [orphan("skip-live-01", "working"), orphan("idle-01", "idle")]);
      const archiveAgent = vi.fn(async () => undefined);
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      const events = await telemetryEvents(root);
      const skipped = events.filter((e) => e.name.endsWith("semantic.assessor.cleanup-skipped-live"));
      expect(skipped.length).toBeGreaterThanOrEqual(1);
      expect(skipped[0]?.attributes["skipped"]).toBe(1);
      expect(skipped[0]?.attributes["agentIds"]).toEqual(["skip-live-01"]);
    } finally {
      await rmRoot(root);
    }
  });
});
