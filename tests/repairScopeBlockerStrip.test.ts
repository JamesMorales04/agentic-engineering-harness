import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
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

describe("H-NEW-7: blocker strip-and-trace", () => {
  it("mixed in-scope + genuinely-blocked declaration strips in-scope and proceeds with blocker", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-HNEW7-MIXED-1";
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
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:mixed", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [
            { path: "src/value.ts", reason: "model believes needs in-scope file" },
            { path: "package-lock.json", reason: "trivy-mandated transitive bump" },
          ],
        })}`,
        stderr: "",
      }),
    });
    // Must strip in-scope and proceed with the remainder (no terminal throw).
    expect(result.scopeBlocker).toBeDefined();
    expect(result.scopeBlocker?.filesNeededOutsideScope.map((e) => e.path)).toEqual(["package-lock.json"]);
    // Stripped in-scope file is traced as a diagnostic (model-confusion signal).
    const traceRaw = await fs.readFile(path.join(root, ".harness/telemetry/paseo.ndjson"), "utf8").catch(() => "");
    expect(traceRaw).toContain("candidate.repair.blocker.stripped");
    expect(traceRaw).toContain("src/value.ts");
    expect(traceRaw).toContain("package-lock.json");
  });

  it("all-in-scope declaration proceeds vacuous (no blocker, no throw) with trace", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-HNEW7-VACUOUS-1";
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
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:vacuous", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [
            { path: "src/value.ts", reason: "model confused about in-scope file" },
          ],
        })}`,
        stderr: "",
      }),
    });
    // Vacuous declaration: no blocker, no throw, session surfaces unchanged.
    expect(result.scopeBlocker).toBeUndefined();
    expect(result.session.exitCode).toBe(0);
    // Trace must preserve the model-confusion signal; no durable receipt is written.
    const traceFile = path.join(root, ".harness/telemetry/paseo.ndjson");
    const raw = await fs.readFile(traceFile, "utf8").catch(() => "");
    expect(raw).toContain("candidate.repair.blocker.stripped");
    expect(raw).toContain("src/value.ts");
    const receiptExists = await fs.stat(path.join(root, ".harness/repairs", `${task.task.id}-scope-blocker.json`)).then(() => true).catch(() => false);
    expect(receiptExists).toBe(false);
  });

  it("genuinely-out-of-scope declaration still flows to amendment path unchanged", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-HNEW7-GENUINE-1";
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
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:genuine", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    expect(result.scopeBlocker?.filesNeededOutsideScope.map((e) => e.path)).toEqual(["package-lock.json"]);
    // No stripping occurred, so no strip trace is emitted (existing behavior pinned).
    const traceRaw = await fs.readFile(path.join(root, ".harness/telemetry/paseo.ndjson"), "utf8").catch(() => "");
    expect(traceRaw).not.toContain("candidate.repair.blocker.stripped");
  });

  it("explicitly-denied in-allowed file is genuinely blocked (never stripped)", async () => {
    const root = await createRepo();
    await fs.writeFile(path.join(root, "src", "secret.ts"), "export const s = 1;\n");
    const operationId = "CHANGE-HNEW7-DENIED-1";
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
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:denied", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: ["src/secret.ts"],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [
            { path: "src/secret.ts", reason: "needs denied file" },
            { path: "src/value.ts", reason: "model confused about writable file" },
          ],
        })}`,
        stderr: "",
      }),
    });
    // Denied file stays blocked; writable file is stripped and traced.
    expect(result.scopeBlocker?.filesNeededOutsideScope.map((e) => e.path)).toEqual(["src/secret.ts"]);
    const traceRaw = await fs.readFile(path.join(root, ".harness/telemetry/paseo.ndjson"), "utf8").catch(() => "");
    expect(traceRaw).toContain("src/value.ts");
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-hnew7-strip-"));
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
    project: { name: "hnew7-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "HNEW7", title: "strip trace" },
    source: { proposal: "specs/changes/HNEW7/proposal.md", spec: "specs/changes/HNEW7/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}

function packet(taskId: string) {
  return {
    version: 1 as const, taskId, attempt: 1, createdAt: new Date().toISOString(),
    failures: [{ id: "dep.vuln", category: "dependency", message: "needs bump" }],
  };
}

function repairerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "repairer", role: "Repairer", domains: [],
    runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex",
    modelAlias: "test", modelId: "fake", modelName: "fake", transport: "direct",
    skills: [], mcps: [],
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
