import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  filterForbiddenScopeForAmendment,
  resolveRepairScopeBlockerViaProductChoice,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindOperationCandidateWithAssemblyReceipt,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { isOwnerExemptionLineageDescendant, ownerExemptionStablePolicyDigest } from "../src/security/ownerExemption.js";
import { sha256Canonical } from "../src/core/digest.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  token: process.env.AEH_CONTROLLER_TOKEN,
  epoch: process.env.AEH_CONTROLLER_EPOCH,
};
afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROLLER_TOKEN", originalEnv.token);
  restoreEnv("AEH_CONTROLLER_EPOCH", originalEnv.epoch);
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("H-NEW-12 GREEN: lineage binding threat model", () => {
  it("descendant-of-anchored accepted across two advances (chain walk, not revision numbers)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-DESC-1";
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
    expect(grant.anchoredCandidateId).toBe(`candidate:${operationId}:r1`);
    expect(grant.policyStableDigest).toMatch(/^[a-f0-9]{64}$/);

    // Two normal advances with stable-preserving rebinds.
    await advanceWithReceiptAndRebind(root, operationId, task.task.id);
    await advanceWithReceiptAndRebind(root, operationId, task.task.id);
    const live = await loadOperation(root, operationId);
    expect(live.candidateRevision!.revision).toBe(3);
    // Pure helper proves chain (not revision arithmetic) via controller-durable truth.
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: live.candidateRevision!,
      anchoredCandidateId: grant.anchoredCandidateId,
      anchoredRevision: grant.candidateRevision,
      anchoredIdentityDigest: grant.candidateIdentityDigest,
      expectedOperationId: operationId,
      assemblies: live.candidateAssemblyReceipts,
    })).toBe(true);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: live, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).resolves.toBeDefined();
  });

  it("sibling-branch refused (same parent, different child, same revision number, different digest)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-SIB-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    // Advance to r2-A, rebind, then anchor the grant at r2-A (specific revision).
    await advanceWithReceiptAndRebind(root, operationId, task.task.id);
    const anchoredOp = await loadOperation(root, operationId);
    expect(anchoredOp.candidateRevision!.revision).toBe(2);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, specPath);
    const { grant } = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    expect(grant.candidateRevision).toBe(2);

    // Sibling r2-B: same parent (r1), same revision number (2), same deterministic
    // candidateId (`candidate:op:r2`), DIFFERENT digest (different sourceDigest).
    const base = (await loadOperation(root, operationId)).candidateRevision!;
    // base is r2-A; its parent is r1. Reconstruct r1 id from parent link.
    const r1CandidateId = base.parentCandidateId!;
    const sibling = createCandidateRevisionV1({
      operationId,
      candidateId: base.candidateId,
      projectId: base.projectId,
      taskId: base.taskId,
      revision: base.revision,
      parentCandidateId: r1CandidateId,
      sourceDigest: "d".repeat(64),
      worktree: root,
    });
    expect(sibling.candidateId).toBe(base.candidateId);
    expect(sibling.revision).toBe(base.revision);
    expect(sibling.identityDigest).not.toBe(base.identityDigest);
    // Pure helper: sibling shares parent but is NOT a descendant of r2-A.
    expect(isOwnerExemptionLineageDescendant({
      liveCandidate: sibling,
      anchoredCandidateId: grant.anchoredCandidateId,
      anchoredRevision: grant.candidateRevision,
      anchoredIdentityDigest: grant.candidateIdentityDigest,
      expectedOperationId: operationId,
      assemblies: anchoredOp.candidateAssemblyReceipts,
    })).toBe(false);
    const liveSiblingOp = { ...(await loadOperation(root, operationId)), candidateRevision: sibling };
    await expect(
      verifyOwnerHardProtectionExemption({ operation: liveSiblingOp, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/BINDING_STALE/i);
  });

  it("cross-op replay refused (different lineage root)", async () => {
    const root = await createRepo();
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const opA = "H-NEW-12-XOP-A";
    await saveOwnedOperation(root, {
      version: 1, id: opA, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(opA, root);
    await bindPolicyForCurrentIdentity(root, opA);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const blockerA = await hardBlockerViaRepairer(root, opA, task, config, specPath);
    const { grant } = await approveHardAndGetGrant(root, opA, task, config, blockerA.scopeBlocker!);
    expect(grant.anchoredCandidateId).toBe(`candidate:${opA}:r1`);

    const opB = "H-NEW-12-XOP-B";
    const { saveOperation } = await import("../src/operations/state.js");
    process.env.AEH_OPERATION_ID = opB;
    await saveOperation(root, {
      version: 1, id: opB, kind: "run", status: "RUNNING", phase: "repair", root,
      payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    const operationB = await loadOperation(root, opB);
    expect(operationB.candidateRevision!.candidateId).not.toBe(grant.anchoredCandidateId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: operationB, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/CROSS_OPERATION/i);
  });

  it("post-epoch-takeover refused (epoch check retained)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-EPOCH-1";
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
    const epochBefore = grant.controllerEpoch;
    await claimControllerEpoch(root, operationId, `controller:takeover:${operationId}`);
    const live = await loadOperation(root, operationId);
    expect(currentControllerEpoch(live)).toBe(epochBefore + 1);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: live, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/EPOCH_STALE/i);
  });

  it("expired refused (grant + decision expiry retained)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-EXP-1";
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
    const operation = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({
        operation, neededPaths: [specPath], grant, ledger: testLedger(root),
        now: new Date(Date.now() + 30 * 24 * 3_600_000),
      }),
    ).rejects.toThrow(/EXPIRED/i);
  });

  it("stable-config drift kills the grant (exact digest dropped, stable retained)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-STABLE-1";
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
    await advanceWithReceiptAndRebind(root, operationId, task.task.id);
    // Drift the STABLE config (different intent) on top of a new descendant:
    // advance once more (clears the policy, increments execution revision),
    // then bind a drifted policy for the new candidate. Lineage + epoch still
    // match, but stable must kill the grant.
    const beforeDrift = await loadOperation(root, operationId);
    const driftBase = beforeDrift.candidateRevision!;
    const driftCandidate = createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r${driftBase.revision + 1}`,
      projectId: driftBase.projectId,
      taskId: driftBase.taskId,
      revision: driftBase.revision + 1,
      parentCandidateId: driftBase.candidateId,
      sourceDigest: driftBase.sourceDigest,
      worktree: root,
    });
    await bindOperationCandidateWithAssemblyReceipt(root, operationId, {
      baseCandidate: driftBase,
      candidate: driftCandidate,
      changeSet: {
        operationId,
        taskId: task.task.id,
        workUnitId: `validation-repair:${operationId}:lineage-drift-advance`,
        participantId: "participant:lineage-drift",
        baseCandidateRevision: driftBase.revision,
        baseCandidateDigest: driftBase.identityDigest,
        patchDigest: "c".repeat(64),
      },
    });
    const drifted = await loadOperation(root, operationId);
    const candidate = drifted.candidateRevision!;
    const driftedPolicy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: drifted.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(drifted),
      intent: "drifted intent (stable change must kill grant)",
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
    expect(ownerExemptionStablePolicyDigest(driftedPolicy)).not.toBe(grant.policyStableDigest);
    await bindResolvedOperationPolicy(root, operationId, driftedPolicy);
    const live = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: live, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/BINDING_STALE/i);
  });

  it("sync filter honors descendants and refuses siblings (same lineage + stable gate)", async () => {
    const root = await createRepo();
    const operationId = "H-NEW-12-SYNC-1";
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
    const { grant, resolved } = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    await advanceWithReceiptAndRebind(root, operationId, task.task.id);
    const live = await loadOperation(root, operationId);
    const { repairHardProtectedPaths } = await import("../src/candidates/repairScope.js");
    const hardProtected = repairHardProtectedPaths(config, task);
    // Descendant: sync gate covers (provenance-bound: durable + parent-linked).
    const descendantScope = {
      grant,
      operationId: live.id,
      controllerEpoch: currentControllerEpoch(live),
      candidateRevision: live.candidateRevision!.revision,
      candidateIdentityDigest: live.candidateRevision!.identityDigest,
      candidateId: live.candidateRevision!.candidateId,
      candidateParentCandidateId: live.candidateRevision!.parentCandidateId,
      policyStableDigest: ownerExemptionStablePolicyDigest(live.resolvedOperationPolicy!),
      assemblies: live.candidateAssemblyReceipts,
      terminal: false,
    };
    expect(() =>
      filterForbiddenScopeForAmendment(hardProtected, resolved.amendment as never, hardProtected, descendantScope as never),
    ).not.toThrow();
    // Sibling at same revision as live (same parent r-chain, different digest): refused.
    const sibling = createCandidateRevisionV1({
      operationId,
      candidateId: live.candidateRevision!.candidateId,
      projectId: live.candidateRevision!.projectId,
      taskId: live.candidateRevision!.taskId,
      revision: live.candidateRevision!.revision,
      parentCandidateId: live.candidateRevision!.parentCandidateId!,
      sourceDigest: "e".repeat(64),
      worktree: root,
    });
    const siblingScope = { ...descendantScope, candidateIdentityDigest: sibling.identityDigest };
    expect(() =>
      filterForbiddenScopeForAmendment(hardProtected, resolved.amendment as never, hardProtected, siblingScope as never),
    ).toThrow(/NON_EXEMPTIBLE/i);
    void sha256Canonical;
  });
});

async function advanceWithReceiptAndRebind(root: string, operationId: string, taskId: string): Promise<void> {
  const current = await loadOperation(root, operationId);
  const base = current.candidateRevision!;
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
      taskId,
      workUnitId: `validation-repair:${operationId}:lineage-advance-r${advanced.revision}`,
      participantId: "participant:lineage-advance",
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      patchDigest: "c".repeat(64),
    },
  });
  await bindPolicyForCurrentIdentity(root, operationId);
}

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-hnew12-green-"));
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
