import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExternalToolValidator } from "../../src/validators/external.js";
import { extractReporterTestsFromExecutionV1 } from "../../src/validation/testAttribution.js";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import type { ProcessOptions } from "../../src/utils/process.js";

/**
 * State-derived explicit marking (MECHANISM: DETERMINISTIC): validator
 * commands resolve the validation root's pinned prefix explicitly, so
 * nested toolchains (npm -> test runners -> fixture validators in tmpdir
 * roots without state) find the same pinned tools even when ambient
 * markings are scrubbed and the controller snapshot is empty. The fake
 * tool name is unique to the fixture state: resolution proves the state
 * path, never ambient PATH.
 */

const seenExplicitBins: unknown[] = [];

vi.mock("../../src/utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/process.js")>();
  return {
    ...actual,
    runShell: async (command: string, options: ProcessOptions) => {
      seenExplicitBins.push(options?.toolchainExtraBinPaths);
      return actual.runShell(command, options);
    }
  };
});

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "state-pinned-resolution" },
  evidence: { outputDir: ".harness/evidence" },
};
const contract: TaskContract = { version: 1, task: { id: "STATEPIN", title: "state pinned resolution" } };
const roots: string[] = [];

afterEach(async () => {
  seenExplicitBins.splice(0);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function mkroot(withState: boolean): Promise<{ root: string; binDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-statepin-"));
  roots.push(root);
  const binDir = path.join(root, "fake-tools");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    path.join(binDir, "aeh-fixture-reporter"),
    `#!/bin/sh\nprintf '%s' '{"suites":[{"title":"s","specs":[{"title":"alpha passing","tests":[{"results":[{"status":"passed"}]}]}]}]}'\n`,
    { mode: 0o755 }
  );
  if (withState) {
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.state.json"),
      JSON.stringify({ version: 1, binPaths: [binDir] }),
      "utf8"
    );
  }
  return { root, binDir };
}

describe("state-derived explicit tool marking for validator commands", () => {
  it("marks the validation root pinned bins explicitly and resolves a state-only tool", async () => {
    const { root, binDir } = await mkroot(true);
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-statepin",
        adapter: "playwright",
        command: "aeh-fixture-reporter",
        required: true,
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("PASS");
    expect(seenExplicitBins).toContainEqual([binDir]);
    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect(tests?.length).toBe(1);
  });

  it("fails closed when neither state nor ambient marking provides the tool", async () => {
    const { root } = await mkroot(false);
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-statepin-missing",
        adapter: "playwright",
        command: "aeh-fixture-reporter",
        required: true,
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("FAIL");
  });
});
