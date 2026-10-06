import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HERMITIC_SYSTEM_PATH_DIRS,
  MANAGED_CHILD_ENV_SCRUB_KEYS,
  MANAGED_CHILD_ENV_SCRUB_PREFIXES,
  MANAGED_CHILD_ENV_SCRUB_XDG_SHIM_KEYS,
  buildHermeticChildPath,
  managedChildEnvScrubEvidence,
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
    const fixture = sanitizeFixtureChildEnvironment(parent);
    for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) {
      expect(prod[key], `prod leaked ${key}`).toBeUndefined();
      expect(fixture[key], `fixture leaked ${key}`).toBeUndefined();
    }
    for (const key of ["MISE_DATA_DIR", "MISE_SHIMS_DIR", "MISE_TOOL_NODE_VERSION", "MISE_PIPX_UVX", "ASDF_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
      expect(prod[key], `prod leaked shim var ${key}`).toBeUndefined();
      expect(fixture[key], `fixture leaked shim var ${key}`).toBeUndefined();
    }
    // Prod sync sanitize preserves PATH (hermetic applied async in runChild);
    // fixture is hermetic minimal sync (no ambient tail, fail-closed).
    expect(prod.PATH).toBe("/tmp/decoy:/usr/bin");
    expect(fixture.PATH).not.toContain("/tmp/decoy");
    expect(fixture.PATH).toBe([...HERMITIC_SYSTEM_PATH_DIRS].join(path.delimiter));
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

  it("never selects a decoy host shim earlier in ambient PATH (RED decoy selected before, not after)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-shim-"));
    // Host-shim farm simulation (mise shims dir shape: contains a `shims` segment).
    const decoyShimsDir = path.join(tmp, "host-shims");
    await fs.mkdir(decoyShimsDir, { recursive: true });
    await fs.writeFile(path.join(decoyShimsDir, "aeh-decoy-tool"), "#!/bin/sh\necho decoy\n");
    await fs.chmod(path.join(decoyShimsDir, "aeh-decoy-tool"), 0o755);
    // Legitimate test stub (isolated temp, no `shims` segment) must be preserved
    // when prefix is missing, so existing validator stubbing keeps working.
    const stubDir = path.join(tmp, "aeh-stub-xyz");
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, "aeh-stub-tool"), "#!/bin/sh\necho stub\n");
    await fs.chmod(path.join(stubDir, "aeh-stub-tool"), 0o755);
    const savedPath = process.env.PATH;
    // Decoy shims earlier in ambient PATH (simulates host shims shadowing).
    process.env.PATH = `${decoyShimsDir}${path.delimiter}${stubDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      // Prefix undefined in isolated tmp (no toolchain.state): shim farms stripped,
      // non-shims stubs preserved. Decoy must NOT resolve; stub must resolve.
      const resolvedDecoy = await resolveExecutable("aeh-decoy-tool", tmp);
      expect(resolvedDecoy, "host shim farm must never be selected").toBeUndefined();
      const resolvedStub = await resolveExecutable("aeh-stub-tool", tmp);
      expect(resolvedStub, "legitimate non-shims stub must still resolve when prefix is missing").toBe(path.join(stubDir, "aeh-stub-tool"));
      // Real child with managed toolchain (default, prefix missing): decoy shims
      // stripped, stub preserved, isolated empty stays empty (no minimal injection
      // when prefix is missing, to respect isolated PATH and existing stubs).
      const probe = await runExecutable(
        process.execPath,
        ["-e", `process.stdout.write(process.env.PATH ?? "")`],
        { cwd: tmp, timeoutMs: 2_000 }
      );
      expect(probe.exitCode).toBe(0);
      const dirs = probe.stdout.split(path.delimiter);
      expect(dirs).not.toContain(decoyShimsDir);
      expect(dirs).toContain(stubDir);

      // Pinned prefix wins over ambient decoy (even non-shims) when state exists.
      const pinnedDir = path.join(tmp, "pinned");
      await fs.mkdir(pinnedDir, { recursive: true });
      await fs.writeFile(path.join(pinnedDir, "aeh-pinned-tool"), "#!/bin/sh\necho pinned\n");
      await fs.chmod(path.join(pinnedDir, "aeh-pinned-tool"), 0o755);
      const ambientDecoyDir = path.join(tmp, "ambient-decoy");
      await fs.mkdir(ambientDecoyDir, { recursive: true });
      await fs.writeFile(path.join(ambientDecoyDir, "aeh-pinned-tool"), "#!/bin/sh\necho decoy\n");
      await fs.chmod(path.join(ambientDecoyDir, "aeh-pinned-tool"), 0o755);
      await fs.mkdir(path.join(tmp, ".harness"), { recursive: true });
      await fs.writeFile(path.join(tmp, ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, binPaths: [pinnedDir] }));
      const { clearToolchainEnvCache } = await import("../src/utils/process.js");
      clearToolchainEnvCache();
      const savedPath2 = process.env.PATH;
      process.env.PATH = `${ambientDecoyDir}${path.delimiter}${savedPath2 ?? ""}`;
      try {
        const resolvedPinned = await resolveExecutable("aeh-pinned-tool", tmp);
        expect(resolvedPinned, "pinned prefix must win over ambient decoy").toBe(path.join(pinnedDir, "aeh-pinned-tool"));
      } finally {
        if (savedPath2 === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath2;
        clearToolchainEnvCache();
      }
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
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
});
