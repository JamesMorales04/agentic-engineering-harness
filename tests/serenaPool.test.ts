import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SerenaPoolOwnershipError, SerenaPoolV1 } from "../src/runtime/index.js";

describe("SerenaPoolV1", () => {
  it("shares read-only project/workspace sessions and enforces one leased writer", async () => {
    const pool = new SerenaPoolV1();
    const canonicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-serena-pool-"));
    const common = { projectId: "p", canonicalRoot, workspaceId: "w", serenaVersion: "0.1" };
    const reader = pool.acquire({ ...common, ownerId: "reader-1" });
    const secondReader = pool.acquire({ ...common, ownerId: "reader-2" });
    expect(reader.mcpServer.command).toContain("serena-proxy");
    expect(reader.mcpServer.environment).toMatchObject({ AEH_SERENA_ACCESS: "read", AEH_SERENA_ROOT: canonicalRoot });
    expect(reader.allowedTools).toContain("get_symbols_overview");
    expect(reader.deniedTools).toContain("replace_symbol_body");
    expect(pool.snapshot()).toHaveLength(2);
    const writer = pool.acquire({ ...common, ownerId: "writer", access: "write", editingEnabled: true });
    expect(writer.editingEnabled).toBe(true);
    expect(writer.mcpServer.command).toContain("serena-proxy");
    expect(writer.mcpServer.environment).toMatchObject({ AEH_SERENA_ACCESS: "write", AEH_SERENA_WRITER_LEASE_FILE: expect.any(String), AEH_SERENA_WRITER_LEASE_TOKEN: expect.any(String) });
    expect(writer.deniedTools).toEqual([]);
    expect(() => pool.acquire({ ...common, ownerId: "other", access: "write", editingEnabled: true })).toThrow(SerenaPoolOwnershipError);
    pool.release(writer.sessionId, "writer");
    pool.release(reader.sessionId, "reader-1");
    pool.release(secondReader.sessionId, "reader-2");
    await fs.rm(canonicalRoot, { recursive: true, force: true });
  });
});
