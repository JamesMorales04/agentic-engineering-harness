import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV,
  HERMITIC_SYSTEM_PATH_DIRS,
  MANAGED_CHILD_ENV_SCRUB_KEYS,
  MANAGED_CHILD_ENV_SCRUB_PREFIXES,
  MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS,
  buildHermeticChildPath,
  controllerStartupExtraBinPaths,
  explicitExtraBinPaths,
  normalizeControllerExtraBinPaths,
  managedChildEnvScrubEvidence,
  resolveControllerExtraBinPaths,
  resolveExecutable,
  runExecutable,
  sanitizeManagedChildEnvironment,
} from "../src/utils/process.js";
import { sanitizeFixtureChildEnvironment } from "./browser/fixture/controlCenterJourney.js";

/**
 * C6 regression: ONE canonical scrub shared by fixture + runChild,
 * with pinned SDK/entry resolution evidence. Fail-closed.
 *
 * MECHANISM: DETERMINISTIC (env scrub + hermetic PATH + pinned state/diagnostics,
 * no model). MISE_* and ASDF_* prefixes plus XDG shim keys scrubbed (mise docs
 * enumeration in src/utils/process.ts); PATH hermetic (prefix + minimal, no
 * ambient tail); decoy host shims never selected.
 */
describe("canonical managed child env scrub (C6)", () => {
  it("shares ONE canonical scrub (keys + prefixes + XDG) between prod and fixture", async () => {
    const fixtureModule = await import("./browser/fixture/controlCenterJourney.js");
    const fixtureKeys = (fixtureModule as unknown as { FIXTURE_MANAGED_ENVELOPE_KEYS: readonly string[] }).FIXTURE_MANAGED_ENVELOPE_KEYS;
    expect([...fixtureKeys].sort()).toEqual([...MANAGED_CHILD_ENV_SCRUB_KEYS].sort());
    const fixturePrefixes = (fixtureModule as unknown as { FIXTURE_MANAGED_ENVELOPE_PREFIXES: readonly string[] }).FIXTURE_MANAGED_ENVELOPE_PREFIXES;
    expect([...fixturePrefixes].sort()).toEqual([...MANAGED_CHILD_ENV_SCRUB_PREFIXES].sort());
    const fixtureXdg = (fixtureModule as unknown as { FIXTURE_MANAGED_ENVELOPE_XDG_KEYS: readonly string[] }).FIXTURE_MANAGED_ENVELOPE_XDG_KEYS;
    expect([...fixtureXdg].sort()).toEqual([...MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS].sort());
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_SELF_REEXEC");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_CONTROLLER_EPOCH");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_CONTROLLER_TOKEN");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_DETERMINISTIC_PASEO");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_DETERMINISTIC_PASEO_RUNTIME");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_EXECUTION_BINDING");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_CANDIDATE_DIGEST");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_CAPABILITY_LEASES");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_SCRATCH_RESOURCE");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_SCRATCH_DIGEST");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("AEH_PARTICIPANT_ID");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("PASEO_AGENT_ID");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain("NODE_PATH");
    expect(MANAGED_CHILD_ENV_SCRUB_KEYS).toContain(AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV);
    expect(MANAGED_CHILD_ENV_SCRUB_PREFIXES).toContain("MISE_");
    expect(MANAGED_CHILD_ENV_SCRUB_PREFIXES).toContain("ASDF_");
    expect(MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS).toContain("XDG_DATA_HOME");
  });

  it("strips the canonical envelope + MISE_* and related shim vars in both sanitizers (fail-closed)", () => {
    const parent: NodeJS.ProcessEnv = {};
    for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) parent[key] = "leak-test";
    parent["MISE_DATA_DIR"] = "/tmp/evil-mise";
    parent["MISE_SHIMS_DIR"] = "/tmp/evil-shims";
    parent["MISE_TOOL_NODE_VERSION"] = "evil";
    parent["MISE_PIPX_UVX"] = "true";
    parent["ASDF_DATA_DIR"] = "/tmp/evil-asdf";
    parent["XDG_DATA_HOME"] = "/tmp/evil-xdg";
    parent["XDG_CONFIG_HOME"] = "/tmp/evil-xdg-config";
    parent.PATH = "/tmp/decoy:/usr/bin";
    const prod = sanitizeManagedChildEnvironment(parent);
    const fixture = sanitizeFixtureChildEnvironment(parent, []);
    for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) {
      expect(prod[key], `prod leaked ${key}`).toBeUndefined();
      expect(fixture[key], `fixture leaked ${key}`).toBeUndefined();
    }
    for (const key of ["MISE_DATA_DIR", "MISE_SHIMS_DIR", "MISE_TOOL_NODE_VERSION", "MISE_PIPX_UVX", "ASDF_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
      expect(prod[key], `prod leaked shim var ${key}`).toBeUndefined();
      expect(fixture[key], `fixture leaked shim var ${key}`).toBeUndefined();
    }
    // Prod sync sanitize preserves PATH (hermetic applied async in runChild);
    // fixture is hermetic minimal sync (no ambient tail, fail-closed) when
    // controller extra is empty. Parent EXTRA absolute decoy is scrubbed and
    // never flows into fixture PATH.
    expect(prod.PATH).toBe("/tmp/decoy:/usr/bin");
    expect(fixture.PATH).not.toContain("/tmp/decoy");
    expect(fixture.PATH).toBe([...HERMITIC_SYSTEM_PATH_DIRS].join(path.delimiter));
    const withDecoyParent = sanitizeFixtureChildEnvironment(
      { ...parent, [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: "/tmp/evil-decoy" },
      [],
    );
    expect(withDecoyParent[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]).toBeUndefined();
    expect(withDecoyParent.PATH).not.toContain("/tmp/evil-decoy");
  });

  it("does not leak the canonical envelope into real runChild processes", async () => {
    const names = [...MANAGED_CHILD_ENV_SCRUB_KEYS];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = "ambient-identity";
    try {
      const result = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.filter((n)=>process.env[n]!==undefined)))`],
        { cwd: process.cwd(), timeoutMs: 2_000, toolchain: false }
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout || "[]")).toEqual([]);
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it("scrubs MISE_* and related shim vars from real children (managed toolchain:true fail-closed, toolchain:false scrubs ambient only)", async () => {
    const ambientKeys = ["MISE_DATA_DIR", "MISE_SHIMS_DIR", "MISE_TOOL_NODE_VERSION", "ASDF_DATA_DIR", "XDG_DATA_HOME"];
    const saved = Object.fromEntries(ambientKeys.map((k) => [k, process.env[k]]));
    for (const k of ambientKeys) process.env[k] = "/tmp/evil-ambient";
    try {
      // toolchain:true (managed, default): even explicit options.env MISE_* are removed.
      const managed = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(ambientKeys)}.filter((n)=>process.env[n]!==undefined)))`],
        { cwd: process.cwd(), timeoutMs: 2_000, env: { MISE_DATA_DIR: "/tmp/evil-explicit", MISE_PIPX_UVX: "true" } }
      );
      expect(managed.exitCode).toBe(0);
      expect(JSON.parse(managed.stdout || "[]")).toEqual([]);
      // toolchain:false (mise internal): ambient scrubbed, explicit re-allowed for MISE_PIPX_UVX pattern.
      const internal = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(JSON.stringify({MISE_DATA_DIR: process.env.MISE_DATA_DIR, MISE_PIPX_UVX: process.env.MISE_PIPX_UVX}))`],
        { cwd: process.cwd(), timeoutMs: 2_000, toolchain: false, env: { MISE_PIPX_UVX: "false" } }
      );
      expect(internal.exitCode).toBe(0);
      const seen = JSON.parse(internal.stdout || "{}") as Record<string, string | undefined>;
      expect(seen.MISE_DATA_DIR).toBeUndefined();
      expect(seen.MISE_PIPX_UVX).toBe("false");
    } finally {
      for (const k of ambientKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("makes PATH hermetic (pinned prefix + minimal system dirs, no ambient tail)", () => {
    expect(buildHermeticChildPath(undefined)).toBe([...HERMITIC_SYSTEM_PATH_DIRS].join(path.delimiter));
    expect(buildHermeticChildPath("/pinned/a:/pinned/b")).toBe(["/pinned/a:/pinned/b", ...HERMITIC_SYSTEM_PATH_DIRS].join(path.delimiter));
    expect(buildHermeticChildPath("/pinned")).not.toContain("/tmp/decoy");
  });

  it("no-prefix state fails visibly with no ambient resolution; pinned state restores it (RED: ambient stub resolved before)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-hermetic-"));
    // Ambient-only tools: a host-style dir (~/.local/bin shape, no `shims`
    // segment so the old filtered-ambient fallback kept it) and a test stub.
    const ambientDir = path.join(tmp, "ambient-tools");
    await fs.mkdir(ambientDir, { recursive: true });
    await fs.writeFile(path.join(ambientDir, "aeh-ambient-tool"), "#!/bin/sh\necho ambient\n");
    await fs.chmod(path.join(ambientDir, "aeh-ambient-tool"), 0o755);
    // Same-name shadow: ambient comes first in PATH to prove the pinned prefix
    // wins even when ambient would shadow by order.
    await fs.writeFile(path.join(ambientDir, "aeh-stub-tool"), "#!/bin/sh\necho ambient-shadow\n");
    await fs.chmod(path.join(ambientDir, "aeh-stub-tool"), 0o755);
    const stubDir = path.join(tmp, "aeh-stub-xyz");
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, "aeh-stub-tool"), "#!/bin/sh\necho stub\n");
    await fs.chmod(path.join(stubDir, "aeh-stub-tool"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${ambientDir}${path.delimiter}${stubDir}${path.delimiter}${savedPath ?? ""}`;
    const { clearToolchainEnvCache } = await import("../src/utils/process.js");
    try {
      clearToolchainEnvCache();
      // No toolchain.state.json under tmp: ambient-only tools do NOT resolve
      // (no silent ambient fallback, not even filtered).
      expect(await resolveExecutable("aeh-ambient-tool", tmp), "ambient-only tool must not resolve without pinned state").toBeUndefined();
      expect(await resolveExecutable("aeh-stub-tool", tmp), "ambient stub must not resolve without pinned state").toBeUndefined();
      // Managed child PATH is hermetic minimal only: no ambient dirs at all.
      const probe = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(process.env.PATH ?? "")`],
        { cwd: tmp, timeoutMs: 2_000 }
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout).toBe(buildHermeticChildPath(undefined));
      const dirs = probe.stdout.split(path.delimiter);
      expect(dirs).not.toContain(ambientDir);
      expect(dirs).not.toContain(stubDir);
      // Direct spawn of an ambient-only tool fails VISIBLY with the setup
      // direction instead of silently succeeding via ambient.
      await expect(runExecutable("aeh-stub-tool", [], { cwd: tmp, timeoutMs: 2_000 }), "missing pinned state must fail visibly").rejects.toThrow(/AEH_TOOLCHAIN_NOT_CONFIGURED.*aeh setup/);
      // Migration: pin the stub dir via `aeh setup` state, then retry (GREEN).
      // Stale state migrates the same way: re-run setup, then retry.
      await fs.mkdir(path.join(tmp, ".harness"), { recursive: true });
      await fs.writeFile(path.join(tmp, ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, binPaths: [stubDir] }));
      clearToolchainEnvCache();
      expect(await resolveExecutable("aeh-stub-tool", tmp), "pinned stub must resolve after setup").toBe(path.join(stubDir, "aeh-stub-tool"));
      expect(await resolveExecutable("aeh-ambient-tool", tmp), "unpinned ambient dir stays unresolved after setup").toBeUndefined();
      const runPinned = await runExecutable("aeh-stub-tool", [], { cwd: tmp, timeoutMs: 2_000 });
      expect(runPinned.exitCode).toBe(0);
      expect(runPinned.stdout, "pinned prefix must win over the ambient shadow").toBe("stub\n");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      clearToolchainEnvCache();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("pins SDK/entry resolution evidence in both (toolchain state + SDK diagnostics + candidate identity, entry explicit)", () => {
    const evidence = managedChildEnvScrubEvidence({ AEH_ENTRY_FILE: "/tmp/entry", AEH_OPERATION_ID: "op", MISE_DATA_DIR: "/tmp/evil", XDG_DATA_HOME: "/tmp/evil-xdg" });
    expect(evidence.removed).toContain("AEH_ENTRY_FILE");
    expect(evidence.removed).toContain("MISE_DATA_DIR");
    expect(evidence.removed).toContain("XDG_DATA_HOME");
    expect(evidence.pinned.toolchainState).toContain("toolchain.state.json");
    expect(evidence.pinned.sdkDiagnostics).toContain("resolvePaseoSdkFromCli");
    expect(evidence.pinned.candidateIdentity).toContain("build-identity.json");
    expect(evidence.pinned.entryExplicit).toContain("argv");
  });

  it("controller-input-only extra bins: model env decoy blocked, controller options resolves, three CI jobs simulated", async () => {
    // Controller-input-only trust: outer trusted env -> controller startup ->
    // options (never per-turn env). No .harness/toolchain.state.json (no-state).
    // MECHANISM: DETERMINISTIC (scrubbed per-turn env + explicit options/snapshot).
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ci-mise-"));
    const miseBins = path.join(tmp, "mise-bins");
    const localBin = path.join(tmp, "local-bin");
    const npmBin = path.join(tmp, "npm-bin");
    const cosignBin = path.join(tmp, "cosign-bin");
    const decoyDir = path.join(tmp, "decoy-ambient");
    for (const dir of [miseBins, localBin, npmBin, cosignBin, decoyDir]) await fs.mkdir(dir, { recursive: true });
    const stub = async (dir: string, name: string, body: string): Promise<void> => {
      await fs.writeFile(path.join(dir, name), `#!/bin/sh\necho ${body}\n`);
      await fs.chmod(path.join(dir, name), 0o755);
    };
    await stub(miseBins, "aeh-ci-tool", "ci-pinned");
    await stub(localBin, "aeh-local-tool", "local-pinned");
    await stub(npmBin, "aeh-npm-tool", "npm-pinned");
    await stub(cosignBin, "aeh-cosign-tool", "cosign-pinned");
    await stub(decoyDir, "aeh-ci-tool", "decoy-shadow");
    await stub(decoyDir, "aeh-decoy-only", "decoy");
    const savedPath = process.env.PATH;
    const savedExtra = process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV];
    // Ambient order puts decoy first to prove controller input wins, not PATH order.
    process.env.PATH = `${decoyDir}${path.delimiter}${miseBins}${path.delimiter}${savedPath ?? ""}`;
    const { clearToolchainEnvCache } = await import("../src/utils/process.js");
    try {
      clearToolchainEnvCache();
      const none = { toolchainExtraBinPaths: [] as const };
      // Missing state + empty controller input: nothing resolves (fail-closed).
      expect(await resolveExecutable("aeh-ci-tool", tmp, none), "unmarked ambient must not resolve without state").toBeUndefined();
      expect(await resolveExecutable("aeh-decoy-only", tmp, none), "decoy must never resolve").toBeUndefined();
      // Trusted startup parser still works for controller startup (outer env once).
      expect(explicitExtraBinPaths({ [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: miseBins })).toEqual([miseBins]);
      expect(normalizeControllerExtraBinPaths(`${miseBins}${path.delimiter}relative-dir${path.delimiter}${miseBins}`)).toEqual([miseBins]);
      // Model-influenced env: options.env EXTRA decoy must NOT resolve, even with
      // live process.env mutation (frozen startup snapshot ignores per-turn env).
      process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV] = decoyDir;
      clearToolchainEnvCache();
      expect(await resolveExecutable("aeh-decoy-only", tmp, none), "live process.env decoy must be ignored").toBeUndefined();
      const decoyProbe = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(process.env.PATH ?? "")`],
        { cwd: tmp, timeoutMs: 2_000, toolchainExtraBinPaths: [], env: { [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: decoyDir } },
      );
      expect(decoyProbe.exitCode).toBe(0);
      expect(decoyProbe.stdout.split(path.delimiter)).not.toContain(decoyDir);
      const decoyRun = await runExecutable("aeh-decoy-only", [], {
        cwd: tmp, timeoutMs: 2_000, toolchainExtraBinPaths: [], env: { [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: decoyDir },
      }).then(
        () => { throw new Error("model-influenced decoy must not resolve"); },
        (error: unknown) => error,
      );
      expect(String((decoyRun as Error)?.message ?? decoyRun)).toMatch(/AEH_TOOLCHAIN_NOT_CONFIGURED|ENOENT/);
      // Controller-supplied options path resolves correctly (decoy shadow loses).
      const trustedFullStack = resolveControllerExtraBinPaths({
        [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: [localBin, miseBins, npmBin].join(path.delimiter),
      });
      expect(trustedFullStack).toEqual([localBin, miseBins, npmBin]);
      const fullStackOpt = { toolchainExtraBinPaths: trustedFullStack };
      expect(await resolveExecutable("aeh-ci-tool", tmp, fullStackOpt), "controller mise tool must resolve").toBe(path.join(miseBins, "aeh-ci-tool"));
      expect(await resolveExecutable("aeh-local-tool", tmp, fullStackOpt), "controller local tool must resolve").toBe(path.join(localBin, "aeh-local-tool"));
      expect(await resolveExecutable("aeh-npm-tool", tmp, fullStackOpt), "controller npm tool must resolve").toBe(path.join(npmBin, "aeh-npm-tool"));
      expect(await resolveExecutable("aeh-decoy-only", tmp, fullStackOpt), "unmarked decoy stays unresolved").toBeUndefined();
      // Controller options wins even when per-turn env carries a decoy shadow.
      const shadowOpt = {
        toolchainExtraBinPaths: trustedFullStack,
        env: { [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: decoyDir },
      };
      const run = await runExecutable("aeh-ci-tool", [], { cwd: tmp, timeoutMs: 2_000, ...shadowOpt });
      expect(run.exitCode).toBe(0);
      expect(run.stdout, "controller input must win over per-turn decoy shadow").toBe("ci-pinned\n");
      // Three CI jobs simulated via outer trusted env -> controller -> options.
      const jobs: Array<{ name: string; trusted: string; tools: Array<[string, string]> }> = [
        { name: "full-stack-contract", trusted: [localBin, miseBins, npmBin].join(path.delimiter), tools: [["aeh-ci-tool", miseBins], ["aeh-local-tool", localBin], ["aeh-npm-tool", npmBin]] },
        { name: "provider-contracts", trusted: [localBin, miseBins, npmBin].join(path.delimiter), tools: [["aeh-ci-tool", miseBins], ["aeh-local-tool", localBin], ["aeh-npm-tool", npmBin]] },
        { name: "supply-chain", trusted: [localBin, miseBins, cosignBin].join(path.delimiter), tools: [["aeh-ci-tool", miseBins], ["aeh-local-tool", localBin], ["aeh-cosign-tool", cosignBin]] },
      ];
      for (const job of jobs) {
        const controllerInput = resolveControllerExtraBinPaths({ [AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV]: job.trusted });
        const opt = { toolchainExtraBinPaths: controllerInput };
        for (const [tool, dir] of job.tools) {
          expect(await resolveExecutable(tool, tmp, opt), `${job.name}: ${tool} must resolve`).toBe(path.join(dir, tool));
        }
        expect(await resolveExecutable("aeh-decoy-only", tmp, opt), `${job.name}: decoy stays blocked`).toBeUndefined();
      }
      // Frozen startup snapshot exists and never equals live per-turn mutation.
      expect(controllerStartupExtraBinPaths()).not.toContain(decoyDir);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedExtra === undefined) delete process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV];
      else process.env[AEH_TOOLCHAIN_EXTRA_BIN_PATHS_ENV] = savedExtra;
      clearToolchainEnvCache();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
