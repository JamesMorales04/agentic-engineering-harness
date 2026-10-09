import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  applyAnchoredCoveringGrantForBlocker,
  createRepairScopeBlockerReceipt,
  listRepairScopeAmendments,
  resolveRepairScopeBlockerViaProductChoice,
  writeRepairScopeBlockerReceipt,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

/**
 * H-NEW-14 (grant consumption coverage) RED-first.
 *
 * LIVE-PROVEN context: suspend fired → Owner approved 2 paths → grant
 * ANCHORED (operation.owner-exemption.anchored) → resumed → work proceeded →
 * terminal FAILED with repair.scope-blocker citing a GRANTED file, and NO
 * amendment event exists. The anchored grant was never consumed.
 *
 * Forensics verdict under test here:
 * - resolveRepairScopeBlockerViaProductChoice IS grant-aware on first use,
 *   but a SECOND same-task blocker on already-granted paths throws the
 *   per-task cap (BUDGET) instead of reusing the anchored grant + durable
 *   amendment (no second suspension, no new artifact).
 * - Wave-barrier (run.ts), post-amendment second-blocker (run.ts), and
 *   review-remediation (reviewLifecycle.ts) enforcement points never consult
 *   operation.ownerExemptions at all — they go validation-BLOCKED instead of
 *   the amendment/apply path. The shared consult-only honor helper
 *   (applyAnchoredCoveringGrantForBlocker: find covering grant + reuse-or-apply,
 *   never suspend/mint/consume) is the grant-aware route those sites must use.
 */

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

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("H-NEW-14 grant consumption coverage (RED-first)", () => {
  it("resolver reuses the anchored grant for a second same-task blocker (no second suspend, no cap throw)", async () => {
    const root = await createRepo();
    const operationId = "GRANT-CONSUME-REUSE-1";
    const task = contract("GRANT-REUSE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const hardPath = "specs/changes/GRANT-REUSE/spec.md";
    const first = await hardBlockerViaRepairer(root, operationId, task, config, hardPath);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: first.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "owner approves exact hard set");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected first AMENDED");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);

    // Second blocker on the SAME granted path, new work unit (post-resume work).
    // Must honor via the anchored grant + durable amendment, never suspend again
    // and never throw the per-task cap.
    const second = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:reuse-second",
      filesNeededOutsideScope: [{ path: hardPath, reason: "still needs the granted hard path" }],
    });
    const reused = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: resolved.contract, blocker: second,
      timeoutMs: 500, pollMs: 25,
    });
    expect(reused.status).toBe("AMENDED");
    if (reused.status !== "AMENDED") throw new Error("expected reused AMENDED, grant must be consumed not re-suspended");
    expect(reused.amendment.exemptedPaths).toContain(hardPath);
    // Reuse persists no second artifact (cap-stable) and the operation never
    // re-suspended for the same granted paths.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    const after = await loadOperation(root, operationId);
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
  });

  it("consult-only honor applies the anchored grant to a wave-style blocker (no suspend, no mint)", async () => {
    const root = await createRepo();
    const operationId = "GRANT-CONSUME-WAVE-1";
    const taskA = contract("GRANT-WAVE-A");
    const taskB = contract("GRANT-WAVE-B");
    const config = projectConfig();
    await writeContractAndSeal(root, config, taskA);
    await writeContractAndSeal(root, config, taskB);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: taskA.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    // One suspend approving both exact paths mints one grant covering both.
    const sealA = "specs/changes/GRANT-WAVE-A/spec.md";
    const sealB = "specs/changes/GRANT-WAVE-B/spec.md";
    const blockerBoth = createRepairScopeBlockerReceipt({
      operationId, taskId: taskA.task.id, workUnitId: "validation-repair:wave-both",
      filesNeededOutsideScope: [{ path: sealA, reason: "a" }, { path: sealB, reason: "b" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blockerBoth);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: taskA, blocker: blockerBoth,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "both seals");
    const firstBoth = await Promise.all([pending, approve]).then(([r]) => r);
    expect(firstBoth.status).toBe("AMENDED");
    if (firstBoth.status !== "AMENDED") throw new Error("expected AMENDED");
    const grantCountBefore = Object.keys((await loadOperation(root, operationId)).ownerExemptions ?? {}).length;
    expect(grantCountBefore).toBe(1);

    // Wave-barrier style blocker for the second task citing its granted path.
    // The wave enforcement point must honor (amendment/apply path), never go
    // validation-BLOCKED while a valid grant covers, and must never mint.
    const waveBlocker = createRepairScopeBlockerReceipt({
      operationId, taskId: taskB.task.id, workUnitId: "wave:wu-b",
      filesNeededOutsideScope: [{ path: sealB, reason: "wave unit needs granted seal" }],
    });
    const honored = await applyAnchoredCoveringGrantForBlocker({
      root, controlRoot: root, config, contract: taskB, blocker: waveBlocker,
    });
    expect(honored.status).toBe("AMENDED");
    if (honored.status !== "AMENDED") throw new Error("wave blocker must honor the anchored grant");
    expect(honored.reused).toBe(false);
    expect(honored.amendment.exemptedPaths).toContain(sealB);
    expect(honored.contract.scope?.allowed).toContain(sealB);
    expect(await listRepairScopeAmendments(root, config, taskB.task.id)).toHaveLength(1);
    // Consult-only: no second grant minted, no suspension for the honored path.
    const after = await loadOperation(root, operationId);
    expect(Object.keys(after.ownerExemptions ?? {}).length).toBe(grantCountBefore);
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
  });

  it("consult-only honor reuses the durable amendment under cap (no new artifact, no mint)", async () => {
    const root = await createRepo();
    const operationId = "GRANT-CONSUME-REUSE-2";
    const task = contract("GRANT-REUSE-2");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const hardPath = "specs/changes/GRANT-REUSE-2/spec.md";
    const first = await hardBlockerViaRepairer(root, operationId, task, config, hardPath);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: first.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "approve");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    const grantCountBefore = Object.keys((await loadOperation(root, operationId)).ownerExemptions ?? {}).length;

    const second = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "repair:second-same-task",
      filesNeededOutsideScope: [{ path: hardPath, reason: "post-resume work still needs it" }],
    });
    const honored = await applyAnchoredCoveringGrantForBlocker({
      root, controlRoot: root, config, contract: resolved.contract, blocker: second,
    });
    expect(honored.status).toBe("AMENDED");
    if (honored.status !== "AMENDED") throw new Error("same-task second blocker must reuse the anchored grant");
    expect(honored.reused).toBe(true);
    expect(honored.amendment.exemptedPaths).toContain(hardPath);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect(Object.keys((await loadOperation(root, operationId)).ownerExemptions ?? {}).length).toBe(grantCountBefore);
  });

  it("partial coverage is never partially honored (steered blocker stays unconsumed)", async () => {
    const root = await createRepo();
    const operationId = "GRANT-CONSUME-PARTIAL-1";
    const task = contract("GRANT-PARTIAL");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const hardPath = "specs/changes/GRANT-PARTIAL/spec.md";
    const first = await hardBlockerViaRepairer(root, operationId, task, config, hardPath);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: first.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "approve");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");

    const steered = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "repair:steered",
      filesNeededOutsideScope: [
        { path: hardPath, reason: "granted" },
        { path: ".harness/project.yaml", reason: "steered beyond the grant" },
      ],
    });
    const honored = await applyAnchoredCoveringGrantForBlocker({
      root, controlRoot: root, config, contract: resolved.contract, blocker: steered,
    });
    expect(honored.status).toBe("NO_COVERING_GRANT");
  });
});

async function approveWaitingRequest(root: string, operationId: string, choiceId: string, reason: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const current = await loadOperation(root, operationId);
    if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
      const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
      const ledger = testLedger(root);
      await recordControlCenterDecision(root, ledger, {
        operationId, requestId: current.decisionRequest.requestId, choiceId, reason,
      }, "human:control-center:test");
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("suspension never appeared for hard blocker");
}

async function hardBlockerViaRepairer(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, hardPath: string) {
  const selection = repairerSelection();
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
    prompt: buildRepairPrompt(packet(task.task.id)),
    execute: async (_ir, participantId) => ({
      provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [], behaviorRepaired: [], validationCommands: [],
        filesNeededOutsideScope: [{ path: hardPath, reason: "hard path needed" }],
      })}`,
      stderr: "",
    }),
  });
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-grant-consume-"));
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
    intent: "grant consume test policy",
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
    project: { name: "grant-consume-test" },
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

function repairerSelection(): AgentExecutionSelection {
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

