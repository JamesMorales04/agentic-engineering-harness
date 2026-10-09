import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindOperationCandidateWithAssemblyReceipt,
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
};
afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("H-NEW-12 RED: grant liveness across normal op progress", () => {
  it("live grant honors a lineage-descendant candidate after advance + policy rebind (fails BINDING_STALE today)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-RED-1";
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
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, specPath);
    const { grant } = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    const anchored = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: anchored, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).resolves.toBeDefined();

    // Normal op progress: candidate advance (lineage child) + execution-revision increment + policy rebind.
    const base = (await loadOperation(root, operationId)).candidateRevision!;
    const advanced = createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r${base.revision + 1}`,
      projectId: base.projectId,
      taskId: base.taskId,
      revision: base.revision + 1,
      parentCandidateId: base.candidateId,
      sourceDigest: base.sourceDigest,
      worktree: root,
    });
    await bindOperationCandidateWithAssemblyReceipt(root, operationId, {
      baseCandidate: base,
      candidate: advanced,
      changeSet: {
        operationId,
        taskId: task.task.id,
        workUnitId: `validation-repair:${operationId}:red-advance`,
        participantId: "participant:red-advance",
        baseCandidateRevision: base.revision,
        baseCandidateDigest: base.identityDigest,
        patchDigest: "c".repeat(64),
      },
    });
    // Rebind policy for the advanced candidate with identical stable config (new revision-varying only).
    await bindPolicyForCurrentIdentity(root, operationId);
    const live = await loadOperation(root, operationId);
    expect(live.candidateRevision!.revision).toBe(base.revision + 1);
    expect(live.candidateRevision!.parentCandidateId).toBe(base.candidateId);

    // RED today: BINDING_STALE. Required post-fix: honor for descendants.
    await verifyOwnerHardProtectionExemption({ operation: live, neededPaths: [specPath], grant, ledger: testLedger(root) });
  });
});

async function hardBlockerViaRepairer(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, hardPath: string) {
  const selection = {
    logicalAgent: "repairer", role: "Repairer", domains: [], runtimeName: "test", runtimeAdapter: "codex",
    paseoProvider: "codex", modelAlias: "test", modelName: "fake", modelId: "fake", transport: "direct",
    skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
    outputContract: "repair-result", args: [], runtimeCapabilities: {},
  } as never;
  const catalog = compileExecutionCatalog({
    runtimes: { test: { adapter: "codex" } },
    models: { test: { runtime: "test", model: "fake" } },
    roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
  });
  return executeRepairerCandidateMutation({
    root, stateRoot: root, operationId, taskId: task.task.id,
    workUnitId: `validation-repair:${operationId}`, phase: "validation-repair",
    config, contract: task, selection, executionCatalog: catalog,
    allowedScope: ["src/**"], forbiddenScope: [],
    prompt: buildRepairPrompt({ version: 1 as const, taskId: task.task.id, attempt: 1, createdAt: new Date().toISOString(), failures: [{ id: "x", category: "dependency", message: "x" }] }),
    execute: async (_ir, participantId) => ({
      provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [], behaviorRepaired: [], validationCommands: [],
        filesNeededOutsideScope: [{ path: hardPath, reason: "hard needed" }],
      })}`,
      stderr: "",
    }),
  });
}
async function approveHardAndGetGrant(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, blocker: import("../src/candidates/repairScope.js").RepairScopeBlockerReceiptV1) {
  const pending = resolveRepairScopeBlockerViaProductChoice({ root, controlRoot: root, operationId, config, contract: task, blocker });
  const approve = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const current = await loadOperation(root, operationId);
      if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
        const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
        await recordControlCenterDecision(root, testLedger(root), {
          operationId, requestId: current.decisionRequest.requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "approve",
        }, "human:control-center:test");
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no suspension");
  })();
  const resolved = await Promise.all([pending, approve]).then(([r]) => r);
  if (resolved.status !== "AMENDED" || !resolved.ownerExemption) throw new Error("expected AMENDED");
  const grant = (await loadOperation(root, operationId)).ownerExemptions?.[resolved.ownerExemption.exemptionId];
  if (!grant) throw new Error("missing grant");
  return { grant, resolved };
}
async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-hnew12-red-"));
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
    intent: "owner exemption test policy",
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
    project: { name: "owner-exemption-test" },
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
