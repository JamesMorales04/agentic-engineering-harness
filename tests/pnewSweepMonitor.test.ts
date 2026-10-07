import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reconcileTerminalOperationResources, registerOperationResource } from "../src/runtime/operationResources.js";
import { loadOperation } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { spawnOperationMonitor } from "../src/operations/monitorProcess.js";
describe("P-NEW sweep + monitor registration", () => {
  it("P-NEW-2: sweep visits every operation beyond 200", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew-sweep-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
      const now = new Date().toISOString();
      for (let i = 0; i < 201; i++) {
        const id = `AUDIT-SWEEP-${String(i).padStart(4, "0")}`;
        await fs.writeFile(path.join(root, ".harness", "operations", `${id}.json`), JSON.stringify({ version: 2, id, kind: "audit", status: "SUCCEEDED", phase: "finished", root, payload: { request: "s" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now, finishedAt: now }));
      }
      const sweep = await reconcileTerminalOperationResources(root);
      expect(sweep.operationsScanned).toBe(201);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("P-NEW-5: monitor registration failure warns instead of vanishing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pnew-mon-"));
    try {
      const op = { version: 1, id: "AUDIT-MON-REGFAIL", kind: "audit", status: "RUNNING", phase: "executing", root, payload: { request: "r" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never;
      await saveOwnedOperation(root, op);
      for (let i = 0; i < 64; i++) await registerOperationResource(root, (op as { id: string }).id, { kind: "staging-root", identity: `s${i}`, path: `/tmp/aeh-pnew-s${i}` });
      const child = { pid: 5252, unref: vi.fn(), once: vi.fn(() => child) } as never;
      await spawnOperationMonitor(root, await loadOperation(root, (op as { id: string }).id), { nodeExecutable: "/usr/bin/node", entryFile: "/pkg/dist/main.js", spawnProcess: (() => child) as never });
      const warnings = (await loadOperation(root, (op as { id: string }).id)).cleanupWarnings ?? [];
      expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/liveness monitor.*regist/i)]));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
