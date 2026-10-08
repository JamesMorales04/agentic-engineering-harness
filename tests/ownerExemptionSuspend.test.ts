import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  REPAIR_SCOPE_DENY_CHOICE_ID,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  resolveRepairScopeBlockerViaProductChoice,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";

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

describe("hard-block suspend/decide/resume/honor (DETERMINISTIC, REAL suspend/resume)", () => {
  it("hard-protected blocker suspends HUMAN_REQUIRED with deterministic approve/decline, approval mints grant and honors retry", async () => {
    const root = await createRepo();
    const operationId = "HARD-SUSPEND-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    expect(findRepairHardProtectedViolations([specPath], config, task)).toEqual([specPath]);

    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:red-hard", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: specPath, reason: "spec must be regenerated" }],
        })}`,
        stderr: "",
      }),
    });
    expect(blockerResult.scopeBlocker).toBeDefined();

    // Resolve in background with no timeout (suspend path must appear, not terminal BLOCKED).
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task,
      blocker: blockerResult.scopeBlocker!,
    });
    const approve = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const current = await loadOperation(root, operationId);
        if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
          // Deterministic choices from declared hard paths: approve-exact-set / decline.
          const choiceIds = current.decisionRequest.choices.map((c) => c.choiceId);
          expect(choiceIds).toContain(REPAIR_SCOPE_APPROVE_CHOICE_ID);
          expect(choiceIds).toContain(REPAIR_SCOPE_DENY_CHOICE_ID);
          // No agent input in choices: file list derives from blocker.
          const issue = current.decisionRequest.issue;
          expect(issue).toContain(specPath);
          // Continuation binds the request.
          expect(current.continuation?.requestId).toBe(current.decisionRequest.requestId);
          expect(current.continuation?.state).toBe("WAITING");
          const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
          const { HumanDecisionLedgerV2: Ledger } = await import("../src/security/humanDecision.js");
          const ledger = new Ledger(path.join(root, ".harness", "security", "human-decisions.json"));
          await recordControlCenterDecision(root, ledger, {
            operationId, requestId: current.decisionRequest.requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "owner approves exact hard set",
          }, "human:control-center:test");
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("suspension never appeared for hard blocker");
    })();
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    // New flow: approval mints MAC grant, anchors, resumes, retries with grant.
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED after hard approval");
    expect(resolved.amendment.exemptedPaths).toEqual([specPath]);
    expect(resolved.amendment.ownerExemption?.exemptionId).toMatch(/^exemption:/);
    expect(resolved.amendment.decisionId).toMatch(/^decision:/);
    // Grant anchored to operation record.
    const after = await loadOperation(root, operationId);
    expect(after.ownerExemptions?.[resolved.amendment.ownerExemption!.exemptionId]).toBeDefined();
    // Suspension cleared.
    expect(after.continuation).toBeUndefined();
    expect(after.decisionRequest).toBeUndefined();
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  }, 30000);
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-hard-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

async function writeContractAndSeal(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const { default: YAML } = await import("yaml");
  const dir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  const { sealTask } = await import("../src/core/seal.js");
  await fs.mkdir(path.join(root, "specs", "changes", task.task.id), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "proposal.md"), "# proposal\n");
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "spec.md"), "# spec\n");
  await sealTask(root, config, task);
}

async function bindPolicyForCurrentIdentity(root: string, operationId: string) {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "red hard suspend test policy",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "red-hard-suspend-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(taskId: string): TaskContract {
  return {
    version: 1,
    task: { id: taskId, title: `Repair ${taskId}` },
    source: { proposal: `specs/changes/${taskId}/proposal.md`, spec: `specs/changes/${taskId}/spec.md` },
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

function repairerSelection(): any {
  return {
    logicalAgent: "repairer",
    role: "Repairer",
    domains: [],
    runtimeName: "test",
    runtimeAdapter: "codex",
    paseoProvider: "codex",
    modelAlias: "test",
    modelName: "fake",
    modelId: "fake",
    transport: "direct",
    skills: [],
    mcps: [],
    permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
    outputContract: "repair-result",
    args: [],
    runtimeCapabilities: {},
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
