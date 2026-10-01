import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { buildDirectWorkerEnvironment, runDirectWorkerProcess } from "../src/workers/directProcess.js";
import { runExecutable, runShell } from "../src/utils/process.js";

describe("direct worker process boundary", () => {
  it("does not inherit ambient credentials or controller identity", () => {
    const previousSecret = process.env.AEH_DIRECT_TEST_SECRET;
    const previousAllowed = process.env.AEH_DIRECT_ALLOWED;
    process.env.AEH_DIRECT_TEST_SECRET = "ambient-secret";
    process.env.AEH_DIRECT_ALLOWED = "allowlisted";
    try {
      const config: HarnessProjectConfig = {
        version: 1,
        project: { name: "direct-process-test" },
        security: { sandbox: { environmentAllowlist: ["AEH_DIRECT_ALLOWED"] } }
      };
      const environment = buildDirectWorkerEnvironment(config, { EXPLICIT_VALUE: "explicit" }, "/tmp/aeh-controlled-home");
      expect(environment.AEH_DIRECT_TEST_SECRET).toBeUndefined();
      expect(environment.AEH_DIRECT_ALLOWED).toBe("allowlisted");
      expect(environment.EXPLICIT_VALUE).toBe("explicit");
      expect(environment.AEH_OPERATION_ID).toBeUndefined();
      expect(environment.HOME).toBe("/tmp/aeh-controlled-home");
    } finally {
      if (previousSecret === undefined) delete process.env.AEH_DIRECT_TEST_SECRET;
      else process.env.AEH_DIRECT_TEST_SECRET = previousSecret;
      if (previousAllowed === undefined) delete process.env.AEH_DIRECT_ALLOWED;
      else process.env.AEH_DIRECT_ALLOWED = previousAllowed;
    }
  });

  it("executes with the filtered environment in a real child process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-process-test-"));
    const previousSecret = process.env.AEH_DIRECT_TEST_SECRET;
    process.env.AEH_DIRECT_TEST_SECRET = "ambient-secret";
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "direct-process-test" } };
      const result = await runDirectWorkerProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify({secret:process.env.AEH_DIRECT_TEST_SECRET,home:process.env.HOME}))"], config, { cwd: root, timeoutMs: 2_000 });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ home: expect.stringContaining("aeh-direct-home-") });
    } finally {
      if (previousSecret === undefined) delete process.env.AEH_DIRECT_TEST_SECRET;
      else process.env.AEH_DIRECT_TEST_SECRET = previousSecret;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes hostile arguments literally without interpreting shell syntax", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-hostile-argv-test-"));
    const marker = path.join(root, "should-not-exist");
    const hostile = `literal ; touch ${marker} && $(touch ${marker}) | \`touch ${marker}\`\nsecond-line`;
    try {
      const result = await runExecutable(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", hostile], { cwd: root, timeoutMs: 2_000 });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([hostile]);
      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not leak operation state redirection into repository commands", async () => {
    const previous = {
      id: process.env.AEH_OPERATION_ID,
      root: process.env.AEH_CONTROL_ROOT,
      redirect: process.env.AEH_OPERATION_STATE_REDIRECT
    };
    process.env.AEH_OPERATION_ID = "operation-1";
    process.env.AEH_CONTROL_ROOT = "/tmp/controller-root";
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    try {
      const result = await runExecutable(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify({id:process.env.AEH_OPERATION_ID,root:process.env.AEH_CONTROL_ROOT,redirect:process.env.AEH_OPERATION_STATE_REDIRECT}))"],
        { cwd: process.cwd(), timeoutMs: 2_000 }
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
    } finally {
      if (previous.id === undefined) delete process.env.AEH_OPERATION_ID;
      else process.env.AEH_OPERATION_ID = previous.id;
      if (previous.root === undefined) delete process.env.AEH_CONTROL_ROOT;
      else process.env.AEH_CONTROL_ROOT = previous.root;
      if (previous.redirect === undefined) delete process.env.AEH_OPERATION_STATE_REDIRECT;
      else process.env.AEH_OPERATION_STATE_REDIRECT = previous.redirect;
    }
  });

  it("does not leak managed-agent identity into repository commands", async () => {
    const names = [
      "AEH_MANAGED_AGENT", "AEH_LOGICAL_AGENT", "AEH_AGENT_ROLE", "AEH_PARENT_OPERATION_ID", "AEH_PARENT_OPERATION_KIND",
      "AEH_AGENT_PHASE", "AEH_INTERACTIVE_LEAD", "AEH_ORCHESTRATION_ALLOWED", "AEH_ALLOW_NESTED_OPERATION", "AEH_OPERATION_SUPERVISOR",
      "AEH_PARENT_AGENT_ID", "AEH_SUPERVISOR_GENERATION", "AEH_CONTEXT_OPERATION_ID", "AEH_CONTEXT_PHASE", "AEH_CONTEXT_ROOT", "AEH_ENTRY_FILE"
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = "ambient-identity";
    try {
      const result = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.filter((name)=>process.env[name] !== undefined)))`],
        { cwd: process.cwd(), timeoutMs: 2_000 }
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it("settles after a timeout even when a detached descendant retains stdio", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-process-timeout-"));
    const pidFile = path.join(root, "child.pid");
    let descendantPid: number | undefined;
    const script = "const fs=require('node:fs'); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'}); c.unref(); fs.writeFileSync(process.argv[1],String(c.pid)); setTimeout(()=>{},60000);";
    try {
      const started = Date.now();
      const result = await runDirectWorkerProcess(process.execPath, ["-e", script, pidFile], { version: 1, project: { name: "direct-process-test" } }, { cwd: root, timeoutMs: 1_000 });
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(3_000);
      descendantPid = Number(await fs.readFile(pidFile, "utf8"));
    } finally {
      if (descendantPid) {
        try { process.kill(-descendantPid, "SIGKILL"); } catch { /* already exited */ }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
