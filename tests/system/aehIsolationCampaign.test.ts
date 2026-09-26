import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { detectIsolationCapabilities, runIsolatedCommand, type IsolationExecutionEvidenceV1 } from "../../src/security/isolation.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "isolation-campaign" },
  evidence: { outputDir: ".harness/evidence" },
  security: { isolation: { required: true } }
};
const contract: TaskContract = { version: 1, task: { id: "ISO-1", title: "isolation campaign" } };
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-isolation-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "isolation-fixture", version: "1.0.0" }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("real rootless isolation campaign", () => {
  it("requires a real rootless isolation provider and never silently skips", async () => {
    const capabilities = await detectIsolationCapabilities(process.cwd());
    if (!capabilities.available) throw new Error(`ISOLATION_PROVIDER_UNAVAILABLE: no rootless isolation provider is executable. ${capabilities.details.join("; ")}`);
    expect(capabilities.provider).toBe("bwrap");
    expect(capabilities.rootless).toBe(true);
    expect(capabilities.providerVersion).toBeTruthy();
  });

  it("actually exercises user, PID, mount, UTS, IPC and network namespaces with scope isolation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-isolation-campaign-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "input.txt"), "hello\n");
    const hostMarker = spawn("sleep", ["30"]);
    const secretName = "AEH_S10_HOST_SECRET_PROBE";
    process.env[secretName] = "host-secret-value";
    // A host-only sentinel directly under the home root proves home masking
    // independently of bind-destination parent directories (npm/npx put the
    // repository's node_modules/.bin on PATH, which becomes a read-only bind).
    const hostSentinel = path.join(os.homedir(), `.aeh-s10-host-sentinel-${process.pid}`);
    await fs.writeFile(hostSentinel, "host-only\n");
    try {
      const script = [
        `echo "uid=$(id -u)"`,
        `echo "ifaces=$(ip -o link show 2>/dev/null | wc -l)"`,
        `echo "host_pid=$(test -d /proc/${hostMarker.pid} && echo visible || echo masked)"`,
        `echo "host_secret=$(test -n "$${secretName}" && echo visible || echo masked)"`,
        `echo "host_ssh=$(test -e ${os.homedir()}/.ssh && echo visible || echo masked)"`,
        `echo "host_home_sentinel=$(test -e ${hostSentinel} && echo visible || echo masked)"`,
        `echo "etc_write=$( (echo x > /etc/aeh-s10-probe) 2>/dev/null && echo allowed || echo denied)"`,
        `echo "home_probe=$( (echo x > ${os.homedir()}/aeh-s10-escape.txt) 2>/dev/null && echo allowed || echo denied)"`,
        `echo "ephemeral_sibling=$( (echo x > ${root}/sibling.txt) 2>/dev/null && echo written || echo failed)"`,
        `echo "workspace_write=$( (echo ok > ${workspace}/written.txt) 2>/dev/null && echo allowed || echo denied)"`,
        `grep -E "^(CapEff|NoNewPrivs):" /proc/self/status`,
        `node -e 'const s=require("net").connect(80,"1.1.1.1");s.setTimeout(1500);s.on("connect",()=>{console.log("network=connected");process.exit(0)});s.on("error",e=>{console.log("network=denied:"+e.code);process.exit(0)});s.on("timeout",()=>{console.log("network=timeout");process.exit(0)})'`
      ].join("\n");
      const result = await runIsolatedCommand({ root, command: script, cwd: workspace, workspaceRoot: workspace, writablePaths: [workspace], timeoutMs: 60_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`uid=${process.getuid!()}`);
      expect(result.stdout).toContain("ifaces=1");
      expect(result.stdout).toContain("host_pid=masked");
      expect(result.stdout).toContain("host_secret=masked");
      expect(result.stdout).toContain("host_ssh=masked");
      expect(result.stdout).toContain("host_home_sentinel=masked");
      expect(result.stdout).toContain("etc_write=denied");
      expect(result.stdout).toContain("workspace_write=allowed");
      expect(result.stdout).toMatch(/NoNewPrivs:\s*1/);
      expect(result.stdout).toMatch(/CapEff:\s*0{16}/);
      expect(result.stdout).toMatch(/network=denied(:\w+)?/);
      await expect(fs.access(path.join(workspace, "written.txt"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, "sibling.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(os.homedir(), "aeh-s10-escape.txt"))).rejects.toThrow();
      expect(result.isolation.namespaces).toMatchObject({ user: true, mount: true, pid: true, uts: true, ipc: true, network: false });
      expect(result.isolation.networkAccess).toBe("none");
      expect(result.isolation.rootless).toBe(true);
    } finally {
      hostMarker.kill("SIGKILL");
      delete process.env[secretName];
      await fs.rm(hostSentinel, { force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs required validator commands inside the sandbox and blocks repo mutation and egress", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "probe.mjs"), [
      'import fs from "node:fs";',
      'import net from "node:net";',
      'let mutation = "allowed";',
      'try { fs.writeFileSync(new URL("./mutated.txt", import.meta.url), "x"); } catch { mutation = "denied"; }',
      'const network = await new Promise((resolve) => {',
      '  const socket = net.connect(80, "1.1.1.1");',
      '  socket.setTimeout(1200);',
      '  socket.on("connect", () => resolve("connected"));',
      '  socket.on("error", (error) => resolve(`denied:${error.code}`));',
      '  socket.on("timeout", () => resolve("timeout"));',
      '});',
      'process.stdout.write(JSON.stringify({ results: [], probe: { mutation, network } }));'
    ].join("\n"));
    const check = await runExternalToolValidator({
      root, config, contract,
      spec: { id: "isolated-validator", adapter: "opengrep", command: "node probe.mjs", required: true },
      baseRef: "HEAD", changedFiles: []
    });
    expect(check.status).toBe("PASS");
    const isolation = check.details?.isolation as IsolationExecutionEvidenceV1;
    expect(isolation.networkAccess).toBe("none");
    expect(isolation.namespaces.network).toBe(false);
    expect(isolation.writablePaths.some((entry) => entry.endsWith(path.join(".harness", "evidence")))).toBe(true);
    expect(isolation.visibleReadOnlyPaths).toContain(root);
    const raw = await fs.readFile(path.resolve(root, String(check.details?.rawArtifact)), "utf8");
    expect(raw).toContain('"mutation":"denied"');
    expect(raw).toMatch(/"network":"denied/);
    await expect(fs.access(path.join(root, "mutated.txt"))).rejects.toThrow();
  });
});
