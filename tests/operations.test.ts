import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationId, extractWorkspaceId, startDetachedOperation } from "../src/operations/controller.js";
import { loadOperation, saveOperation, type OperationRecord } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function tempRoot(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-test-")); roots.push(root); return root; }

describe("operation controller state", () => {
  it("persists operation records atomically", async () => {
    const root = await tempRoot();
    const record: OperationRecord = {
      version: 1, id: "AUDIT-1", kind: "audit", status: "QUEUED", phase: "queued", root,
      payload: { request: "review" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await saveOperation(root, record);
    expect(await loadOperation(root, record.id)).toEqual(record);
  });

  it("starts a detached controller process and records its pid", async () => {
    const root = await tempRoot();
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref }));
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: spawnProcess as never
    });
    expect(record).toEqual(expect.objectContaining({ kind: "audit", status: "QUEUED", phase: "dispatched", pid: 4242 }));
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/node", ["/pkg/dist/main.js", "operation", "execute", record.id, root], expect.objectContaining({ detached: true, stdio: "ignore" }));
    expect(unref).toHaveBeenCalledTimes(1);
    expect((await loadOperation(root, record.id)).pid).toBe(4242);
  });

  it("extracts workspace ids from nested Paseo JSON", () => {
    expect(extractWorkspaceId(JSON.stringify({ requestId: "x", workspace: { id: "workspace-abc", cwd: "/repo" } }))).toBe("workspace-abc");
  });

  it("creates stable-shaped operation ids", () => {
    expect(createOperationId("audit", "same-seed")).toMatch(/^AUDIT-\d{8}T\d{6}Z-[a-f0-9]{8}$/);
  });
});
