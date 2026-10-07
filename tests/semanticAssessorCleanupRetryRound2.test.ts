import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retryOrphanedAssessorCleanupV1 } from "../src/semantic/runtime.js";

async function traceNames(root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { name: string }).name);
}

async function ledgerAttempts(root: string): Promise<Record<string, number>> {
  const raw = await fs.readFile(path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"), "utf8").catch(() => "");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as { attempts?: Record<string, { attempts: number }> };
  return Object.fromEntries(Object.entries(parsed.attempts ?? {}).map(([id, e]) => [id, e.attempts]));
}

function orphan(id: string) {
  return { id, labels: { "aeh.kind": "semantic-assessment" }, status: "idle", raw: {} };
}

describe("P-NEW-3 round-2 RED", () => {
  it("M1: size prune must never discard retry limits for LIVE orphans", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3r2-m1-"));
    try {
      // 55 LIVE orphans, each with a recorded attempt. Oldest-prune (>50) would evict 5+.
      const ids = Array.from({ length: 55 }, (_, i) => `live-orphan-${String(i).padStart(3, "0")}`);
      const seed: Record<string, { attempts: number; updatedAt: string }> = {};
      for (const id of ids) seed[id] = { attempts: 1, updatedAt: "2026-10-01T00:00:00.000Z" };
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"), JSON.stringify({ version: 1, attempts: seed }), "utf8");
      const list = vi.fn(async () => ids.map(orphan));
      const archiveAgent = vi.fn(async () => { throw new Error("archive still failing"); });
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      const after = await ledgerAttempts(root);
      // Every LIVE orphan keeps its limit: none evicted for size.
      for (const id of ids) expect(after[id], id).toBeGreaterThanOrEqual(1);
      const names = await traceNames(root);
      expect(names.some((n) => n.endsWith("semantic.assessor.cleanup-ledger-overflow"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("M2: successive sweeps must make progress past the first page (no starvation)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew3r2-m2-"));
    try {
      const ids = Array.from({ length: 12 }, (_, i) => `starve-orphan-${String(i).padStart(2, "0")}`);
      const list = vi.fn(async () => ids.map(orphan));
      const archived: string[] = [];
      const archiveAgent = vi.fn(async (_r: string, id: string) => { archived.push(id); });
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      const firstSweep = [...archived];
      expect(firstSweep.length).toBe(10);
      archived.length = 0;
      await retryOrphanedAssessorCleanupV1(root, { list, archiveAgent });
      const secondSweep = [...archived];
      // Orphans past the first window must be reached on the next sweep.
      expect(secondSweep).toContain("starve-orphan-10");
      expect(secondSweep).toContain("starve-orphan-11");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
