import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST,
  ISOLATION_ENVIRONMENT_REJECTED,
  ISOLATION_PROVIDER_UNAVAILABLE,
  ISOLATION_PROVIDER_UNSUPPORTED,
  IsolationProviderUnavailableError,
  assertSupportedIsolationProvider,
  buildBwrapArgs,
  clearIsolationCapabilityCache,
  detectIsolationCapabilities,
  isolationEnvironment,
  runIsolatedCommand,
  validatorIsolationRequired,
  type IsolationCapabilitiesV1,
  type IsolatedCommandRequestV1
} from "../../src/security/isolation.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";

const root = process.cwd();

function capabilities(overrides: Partial<IsolationCapabilitiesV1> = {}): IsolationCapabilitiesV1 {
  return {
    version: 1,
    provider: "bwrap",
    available: true,
    executable: "/usr/bin/bwrap",
    providerVersion: "0.13.0",
    rootless: true,
    userNamespaces: true,
    networkNamespace: true,
    seccompKernel: true,
    apparmor: "absent",
    podman: { available: false, rootless: null },
    buildah: { available: false },
    details: [],
    ...overrides
  };
}

function request(overrides: Partial<IsolatedCommandRequestV1> = {}): IsolatedCommandRequestV1 {
  return { root, command: "echo ok", cwd: root, workspaceRoot: root, ...overrides };
}

describe.sequential("rootless isolation provider contract", () => {
  it("fails closed with an explicit provider-unavailable blocker instead of skipping", async () => {
    await expect(runIsolatedCommand(request(), { capabilities: capabilities({ available: false, executable: undefined }) }))
      .rejects.toMatchObject({ code: ISOLATION_PROVIDER_UNAVAILABLE });
    expect(new IsolationProviderUnavailableError("missing bwrap").message).toContain(ISOLATION_PROVIDER_UNAVAILABLE);
  });

  it("builds user/mount/pid/uts/ipc/network namespace arguments with the host root read-only", () => {
    const built = buildBwrapArgs(request(), capabilities());
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-net"]) expect(built.args).toContain(flag);
    expect(built.args).toContain("--die-with-parent");
    expect(built.args).toContain("--new-session");
    expect(built.args).toContain("--clearenv");
    const workspaceIndex = built.args.findIndex((entry, index) => entry === "--ro-bind" && built.args[index + 1] === root && built.args[index + 2] === root);
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(built.evidence.readOnlyRoot).toBe(true);
    expect(built.evidence.networkAccess).toBe("none");
    expect(built.evidence.namespaces.network).toBe(false);
    expect(built.evidence.maskedHostPaths.length).toBeGreaterThan(0);
    expect(built.evidence.seccomp).toBe("not-applied");
  });

  it("allows the host network only when explicitly requested", () => {
    const built = buildBwrapArgs(request({ network: true }), capabilities());
    expect(built.args).not.toContain("--unshare-net");
    expect(built.evidence.networkAccess).toBe("host");
    expect(built.evidence.namespaces.network).toBe(true);
  });

  it("binds only the declared writable paths and keeps everything else read-only", () => {
    const writable = path.join(root, ".harness");
    const built = buildBwrapArgs(request({ writablePaths: [writable] }), capabilities());
    const bindIndex = built.args.findIndex((entry, index) => entry === "--bind" && built.args[index + 1] === writable && built.args[index + 2] === writable);
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(built.evidence.writablePaths).toEqual([path.resolve(writable)]);
    const readOnlyIndex = built.args.findIndex((entry, index) => entry === "--ro-bind" && built.args[index + 1] === root && built.args[index + 2] === root);
    expect(readOnlyIndex).toBeGreaterThanOrEqual(0);
  });

  it("rejects environment variables outside the isolation allowlist", () => {
    expect(() => buildBwrapArgs(request({ environment: { AWS_SECRET_ACCESS_KEY: "leak" } }), capabilities()))
      .toThrow(ISOLATION_ENVIRONMENT_REJECTED);
  });

  it("clears host HOME and TMPDIR inside the sandbox environment", () => {
    const environment = isolationEnvironment(request(), DEFAULT_ISOLATION_ENVIRONMENT_ALLOWLIST);
    expect(environment.HOME).toBe("/tmp");
    expect(environment.TMPDIR).toBe("/tmp");
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("rejects ambiguous command forms", () => {
    expect(() => buildBwrapArgs(request({ argv: ["/bin/true"] }), capabilities())).toThrow(/ISOLATION_COMMAND_INVALID/);
  });

  it("fails explicitly for unsupported configured providers", () => {
    const config = { version: 1, project: { name: "x" }, security: { isolation: { required: true, provider: "docker" } } } as HarnessProjectConfig;
    expect(() => assertSupportedIsolationProvider(config)).toThrow(ISOLATION_PROVIDER_UNSUPPORTED);
  });

  it("derives required isolation from policy or the validator spec", () => {
    const config = { version: 1, project: { name: "x" }, security: { isolation: { required: true } } } as HarnessProjectConfig;
    expect(validatorIsolationRequired(config)).toBe(true);
    expect(validatorIsolationRequired({ version: 1, project: { name: "x" } } as HarnessProjectConfig, { id: "v", adapter: "command", options: { isolate: true } })).toBe(true);
    expect(validatorIsolationRequired({ version: 1, project: { name: "x" } } as HarnessProjectConfig)).toBe(false);
  });

  it("ignores ambient PATH manipulation when detecting providers (hermetic minimal applies)", async () => {
    // Hermetic migration: managed resolution is pinned-prefix + minimal system
    // dirs, never ambient. Emptying or stuffing ambient PATH must not change
    // detection: a fake ambient `bwrap` is never selected, and an emptied PATH
    // does not hide the hermetic minimal providers. The old "isolated search
    // path via PATH override" technique is superseded by design; stale state
    // migrates via `aeh setup`, never via ambient.
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-isolation-provider-contract-"));
    const emptyPath = path.join(isolatedRoot, "empty-bin");
    await fs.mkdir(emptyPath);
    const decoyDir = path.join(isolatedRoot, "decoy-bin");
    await fs.mkdir(decoyDir);
    await fs.writeFile(path.join(decoyDir, "bwrap"), "#!/bin/sh\necho decoy-bwrap\n", { mode: 0o755 });
    await fs.chmod(path.join(decoyDir, "bwrap"), 0o755);
    const originalPath = process.env.PATH;
    try {
      clearIsolationCapabilityCache();
      const baseline = await detectIsolationCapabilities(isolatedRoot);
      process.env.PATH = emptyPath;
      clearIsolationCapabilityCache();
      const emptied = await detectIsolationCapabilities(isolatedRoot);
      expect(emptied, "emptied ambient PATH must not change managed detection").toEqual(baseline);
      process.env.PATH = `${decoyDir}${path.delimiter}${originalPath ?? ""}`;
      clearIsolationCapabilityCache();
      const withDecoy = await detectIsolationCapabilities(isolatedRoot);
      expect(withDecoy, "ambient decoy provider must never be selected").toEqual(baseline);
      expect(withDecoy.executable ?? "", "resolved provider must never come from the ambient decoy dir").not.toContain(decoyDir);
      // Hermetic shape: a real minimal-path provider or an explicit missing
      // report, identical regardless of ambient PATH.
      expect(baseline.version).toBe(1);
      expect(["bwrap", "none"]).toContain(baseline.provider);
      expect(baseline.available).toBe(baseline.provider === "bwrap");
      expect(baseline.details.length).toBeGreaterThan(0);
      expect(baseline.details.join("\n")).toMatch(/bwrap: /);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      clearIsolationCapabilityCache();
      await fs.rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
