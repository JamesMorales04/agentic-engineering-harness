import { describe, expect, it } from "vitest";
import {
  MANAGED_CHILD_ENV_SCRUB_KEYS,
  managedChildEnvScrubEvidence,
  runExecutable,
  sanitizeManagedChildEnvironment,
} from "../src/utils/process.js";
import { sanitizeFixtureChildEnvironment } from "./browser/fixture/controlCenterJourney.js";

/**
 * C6 regression: ONE canonical scrub list shared by fixture + runChild,
 * with pinned SDK/entry resolution evidence. Fail-closed.
 *
 * MECHANISM: DETERMINISTIC (env scrub + pinned state/diagnostics, no model).
 */
describe("canonical managed child env scrub (C6)", () => {
  it("shares ONE canonical list between prod and fixture", async () => {
    const fixtureModule = await import("./browser/fixture/controlCenterJourney.js");
    const fixtureKeys = (fixtureModule as unknown as { FIXTURE_MANAGED_ENVELOPE_KEYS: readonly string[] }).FIXTURE_MANAGED_ENVELOPE_KEYS;
    expect([...fixtureKeys].sort()).toEqual([...MANAGED_CHILD_ENV_SCRUB_KEYS].sort());
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
  });

  it("strips the canonical envelope in both sanitizers (fail-closed)", () => {
    const parent: NodeJS.ProcessEnv = {};
    for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) parent[key] = "leak-test";
    parent.PATH = "/usr/bin";
    const prod = sanitizeManagedChildEnvironment(parent);
    const fixture = sanitizeFixtureChildEnvironment(parent);
    for (const key of MANAGED_CHILD_ENV_SCRUB_KEYS) {
      expect(prod[key], `prod leaked ${key}`).toBeUndefined();
      expect(fixture[key], `fixture leaked ${key}`).toBeUndefined();
    }
    expect(prod.PATH).toBe("/usr/bin");
    expect(fixture.PATH).toBe("/usr/bin");
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

  it("pins SDK/entry resolution evidence in both (toolchain state + SDK diagnostics + candidate identity, entry explicit)", () => {
    const evidence = managedChildEnvScrubEvidence({ AEH_ENTRY_FILE: "/tmp/entry", AEH_OPERATION_ID: "op" });
    expect(evidence.removed).toContain("AEH_ENTRY_FILE");
    expect(evidence.pinned.toolchainState).toContain("toolchain.state.json");
    expect(evidence.pinned.sdkDiagnostics).toContain("resolvePaseoSdkFromCli");
    expect(evidence.pinned.candidateIdentity).toContain("build-identity.json");
    expect(evidence.pinned.entryExplicit).toContain("argv");
  });
});
