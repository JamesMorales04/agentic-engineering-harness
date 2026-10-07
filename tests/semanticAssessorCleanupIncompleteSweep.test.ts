import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_PASEO_SDK_AGENT_LIST_PAGES_V1, listPaseoSdkAgentsWithClient } from "../src/paseo/sdk.js";
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

const sdkAgent = (id: string) => ({ id, labels: { "aeh.kind": "semantic-assessment" }, status: "idle" });

async function ledgerIds(root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return Object.keys((JSON.parse(raw) as { attempts?: Record<string, unknown> }).attempts ?? {});
}

async function telemetryEvents(root: string): Promise<Array<{ name: string; attributes: Record<string, unknown> }>> {
  const raw = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
}

describe("P-NEW-3 round-4 RED: honest pagination + fail-closed prune", () => {
  it("R1: repeated-token stop reports exhausted=false (partial listing is honest)", async () => {
    const list = vi.fn(async (options?: Record<string, unknown>) => {
      if ((options as { cursor?: string } | undefined)?.cursor === "tok-repeat") {
        // Server re-mints the same cursor: no forward progress is possible.
        return { entries: [{ agent: sdkAgent("page2-b") }], nextCursor: "tok-repeat" };
      }
      return { entries: [{ agent: sdkAgent("page1-a") }], nextCursor: "tok-repeat" };
    });
    const client = { agents: { create: vi.fn(), ref: vi.fn(), list }, connect: vi.fn(), close: vi.fn() };
    const listing = await listPaseoSdkAgentsWithClient(client as never, { "aeh.kind": "semantic-assessment" });
    expect(listing.agents.map((r) => r.id).sort()).toEqual(["page1-a", "page2-b"]);
    expect(listing.exhausted).toBe(false);
  });

  it("R2: 50-page safety cap keeps bounded work but reports exhausted=false", async () => {
    let n = 0;
    const list = vi.fn(async () => {
      n += 1;
      return { entries: [{ agent: sdkAgent(`cap-${n}`) }], nextCursor: `tok-${n}` };
    });
    const client = { agents: { create: vi.fn(), ref: vi.fn(), list }, connect: vi.fn(), close: vi.fn() };
    const listing = await listPaseoSdkAgentsWithClient(client as never, { "aeh.kind": "semantic-assessment" });
    expect(list).toHaveBeenCalledTimes(MAX_PASEO_SDK_AGENT_LIST_PAGES_V1);
    expect(listing.agents).toHaveLength(MAX_PASEO_SDK_AGENT_LIST_PAGES_V1);
    expect(listing.exhausted).toBe(false);
  });

  it("R2b: genuine exhaustion still reports exhausted=true", async () => {
    const list = vi.fn(async (options?: Record<string, unknown>) => {
      if ((options as { cursor?: string } | undefined)?.cursor === "page-2") {
        return { entries: [{ agent: sdkAgent("page2-b") }] };
      }
      return { entries: [{ agent: sdkAgent("page1-a") }], nextCursor: "page-2" };
    });
    const client = { agents: { create: vi.fn(), ref: vi.fn(), list }, connect: vi.fn(), close: vi.fn() };
    const listing = await listPaseoSdkAgentsWithClient(client as never, { "aeh.kind": "semantic-assessment" });
    expect(listing.agents.map((r) => r.id).sort()).toEqual(["page1-a", "page2-b"]);
    expect(listing.exhausted).toBe(true);
  });

  it("R3: gone-proof PRUNE REFUSES on an incomplete listing (fail closed, retry next sweep)", async () => {
    const root = await mkRoot("aeh-pnew3r4-r3-");
    try {
      await fs.writeFile(
        path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"),
        JSON.stringify({ version: 1, attempts: { "live-but-unlisted": { attempts: 1, updatedAt: "2026-10-01T00:00:00.000Z" } } }),
        "utf8"
      );
      // Capped/repeated-token sweep: the live id exists server-side but is NOT
      // in this partial page window. Pruning it would lose its retry count.
      const list = vi.fn(async () => ({ agents: [orphan("some-other-id")], exhausted: false as const }));
      const archiveAgent = vi.fn(async () => undefined);
      await retryOrphanedAssessorCleanupV1(root, { list: list as never, archiveAgent });
      expect(await ledgerIds(root)).toContain("live-but-unlisted");
      const events = await telemetryEvents(root);
      expect(events.filter((e) => e.name.endsWith("semantic.assessor.cleanup-incomplete-sweep")).length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmRoot(root);
    }
  });

  it("R4: proven-complete listing still prunes a workspace-free absent id", async () => {
    const root = await mkRoot("aeh-pnew3r4-r4-");
    try {
      await fs.writeFile(
        path.join(root, ".harness", "semantic-assessor-cleanup-v1.json"),
        JSON.stringify({ version: 1, attempts: { "gone-id": { attempts: 1, updatedAt: "2026-10-01T00:00:00.000Z" } } }),
        "utf8"
      );
      const list = vi.fn(async () => ({ agents: [orphan("some-other-id")], exhausted: true as const }));
      const archiveAgent = vi.fn(async () => undefined);
      await retryOrphanedAssessorCleanupV1(root, { list: list as never, archiveAgent });
      expect(await ledgerIds(root)).not.toContain("gone-id");
    } finally {
      await rmRoot(root);
    }
  });
});
