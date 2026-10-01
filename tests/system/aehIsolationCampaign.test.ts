import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { detectIsolationCapabilities, runIsolatedCommand, toolchainReadOnlyPaths, type IsolationExecutionEvidenceV1 } from "../../src/security/isolation.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "isolation-campaign" },
  evidence: { outputDir: ".harness/evidence" },
  security: { isolation: { required: true } }
};
const contract: TaskContract = { version: 1, task: { id: "ISO-1", title: "isolation campaign" } };
const roots: string[] = [];

function isEqualOrAncestor(candidate: string, target: string): boolean {
  const relative = path.relative(path.resolve(candidate), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isEqualOrAncestor(left, right) || isEqualOrAncestor(right, left);
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-isolation-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "isolation-fixture", version: "1.0.0" }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.sequential("real rootless isolation campaign", () => {
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
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const restoreHome = () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    };
    const restorePath = () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    };
    let hostHome: string | undefined;
    let hostSentinel: string | undefined;
    try {
      // Keep the probe outside /tmp and the isolated workspace: bwrap overlays
      // /tmp, so a fixture there would make a hidden-home check vacuous.
      hostHome = await fs.mkdtemp(path.join(path.resolve(process.cwd()), ".aeh-isolation-host-home-"));
      process.env.HOME = hostHome;
      const syntheticHome = os.homedir();
      const sshDirectory = path.join(syntheticHome, ".ssh");
      await fs.mkdir(sshDirectory, { recursive: true });
      const sentinelPath = path.join(syntheticHome, `.aeh-s10-host-sentinel-${process.pid}`);
      hostSentinel = sentinelPath;
      await fs.writeFile(sentinelPath, "host-only\n");
      expect(pathsOverlap(os.tmpdir(), syntheticHome)).toBe(false);
      expect(pathsOverlap("/var/tmp", syntheticHome)).toBe(false);
      expect(pathsOverlap(workspace, syntheticHome)).toBe(false);
      await expect(fs.access(sshDirectory)).resolves.toBeUndefined();
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("host-only\n");

      const repositoryNodeBin = path.resolve(process.cwd(), "node_modules", ".bin");
      const requiredToolchainPaths = [...new Set([path.dirname(process.execPath), repositoryNodeBin])].sort();
      const capabilities = await detectIsolationCapabilities(root);
      if (!capabilities.available) throw new Error(`ISOLATION_PROVIDER_UNAVAILABLE: ${capabilities.details.join("; ")}`);
      // The fixture's invocation needs only Node and this repository's local
      // executable links. System commands remain available through /usr.
      process.env.PATH = requiredToolchainPaths.join(path.delimiter);
      const toolchainPaths = toolchainReadOnlyPaths(root);
      expect(toolchainPaths).toEqual(requiredToolchainPaths);
      expect(toolchainPaths.filter((entry) => pathsOverlap(entry, syntheticHome))).toEqual([]);
      const script = [
        `echo "uid=$(id -u)"`,
        `echo "ifaces=$(ip -o link show 2>/dev/null | wc -l)"`,
        `echo "host_pid=$(test -d /proc/${hostMarker.pid} && echo visible || echo masked)"`,
        `echo "host_secret=$(test -n "$${secretName}" && echo visible || echo masked)"`,
        `echo "host_ssh=$(test -e ${sshDirectory} && echo visible || echo masked)"`,
        `echo "host_home_sentinel=$(test -e ${sentinelPath} && echo visible || echo masked)"`,
        `echo "etc_write=$( (echo x > /etc/aeh-s10-probe) 2>/dev/null && echo allowed || echo denied)"`,
        `echo "home_probe=$( (echo x > ${syntheticHome}/aeh-s10-escape.txt) 2>/dev/null && echo allowed || echo denied)"`,
        `echo "ephemeral_sibling=$( (echo x > ${root}/sibling.txt) 2>/dev/null && echo written || echo failed)"`,
        `echo "workspace_write=$( (echo ok > ${workspace}/written.txt) 2>/dev/null && echo allowed || echo denied)"`,
        `grep -E "^(CapEff|NoNewPrivs):" /proc/self/status`,
        `node -e 'const s=require("net").connect(80,"1.1.1.1");s.setTimeout(1500);s.on("connect",()=>{console.log("network=connected");process.exit(0)});s.on("error",e=>{console.log("network=denied:"+e.code);process.exit(0)});s.on("timeout",()=>{console.log("network=timeout");process.exit(0)})'`
      ].join("\n");
      const result = await runIsolatedCommand({ root, command: script, cwd: workspace, workspaceRoot: workspace, writablePaths: [workspace], environment: { PATH: originalPath ?? "/usr/local/bin:/usr/bin:/bin" }, timeoutMs: 60_000 }, { capabilities });
      expect(result.isolation.visibleReadOnlyPaths).toContain(path.dirname(process.execPath));
      expect(result.isolation.visibleReadOnlyPaths).toContain(repositoryNodeBin);
      expect(result.isolation.visibleReadOnlyPaths.filter((entry) => pathsOverlap(entry, syntheticHome))).toEqual([]);
      expect(result.exitCode, result.exitCode === 0 ? undefined : JSON.stringify({ root, workspace, provider: capabilities, isolatedResult: result }, null, 2)).toBe(0);
      expect(result.stdout).toContain(`uid=${process.getuid!()}`);
      expect(result.stdout).toContain("ifaces=1");
      expect(result.stdout).toContain("host_pid=masked");
      expect(result.stdout).toContain("host_secret=masked");
      expect(result.stdout).toContain("host_ssh=masked");
      expect(result.stdout).toContain("host_home_sentinel=masked");
      expect(result.stdout).toContain("etc_write=denied");
      expect(result.stdout).toContain("home_probe=denied");
      expect(result.stdout).toContain("workspace_write=allowed");
      expect(result.stdout).toMatch(/NoNewPrivs:\s*1/);
      expect(result.stdout).toMatch(/CapEff:\s*0{16}/);
      expect(result.stdout).toMatch(/network=denied(:\w+)?/);
      await expect(fs.access(path.join(workspace, "written.txt"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, "sibling.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(syntheticHome, "aeh-s10-escape.txt"))).rejects.toThrow();
      await expect(fs.access(sshDirectory)).resolves.toBeUndefined();
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("host-only\n");
      expect(result.isolation.namespaces).toMatchObject({ user: true, mount: true, pid: true, uts: true, ipc: true, network: false });
      expect(result.isolation.networkAccess).toBe("none");
      expect(result.isolation.rootless).toBe(true);
    } finally {
      restoreHome();
      restorePath();
      hostMarker.kill("SIGKILL");
      delete process.env[secretName];
      if (hostSentinel) await fs.rm(hostSentinel, { force: true });
      if (hostHome) await fs.rm(hostHome, { recursive: true, force: true });
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
    let failureContext: string | undefined;
    if (check.status !== "PASS") {
      const rawArtifact = typeof check.details?.rawArtifact === "string" ? path.resolve(root, check.details.rawArtifact) : undefined;
      const rawOutput = rawArtifact ? await fs.readFile(rawArtifact, "utf8").catch((error) => `unreadable: ${String(error)}`) : undefined;
      failureContext = JSON.stringify({ root, command: "node probe.mjs", provider: await detectIsolationCapabilities(root), check, rawArtifact, rawOutput }, null, 2);
    }
    expect(check.status, failureContext).toBe("PASS");
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
