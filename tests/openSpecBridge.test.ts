import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { compileOpenSpecChange, openSpecChangeName, preflightOpenSpec, prepareOpenSpecChange } from "../src/spec/openspec.js";
import { validateSddChange } from "../src/core/sdd.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
const config = {
  version: 1,
  project: { name: "demo" },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts", authoring: { provider: "openspec", schema: "spec-driven", managerAgent: "spec-manager" } },
  validation: { baseRef: "main", commands: [{ id: "test", command: "npm test", required: true }] },
  orchestration: { provider: "paseo", worker: { maxRepairAttempts: 2 } }
} as HarnessProjectConfig;

describe("OpenSpec authoring bridge", () => {
  it("preflights required capabilities without depending on --json output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-preflight-"));
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.includes("--json")) return result(1, "", "error: unknown option '--json'");
      if (command === "openspec --version") return result(0, "OpenSpec 0.test\n");
      if (command === "openspec new change --help") return result(0, "Options: --schema <schema> --description <text>");
      if (command === "openspec validate --help") return result(0, "Options: --strict");
      if (command.startsWith("openspec new change")) return result(0, "created");
      return result(1, "", `unexpected ${command}`);
    });
    const preflight = await preflightOpenSpec(root, config, run as never);
    const prepared = await prepareOpenSpecChange(root, config, "CHANGE-1", "Compatibility", run as never);
    expect(preflight).toEqual(expect.objectContaining({ version: "OpenSpec 0.test", schema: "spec-driven", managerAgent: "spec-manager" }));
    expect(prepared.changeName).toBe("change-1");
    expect(commands.some((command) => command.includes("--json"))).toBe(false);
  });

  it("fails preflight when a semantic OpenSpec capability is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-preflight-fail-"));
    const run = vi.fn(async (command: string) => {
      if (command === "openspec --version") return result(0, "OpenSpec 0.test");
      if (command === "openspec new change --help") return result(0, "--schema --description");
      if (command === "openspec validate --help") return result(0, "validate options");
      return result(1, "", "unexpected");
    });
    await expect(preflightOpenSpec(root, config, run as never)).rejects.toThrow(/required option --strict/i);
  });

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
    const run = vi.fn(async (command: string) => {
      expect(command).not.toContain("--json");
      return command.startsWith("openspec validate") ? result(0, "valid") : result(1, "", `unexpected ${command}`);
    });
    const compiled = await compileOpenSpecChange(root, config, taskId, "Improve code readability", change, run as never);
    expect(compiled.requirements).toEqual(["READABILITY-1-R1"]);
    expect(compiled.validatorId).toBe("test");
    const contract = YAML.parse(await fs.readFile(compiled.contractPath, "utf8")) as TaskContract;
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
    const run = vi.fn(async () => result(0, "valid"));
    const compiled = await compileOpenSpecChange(root, config, taskId, "Internal cleanup", change, run as never);
    const spec = await fs.readFile(path.join(compiled.sddDirectory, "spec.md"), "utf8");
    expect(spec).toContain("Preserve approved behavior");
    expect(compiled.requirements).toEqual(["CLEANUP-1-R1"]);
  });

  it("derives an executable project test command instead of emitting a phantom validator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-derived-validator-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const taskId = "DERIVED-1"; const change = openSpecChangeName(taskId); const dir = path.join(root, "openspec/changes", change);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "proposal.md"), "# Cleanup\n\n## Desired outcome\nPreserve behavior.\n");
    await fs.writeFile(path.join(dir, "tasks.md"), "- [ ] Refactor safely\n");
    const noValidationConfig = { ...config, validation: { baseRef: "main", commands: [], validators: [] } } as HarnessProjectConfig;
    const compiled = await compileOpenSpecChange(root, noValidationConfig, taskId, "Derived validation", change, vi.fn(async () => result(0, "valid")) as never);
    const contract = YAML.parse(await fs.readFile(compiled.contractPath, "utf8")) as TaskContract;
    expect(compiled.validatorId).toBe("test");
    expect(contract.verification?.commands).toEqual([expect.objectContaining({ id: "test", command: "npm test", required: true })]);
    expect((await validateSddChange(root, taskId, noValidationConfig)).ok).toBe(true);
  });

  it("fails compilation when no deterministic requirement evidence can be derived", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-openspec-no-validator-"));
    const taskId = "NO-VALIDATOR-1"; const change = openSpecChangeName(taskId); const dir = path.join(root, "openspec/changes", change);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "proposal.md"), "# Change\n\n## Desired outcome\nDo something observable.\n");
    await fs.writeFile(path.join(dir, "tasks.md"), "- [ ] Implement\n");
    const noValidationConfig = { ...config, validation: { baseRef: "main", commands: [], validators: [] } } as HarnessProjectConfig;
    await expect(compileOpenSpecChange(root, noValidationConfig, taskId, "No validator", change, vi.fn(async () => result(0, "valid")) as never)).rejects.toThrow(/deterministic requirement validation/i);
  });
});
