import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runShell } from "../src/utils/process.js";

describe("process cleanup", () => {
  it("terminates descendants when a shell command times out", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-process-cleanup-"));
    const pidFile = path.join(root, "child.pid");
    const script = "const fs=require('node:fs'); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(c.pid)); setTimeout(()=>{},60000);";
    try {
      const result = await runShell(`${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(pidFile)}`, { cwd: root, timeoutMs: 500 });
      expect(result.durationMs).toBeLessThan(5_000);
      const childPid = Number(await fs.readFile(pidFile, "utf8"));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && await exists(`/proc/${childPid}`)) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await exists(`/proc/${childPid}`)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("settles when a detached descendant retains the helper stdio pipes", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-process-pipe-cleanup-"));
    const pidFile = path.join(root, "child.pid");
    let childPid: number | undefined;
    const script = "const fs=require('node:fs'); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:['ignore','inherit','inherit']}); c.unref(); fs.writeFileSync(process.argv[1],String(c.pid)); setTimeout(()=>{},60000);";
    try {
      const started = Date.now();
      const result = await runShell(`${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(pidFile)}`, { cwd: root, timeoutMs: 250 });
      const durationMs = Date.now() - started;
      childPid = Number(await fs.readFile(pidFile, "utf8"));
      expect(result.timedOut).toBe(true);
      expect(durationMs).toBeLessThan(3_000);
      expect(await exists(`/proc/${childPid}`)).toBe(true);
    } finally {
      if (childPid && process.platform !== "win32") {
        try { process.kill(-childPid, "SIGKILL"); } catch { /* already exited */ }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
