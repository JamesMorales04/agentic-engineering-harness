import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  withOneScopeEscapeCorrectionTurnV1,
  getScopeEscapeDetails,
} from "../src/candidates/scopeEscapeCorrection.js";
import { AehError } from "../src/core/errors.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
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
 * RED-first (Luna round-3): correction budget checked AFTER offering.
 * Repair loop checks `attempts + used < max` before starting a repair, then
 * increments attempts; the correction inside is only added to used afterward.
 * With maxRepairs=1: 1 repair + 1 correction = 2 units > budget.
 * Required: check REMAINING before offering each correction
 * (attempts + used >= max → original escape throw immediately, no correction).
 */
describe("repair escape-correction REMAINING budget gate (RED)", () => {
  it("helper with remainingBudget=0 throws ORIGINAL without offering correction", async () => {
    const original = new AehError("PARTICIPANT_PLAN_INVALID", "ChangeSet escaped its assigned scope: outside/evil.ts", {
      details: {
        escapedFiles: ["outside/evil.ts"],
        escapedCount: 1,
        amendableManifests: [],
        amendableCount: 0,
        hardProtected: [],
        hardProtectedCount: 0,
      },
    });
    // Sanity: fixture is a recognized scope escape.
    expect(getScopeEscapeDetails(original)).toBeDefined();
    let correctionCalls = 0;
    await expect(
      withOneScopeEscapeCorrectionTurnV1<string>({
        attempt: async () => {
          throw original;
        },
        buildCorrectionPrompt: () => "DIAGNOSTIC",
        executeCorrection: async () => {
          correctionCalls += 1;
          return "corrected";
        },
        // Luna-required pre-offer gate: no remaining budget → no correction.
        remainingBudget: 0,
      }),
    ).rejects.toBe(original);
    expect(correctionCalls).toBe(0);
  });

  it("repair apply with remaining=0 throws ORIGINAL with NO correction turn (maxRepairs=1 overspend)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-BUDGET-RED-1";
    const task = contractWithMaxRepairs(1);
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

    let calls = 0;
    await expect(
      executeRepairerCandidateMutation({
        root,
        stateRoot: root,
        operationId,
        taskId: task.task.id,
        workUnitId: "validation-repair:budget-red",
        phase: "validation-repair",
        config,
        contract: task,
        selection,
        executionCatalog: catalog,
        allowedScope: ["src/**"],
        forbiddenScope: [],
        prompt: "Repair implementation only within src/**.",
        // Luna scenario: run.ts loop entered with attempts=0/used=0/max=1, then
        // attempts→1. Remaining for the correction = 1-(1+0) = 0 → no offer.
        escapeCorrectionRemainingBudget: 0,
        execute: async (isolatedRoot, participantId) => {
          calls += 1;
          await fs.mkdir(path.join(isolatedRoot, "outside"), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, "outside", "evil.ts"), "export const evil = 1;\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("outside/evil.ts");
    // No correction turn offered: exactly one worker turn.
    expect(calls).toBe(1);
  });

  it("repair apply with remaining=1 still offers the single correction", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-ESC-BUDGET-GREEN-1";
    const task = contractWithMaxRepairs(2);
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

    let calls = 0;
    const result = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:budget-green",
      phase: "validation-repair",
      config,
      contract: task,
      selection,
      executionCatalog: catalog,
      allowedScope: ["src/**"],
      forbiddenScope: [],
      prompt: "Repair implementation only within src/**.",
      // Remaining = 2-(1+0) = 1 → correction allowed.
      escapeCorrectionRemainingBudget: 1,
      execute: async (isolatedRoot, participantId) => {
        calls += 1;
        if (calls === 1) {
          await fs.mkdir(path.join(isolatedRoot, "outside"), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, "outside", "evil.ts"), "export const evil = 1;\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        }
        await fs.writeFile(path.join(isolatedRoot, "src", "value.ts"), "export const value = 2;\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toBe(2);
    expect(result.candidate).toBeDefined();
    expect(result.correctionUsed).toBe(true);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-esc-budget-"));
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
    project: { name: "repair-esc-budget-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contractWithMaxRepairs(maxAttempts: number): TaskContract {
  return {
    version: 1,
    task: { id: "REPAIR-ESC-BUDGET", title: "Repair escape budget" },
    source: { proposal: "specs/changes/REPAIR-ESC-BUDGET/proposal.md", spec: "specs/changes/REPAIR-ESC-BUDGET/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
    repair: { maxAttempts },
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
