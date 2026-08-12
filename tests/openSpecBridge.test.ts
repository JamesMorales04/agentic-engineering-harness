import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { compileOpenSpecChange, openSpecChangeName } from "../src/spec/openspec.js";
import { validateSddChange } from "../src/core/sdd.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
const config = {
  version: 1,
  project: { name: "demo" },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts", authoring: { provider: "openspec", schema: "spec-driven", managerAgent: "spec-manager" } },
  validation: { baseRef: "main", commands: [{ id: "test", command: "npm test", required: true }] },
  orchestration: { worker: { maxRepairAttempts: 2 } }
} as unknown as HarnessProjectConfig;

describe("OpenSpec authoring bridge", () => {
  it("compiles approved OpenSpec requirements/scenarios into traceable AEH artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-"));
    const taskId = "READABILITY-1";
    const change = openSpecChangeName(taskId);
    const dir = path.join(root, "openspec/changes", change);
    await fs.mkdir(path.join(dir, "specs/readability"), { recursive: true });
    await fs.writeFile(path.join(dir, "proposal.md"), "# Improve readability\n\n## Why\nReduce cognitive load.\n");
    await fs.writeFile(path.join(dir, "design.md"), "# Design\n\nExtract helpers without behavior changes.\n");
    await fs.writeFile(path.join(dir, "tasks.md"), "- [ ] Extract readability helpers\n- [ ] Preserve tests\n");
    await fs.writeFile(path.join(dir, "specs/readability/spec.md"), [
      "# Readability delta", "", "### Requirement: Preserve observable behavior", "",
      "Refactoring SHALL preserve externally observable behavior.", "",
      "#### Scenario: Existing behavior remains stable", "",
      "- **GIVEN** the existing test suite passes", "- **WHEN** readability refactoring is applied", "- **THEN** the same observable tests continue to pass", ""
    ].join("\n"));
    const run = vi.fn(async (command: string) => command.startsWith("openspec validate") ? result(0, '{"valid":true}') : result(1, "", `unexpected ${command}`));
    const compiled = await compileOpenSpecChange(root, config, taskId, "Improve code readability", change, run as never);
    expect(compiled.requirements).toEqual(["READABILITY-1-R1"]);
    const contract = YAML.parse(await fs.readFile(compiled.contractPath, "utf8")) as TaskContract & { authoring?: { provider: string; change: string } };
    expect(contract.authoring).toEqual(expect.objectContaining({ provider: "openspec", change }));
    expect(contract.requirements?.[0].validators).toContain("test");
    const acceptance = await fs.readFile(path.join(compiled.sddDirectory, "acceptance.feature"), "utf8");
    expect(acceptance).toContain("@READABILITY-1-R1");
    expect(acceptance).toContain("Given the existing test suite passes");
    const validation = await validateSddChange(root, taskId, config);
    expect(validation.ok, validation.issues.join("\n")).toBe(true);
  });

  it("creates an explicit preservation requirement for refactor changes with no delta spec", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-refactor-"));
    const taskId = "CLEANUP-1"; const change = openSpecChangeName(taskId); const dir = path.join(root, "openspec/changes", change);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "proposal.md"), "# Cleanup\n\n## Desired outcome\nImprove internal readability without behavior changes.\n");
    await fs.writeFile(path.join(dir, "tasks.md"), "- [ ] Simplify internals\n");
    const run = vi.fn(async () => result(0, '{"valid":true}'));
    const compiled = await compileOpenSpecChange(root, config, taskId, "Internal cleanup", change, run as never);
    const spec = await fs.readFile(path.join(compiled.sddDirectory, "spec.md"), "utf8");
    expect(spec).toContain("Preserve approved behavior");
    expect(compiled.requirements).toEqual(["CLEANUP-1-R1"]);
  });
});
