import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidationCommand } from "../../src/validators/commands.js";
import type { ProcessOptions } from "../../src/utils/process.js";

/**
 * Explicit state-derived marking for command validators
 * (MECHANISM: DETERMINISTIC). Suite commands (npm -> test runners ->
 * fixture validators in tmpdir roots without state) must resolve the
 * validation root's pinned tools across the managed-child scrub
 * boundary. The fake tool name is unique to the fixture state:
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

const roots: string[] = [];

afterEach(async () => {
  seenExplicitBins.splice(0);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function mkroot(withState: boolean): Promise<{ root: string; binDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cmdbins-"));
  roots.push(root);
  const binDir = path.join(root, "fake-tools");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "aeh-fixture-cmd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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

describe("explicit state-derived marking for command validators", () => {
  it("marks the validation root pinned bins explicitly and runs a state-only tool", async () => {
    const { root, binDir } = await mkroot(true);
    const check = await runValidationCommand(root, { id: "statepin-cmd", command: "aeh-fixture-cmd", required: true });
    expect(check.status).toBe("PASS");
    expect(seenExplicitBins).toContainEqual([binDir]);
  });

  it("fails closed when neither state nor ambient marking provides the tool", async () => {
    const { root } = await mkroot(false);
    const check = await runValidationCommand(root, { id: "statepin-cmd-missing", command: "aeh-fixture-cmd", required: true });
    expect(check.status).toBe("FAIL");
  });
});
