import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation, repairProtectedPaths } from "../src/candidates/repair.js";
import {
  applyRepairScopeAmendment,
  filterForbiddenScopeForAmendment,
  listRepairScopeAmendments,
  repairScopeBlockerValidationCheck,
} from "../src/candidates/repairScope.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
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

describe("repair out-of-scope blocker → bounded replan channel (RED)", () => {
  it("Repairer declaring needed-files returns a BLOCKED receipt with no throw and no mutation", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-BLOCKER-1";
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
    });
    const initial = (await loadOperation(root, operationId)).candidateRevision!;
    bindEnv(operationId);

    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

    // No filesystem mutation; Repairer declares the lockfile it needs with a reason.
    const result = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:blocker",
      phase: "validation-repair",
      config,
      contract: task,
      selection,
      executionCatalog: catalog,
      allowedScope: ["src/**"],
      forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_isolatedRoot, participantId) => ({
        provider: "test",
        logicalAgent: "repairer",
        participantId,
        exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [],
          behaviorRepaired: [],
          validationCommands: [],
          filesNeededOutsideScope: [
            { path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" },
          ],
        })}`,
        stderr: "",
      }),
    });

    // Deterministic typed BLOCKED outcome: no throw, no ChangeSet, no candidate.
    expect(result.changeSet).toBeUndefined();
    expect(result.candidate).toBeUndefined();
    expect(result.scopeBlocker).toBeDefined();
    expect(result.scopeBlocker?.filesNeededOutsideScope).toMatchObject([
      { path: "package-lock.json", reason: expect.stringContaining("trivy") },
    ]);
    // No workspace mutation and no candidate advancement.
    expect(await fs.readFile(path.join(root, "package-lock.json"), "utf8")).toBe("{\"lockfileVersion\":1}\n");
    expect((await loadOperation(root, operationId)).candidateRevision?.identityDigest).toBe(initial.identityDigest);

    // Surfaces as validation FAIL with the blocker cited.
    const check = repairScopeBlockerValidationCheck(result.scopeBlocker!);
    expect(check.status).toBe("FAIL");
    expect(check.id).toBe("repair.scope-blocker");
    expect(check.message).toContain("package-lock.json");

    // Default-deny is unchanged: lockfile remains protected.
    expect(repairProtectedPaths(config, task).some((p) => p === "package-lock.json")).toBe(true);
  });

  it("lead-approved amendment reseals and the single-file retry succeeds; silent expansion still throws", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-AMEND-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
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
    });
    bindEnv(operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

    const blockerResult = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:blocker",
      phase: "validation-repair",
      config,
      contract: task,
      selection,
      executionCatalog: catalog,
      allowedScope: task.scope?.allowed ?? ["src/**"],
      forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_isolatedRoot, participantId) => ({
        provider: "test",
        logicalAgent: "repairer",
        participantId,
        exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [],
          behaviorRepaired: [],
          validationCommands: [],
          filesNeededOutsideScope: [
            { path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" },
          ],
        })}`,
        stderr: "",
      }),
    });
    expect(blockerResult.scopeBlocker).toBeDefined();

    // Lead-approved bounded amendment: allowlist the single manifest file, reseal, persist.
    const amended = await applyRepairScopeAmendment({
      root,
      config,
      contract: task,
      blocker: blockerResult.scopeBlocker!,
      decision: { approved: true, decidedBy: "lead", reason: "accept trivy transitive bump for package-lock.json only" },
    });
    expect(amended.status).toBe("AMENDED");
    if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(amended.contract.scope?.allowed).toContain("package-lock.json");
    expect(amended.amendment.exemptedPaths).toEqual(["package-lock.json"]);
    expect(amended.amendment.decidedBy).toBe("lead");
    // Durable artifacts: amended contract + amendment file + resealed seal.
    expect(await fs.stat(path.join(root, ".harness", "contracts", `${task.task.id}.yaml`))).toBeDefined();
    expect(await fs.stat(path.join(root, amended.amendment.amendmentPath))).toBeDefined();
    expect(await fs.stat(path.join(root, amended.amendment.sealPath))).toBeDefined();
    expect((await listRepairScopeAmendments(root, config, task.task.id)).length).toBe(1);

    // Retry once against the amended scope: editing the exempted lockfile now succeeds.
    const retry = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:amended-retry",
      phase: "validation-repair",
      config,
      contract: amended.contract,
      selection,
      executionCatalog: catalog,
      allowedScope: amended.contract.scope?.allowed ?? ["src/**"],
      forbiddenScope: [],
      scopeAmendment: amended.amendment,
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.writeFile(path.join(isolatedRoot, "package-lock.json"), "{\"lockfileVersion\":2}\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain("package-lock.json");
    expect(await fs.readFile(path.join(root, "package-lock.json"), "utf8")).toBe("{\"lockfileVersion\":2}\n");

    // The exemption is narrow: silent expansion to a non-amended protected file still throws.
    await expect(
      executeRepairerCandidateMutation({
        root,
        stateRoot: root,
        operationId,
        taskId: task.task.id,
        workUnitId: "validation-repair:silent-expansion",
        phase: "validation-repair",
        config,
        contract: amended.contract,
        selection,
        executionCatalog: catalog,
        allowedScope: amended.contract.scope?.allowed ?? ["src/**"],
        forbiddenScope: [],
        scopeAmendment: amended.amendment,
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, "acceptance", "flow.feature"), "Then any value is accepted\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("ChangeSet escaped its assigned scope");
    // Effective forbidden still denies non-exempt protected paths.
    const effectiveForbidden = filterForbiddenScopeForAmendment(
      [...repairProtectedPaths(config, amended.contract)],
      amended.amendment,
    );
    expect(effectiveForbidden.some((p) => p === "package-lock.json")).toBe(false);
    expect(effectiveForbidden.length).toBeGreaterThan(0);
  });

  it("unapproved (or non-lead) decision leaves BLOCKED standing and fails closed citing the blocker", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-DENIED-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
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
    });
    bindEnv(operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

    const blockerResult = await executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:blocker",
      phase: "validation-repair",
      config,
      contract: task,
      selection,
      executionCatalog: catalog,
      allowedScope: task.scope?.allowed ?? ["src/**"],
      forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_isolatedRoot, participantId) => ({
        provider: "test",
        logicalAgent: "repairer",
        participantId,
        exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [],
          behaviorRepaired: [],
          validationCommands: [],
          filesNeededOutsideScope: [
            { path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" },
          ],
        })}`,
        stderr: "",
      }),
    });
    expect(blockerResult.scopeBlocker).toBeDefined();

    // Lead does not approve: BLOCKED stands, no amendment, no reseal.
    const denied = await applyRepairScopeAmendment({
      root,
      config,
      contract: task,
      blocker: blockerResult.scopeBlocker!,
      decision: { approved: false, decidedBy: "lead", reason: "lockfile churn not justified" },
    });
    expect(denied.status).toBe("BLOCKED");
    if (denied.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(denied.check.status).toBe("FAIL");
    expect(denied.check.message).toContain("package-lock.json");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);

    // Non-lead context cannot approve either.
    const nonLead = await applyRepairScopeAmendment({
      root,
      config,
      contract: task,
      blocker: blockerResult.scopeBlocker!,
      decision: { approved: true, decidedBy: "repairer", reason: "model self-approval" },
    });
    expect(nonLead.status).toBe("BLOCKED");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("repair prompt states the blocker path explicitly (report, don't expand)", async () => {
    const prompt = buildRepairPrompt(packet("REPAIR-PROMPT-CHECK"));
    expect(prompt).toContain("smallest targeted changes");
    expect(prompt).toContain("do not broaden scope");
    expect(prompt).toMatch(/filesNeededOutsideScope/i);
    expect(prompt).toMatch(/do not edit.*outside.*scope|report.*do.*expand/i);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-scope-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", {
    cwd: root,
  });
  return root;
}

async function writeContractAndSeal(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const { default: YAML } = await import("yaml");
  const dir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  const { sealTask } = await import("../src/core/seal.js");
  // Ensure sealed sources exist for the seal.
  await fs.mkdir(path.join(root, "specs", "changes", task.task.id), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "proposal.md"), "# proposal\n");
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "spec.md"), "# spec\n");
  await sealTask(root, config, task);
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "repair-scope-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "REPAIR-SCOPE", title: "Repair needs lockfile" },
    source: { proposal: "specs/changes/REPAIR-SCOPE/proposal.md", spec: "specs/changes/REPAIR-SCOPE/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}

function packet(taskId: string) {
  return {
    version: 1 as const,
    taskId,
    attempt: 1,
    createdAt: new Date().toISOString(),
    failures: [{ id: "dep.vuln", category: "dependency", message: "transitive dep needs bump" }],
  };
}

function repairerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "repairer",
    role: "Repairer",
    domains: [],
    runtimeName: "test",
    runtimeAdapter: "codex",
    paseoProvider: "codex",
    modelAlias: "test",
    modelId: "fake",
    modelName: "fake",
    transport: "direct",
    skills: [],
    mcps: [],
    permissions: {
      read: "allow",
      write: "allow",
      shell: "allow",
      network: "deny",
      delegate: "deny",
      review: "deny",
      gitWrite: "deny",
    },
    outputContract: "repair-result",
    args: [],
    runtimeCapabilities: {},
  };
}

function bindEnv(operationId: string): void {
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROL_ROOT = roots[roots.length - 1];
  // AEH_CONTROL_ROOT must be the repo root for these tests (stateRoot === root).
  const root = roots[roots.length - 1];
  process.env.AEH_CONTROL_ROOT = root;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
