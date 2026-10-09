import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { loadOperation } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * RED-first: LIVE-PROVEN gap — repair.ts:200 apply path bypasses the
 * Luna-accepted 1-turn correction wrapper (DIRECT + waveExecutor only).
 * A live micro-op died terminally here with zero correction diagnostic.
 * Required: IDENTICAL 1-turn semantics (same helper, same budget-counting
 * against EXISTING repair budget, second escape terminal, full re-validation,
 * symlink/empty/digest/stale stay terminal, declaration-first BLOCKED preserved).
 */
describe("repair escape-correction (RED)", () => {
  it("repair-path escape offers exactly one correction with precise diagnostic", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-CORR-RED-1";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1,
      id: operationId,
      kind: "run",
      status: "RUNNING",
      phase: "repair",
      root,
      payload: { taskId: task.task.id },
      createdAt: now,
      updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

    const prompts: string[] = [];
    let calls = 0;
    const result = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:escape-corr",
      phase: "validation-repair",
      config,
      contract: task,
      selection,
      executionCatalog: catalog,
      allowedScope: ["src/**"],
      forbiddenScope: [],
      prompt: "Repair implementation only within src/**.",
      execute: async (isolatedRoot, participantId, prompt) => {
        calls += 1;
        prompts.push(typeof prompt === "string" ? prompt : "Repair implementation only within src/**.");
        if (calls === 1) {
          // First turn escapes: writes outside assigned scope.
          await fs.mkdir(path.join(isolatedRoot, "outside"), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, "outside", "evil.ts"), "export const evil = 1;\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        }
        // Correction turn: in-scope fix only.
        await fs.writeFile(path.join(isolatedRoot, "src", "value.ts"), "export const value = 2;\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Must offer exactly one correction (2 worker turns total).
    expect(calls).toBe(2);
    // Correction diagnostic must be precise: escaped files + hard/amendable +
    // declare-via-filesNeededOutsideScope + second-escape-terminal + budget note.
    const diagnostic = prompts[1] ?? "";
    expect(diagnostic).toContain("outside/evil.ts");
    expect(diagnostic).toContain("filesNeededOutsideScope");
    expect(diagnostic).toContain("second escape is terminal");
    // Guard for (a)=FALSE: never echoes full allowed/forbidden patterns.
    expect(diagnostic).not.toContain("__ALLOWED_SENTINEL__");
    expect(diagnostic).not.toContain("__FORBIDDEN_SENTINEL__");
    // Correction succeeded: candidate advanced, no blocker.
    expect(result.candidate).toBeDefined();
    expect(result.scopeBlocker).toBeUndefined();
    expect(result.changeSet?.changedFiles).toContain("src/value.ts");
  });

  it("second escape is terminal with ORIGINAL error (exactly one correction, no third turn)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-CORR-RED-2";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    let calls = 0;
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:escape-corr-2", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: "Repair implementation only within src/**.",
        execute: async (isolatedRoot, participantId) => {
          calls += 1;
          await fs.mkdir(path.join(isolatedRoot, "outside"), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, "outside", `evil${calls}.ts`), "export const evil = 1;\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("outside/evil1.ts");
    expect(calls).toBe(2);
  });

  it("symlink escape stays terminal with NO correction (fail-closed for attack-like class)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-CORR-RED-3";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    let calls = 0;
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:symlink", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: "Repair implementation only.",
        execute: async (isolatedRoot, participantId) => {
          calls += 1;
          await fs.symlink("../../outside", path.join(isolatedRoot, "src", "link"));
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/symlink/i);
    expect(calls).toBe(1);
  });

  it("correction declaring blocker routes to BLOCKED (declaration-first, never PASS-with-declaration)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-CORR-RED-4";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    let calls = 0;
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:escape-declare", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: "Repair implementation only within src/**.",
      execute: async (isolatedRoot, participantId) => {
        calls += 1;
        if (calls === 1) {
          await fs.mkdir(path.join(isolatedRoot, "outside"), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, "outside", "evil.ts"), "export const evil = 1;\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        }
        // Correction declares needed file via declare-first channel, no changes.
        return {
          provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
          stdout: `AEH_RESULT_JSON=${JSON.stringify({
            filesChanged: [], behaviorRepaired: [], validationCommands: [],
            filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump for fix" }],
          })}`,
          stderr: "",
        };
      },
    });
    expect(calls).toBe(2);
    expect(result.scopeBlocker).toBeDefined();
    expect(result.candidate).toBeUndefined();
    expect(result.scopeBlocker?.filesNeededOutsideScope.map((e) => e.path)).toContain("package-lock.json");
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-esc-corr-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "repair-esc-corr-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "REPAIR-ESC-CORR", title: "Repair escape correction" },
    source: { proposal: "specs/changes/REPAIR-ESC-CORR/proposal.md", spec: "specs/changes/REPAIR-ESC-CORR/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}

function repairerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "repairer", role: "Repairer", domains: [],
    runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex",
    modelAlias: "test", modelId: "fake", modelName: "fake",
    transport: "direct", skills: [], mcps: [],
    permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
    outputContract: "repair-result", args: [], runtimeCapabilities: {},
  };
}

function bindEnv(operationId: string, root: string): void {
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROL_ROOT = root;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
