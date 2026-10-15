import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSpecCommand } from "../../src/validators/toolCommand.js";
import { executePlan } from "../../src/providers/validation/providerUtils.js";
import { ProjectNativeTestExecutionProvider } from "../../src/providers/validation/testExecution.js";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import type { ProcessOptions } from "../../src/utils/process.js";
import type { ValidationContext } from "../../src/validators/types.js";

/**
 * Explicit state-derived marking across the remaining suite-capable
 * validator paths (MECHANISM: DETERMINISTIC): custom spec commands and
 * provider test/BDD plans must resolve the validation root's pinned
 * tools across the managed-child scrub boundary, like command/external
 * validators already do. Fake tooling is unique to fixture state:
 * resolution proves the state path, never ambient PATH.
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
  project: { name: "suite-marking" },
  evidence: { outputDir: ".harness/evidence" },
};
const contract: TaskContract = { version: 1, task: { id: "SUITEMARK", title: "suite marking" } };
const roots: string[] = [];

afterEach(async () => {
  seenExplicitBins.splice(0);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function mkroot(): Promise<{ root: string; binDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-suitemark-"));
  roots.push(root);
  const binDir = path.join(root, "fake-tools");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "aeh-fixture-suite-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "toolchain.state.json"),
    JSON.stringify({ version: 1, binPaths: [binDir] }),
    "utf8"
  );
  return { root, binDir };
}

function validationContext(root: string): ValidationContext {
  return {
    root,
    config,
    contract,
    spec: { id: "s", adapter: "command", command: "aeh-fixture-suite-tool", required: true },
    baseRef: "HEAD",
    changedFiles: []
  };
}

describe("explicit marking on remaining suite-capable validator paths", () => {
  it("runSpecCommand marks pinned bins and runs a state-only tool", async () => {
    const { root, binDir } = await mkroot();
    const check = await runSpecCommand(validationContext(root), "aeh-fixture-suite-tool", "custom");
    expect(check.status).toBe("PASS");
    expect(seenExplicitBins).toContainEqual([binDir]);
  });

  it("provider test plans carry the workspace pinned bins", async () => {
    const { root, binDir } = await mkroot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "exit 0" } }), "utf8");
    const provider = new ProjectNativeTestExecutionProvider();
    const plan = await provider.plan({
      root,
      config,
      contract,
      capability: "unit-test",
      rawArtifactDirectory: path.join(root, ".harness", "evidence")
    });
    expect(plan.toolchainExtraBinPaths).toEqual([binDir]);
  });

  it("executePlan forwards plan bins to the spawned command", async () => {
    const { root } = await mkroot();
    const { executePlan: run } = await import("../../src/providers/validation/providerUtils.js");
    await run({
      provider: "test",
      capability: "unit-test",
      command: "exit 0",
      cwd: root,
      toolchainExtraBinPaths: ["/opt/pinned/bin"]
    });
    expect(seenExplicitBins).toContainEqual(["/opt/pinned/bin"]);
  });
});
