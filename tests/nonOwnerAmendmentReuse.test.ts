import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  createRepairScopeBlockerReceipt,
  listRepairScopeAmendments,
  resolveRepairScopeBlockerViaProductChoice,
  writeRepairScopeBlockerReceipt,
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

/**
 * D12 (HIGH liveness, fail-closed) regression: a durable NON-OWNER scope
 * amendment (regular product-choice channel: amendable manifests + H-NEW-13
 * new-test tier, incl. delegated approvals) must be reused by later blockers
 * on the SAME covered paths instead of dying at the per-task cap.
 *
 * Live: op CHANGE-20261016T111657Z-c92a9466 — delegated approval created
 * amendment-1 for tests/range.spec.js (new-test tier, decidedActor
 * delegate:cert-director, no ownerExemption by design), yet a later
 * repairer blocking on the SAME file went BLOCKED/terminal citing the
 * "lead-approved amendment" check. Before the fix the non-hard branch of
 * resolveRepairScopeBlockerViaProductChoice enforced the cap without
 * consulting durable non-owner amendments (only the H-NEW-14 owner helper
 * ran, and only in the hard branch).
 *
 * Mechanism: DETERMINISTIC throughout. Blockers are built directly via the
 * canonical receipt constructor (no providers); approvals use the
 * in-process control-center decision writer like the existing suites.
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

describe("D12 non-owner amendment reuse for later blockers", () => {
  it("(a) second blocker on the already-exempted new-test path reuses the durable non-owner amendment", async () => {
    const root = await createRepo();
    const operationId = "D12-REUSE-NONOWNER-1";
    const task = contract("D12-REUSE-NONOWNER-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-reuse-new.spec.js";
    const first = await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-first");
    // Non-owner channel proof: the durable amendment carries no
    // ownerExemption (delegated-or-human product-choice approval only).
    expect(first.amendment.ownerExemption).toBeUndefined();
    expect(first.amendment.exemptedPaths).toEqual([covered]);

    // H-NEW-13 race honesty lock-in: the retry created the file, so it
    // EXISTS now — a stat-based tier check would misclassify it as hard and
    // refuse reuse. Reuse must trust the amendment-time tier without stat.
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, covered), "it('covers range', () => {});\n");

    // The live shape: a later phase runs with the ORIGINAL contract (the
    // amendment was never threaded in) and blocks on the SAME file.
    const secondBlocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-second",
      filesNeededOutsideScope: [{ path: covered, reason: "later repairer needs the same covered new-test file" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, secondBlocker);
    const second = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: secondBlocker,
      timeoutMs: 2000, pollMs: 25,
    });
    expect(second.status).toBe("AMENDED");
    if (second.status !== "AMENDED") throw new Error("expected AMENDED-reuse");
    // Reuse shape: the EXISTING amendment, the UNCHANGED input contract
    // (same reference — no rewrite), flagged as a reuse.
    expect(second.amendment.amendmentDigest).toBe(first.amendment.amendmentDigest);
    expect(second.contract).toBe(task);
    expect(second.reused).toBe(true);
    expect(second.ownerExemption).toBeUndefined();
    // Cap-stable: no second suspension opened, no new artifact written.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(b) second blocker on a DISTINCT hard path stays BLOCKED (cap preserved, owner flow untouched)", async () => {
    const root = await createRepo();
    const operationId = "D12-DISTINCT-HARD-1";
    const task = contract("D12-DISTINCT-HARD-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    await amendViaApproval(root, operationId, task, config, "tests/d12-distinct-new.spec.js", "validation-repair:d12-first");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);

    // DISTINCT hard path (explicit spec source — hard even though new):
    // reuse must not cover it, and with no anchored owner grant the hard
    // branch hits the per-task cap WITHOUT suspending.
    const hardPath = `specs/changes/${task.task.id}/spec.md`;
    const secondBlocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-distinct",
      filesNeededOutsideScope: [{ path: hardPath, reason: "distinct hard path needs owner approval" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, secondBlocker);
    const second = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: secondBlocker,
      timeoutMs: 2000, pollMs: 25,
    });
    expect(second.status).toBe("BLOCKED");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(c) tampered amendment artifact (edited exemptedPaths breaking the digest) is ignored — no reuse, fail-closed", async () => {
    const root = await createRepo();
    const operationId = "D12-TAMPERED-1";
    const task = contract("D12-TAMPERED-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-tampered-new.spec.js";
    await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-first");
    // Tamper: edit exemptedPaths without recomputing the digest (digest now
    // mismatches the typed claims — assertRepairScopeAmendment must fail).
    const [stored] = await listRepairScopeAmendments(root, config, task.task.id);
    const tampered = { ...stored, exemptedPaths: ["tests/d12-evil.spec.js"] };
    await fs.writeFile(path.join(root, stored!.amendmentPath), `${JSON.stringify(tampered, null, 2)}\n`);

    const secondBlocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-second",
      filesNeededOutsideScope: [{ path: covered, reason: "later repairer needs the covered new-test file" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, secondBlocker);
    // Fail-closed: the tampered artifact is ignored for reuse AND breaks
    // the cap scan, so the resolver throws before any suspension — the
    // production caller maps this throw to BLOCKED citing the blocker (the
    // same mapping as every other resolver throw).
    await expect(resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: secondBlocker,
      timeoutMs: 2000, pollMs: 25,
    })).rejects.toThrow(/amendment|digest/i);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(d) amendments for another task or operation are ignored", async () => {
    const root = await createRepo();
    const operationId = "D12-SCOPED-1";
    const taskA = contract("D12-SCOPED-A");
    const taskB = contract("D12-SCOPED-B");
    const config = projectConfig();
    await writeContractAndSeal(root, config, taskA);
    await writeContractAndSeal(root, config, taskB);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: taskA.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-scoped-new.spec.js";
    await amendViaApproval(root, operationId, taskA, config, covered, "validation-repair:d12-first");

    // Another task, same path, same op: task B has no amendment, so the
    // resolver must take the suspend path (a reuse would have returned
    // AMENDED without suspending). Timeout leaves BLOCKED with the
    // suspension held for a human decision within expiry.
    const crossTaskBlocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: taskB.task.id,
      workUnitId: "validation-repair:d12-cross-task",
      filesNeededOutsideScope: [{ path: covered, reason: "task B needs the same path" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, crossTaskBlocker);
    const crossTask = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: taskB, blocker: crossTaskBlocker,
      timeoutMs: 500, pollMs: 25,
    });
    expect(crossTask.status).toBe("BLOCKED");
    expect((await loadOperation(root, operationId)).phase).toBe("HUMAN_REQUIRED");
    expect(await listRepairScopeAmendments(root, config, taskB.task.id)).toHaveLength(0);
    expect(await listRepairScopeAmendments(root, config, taskA.task.id)).toHaveLength(1);

    // Another operation, same task+path: the op-binding guard refuses reuse;
    // the per-task cap then holds BLOCKED without a second suspension. The
    // operation is still parked in the task-B suspension, which also proves
    // no new suspension was opened for this forged-op blocker.
    const crossOpBlocker = createRepairScopeBlockerReceipt({
      operationId: "OP-D12-FOREIGN",
      taskId: taskA.task.id,
      workUnitId: "validation-repair:d12-cross-op",
      filesNeededOutsideScope: [{ path: covered, reason: "foreign op cites the covered path" }],
    });
    const crossOp = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: taskA, blocker: crossOpBlocker,
      timeoutMs: 500, pollMs: 25,
    });
    expect(crossOp.status).toBe("BLOCKED");
    expect(await listRepairScopeAmendments(root, config, taskA.task.id)).toHaveLength(1);
  });
});

/** First-blocker approve flow: suspend/record/await → AMENDED (mirrors the repairScopeReplan budget test). */
async function amendViaApproval(
  root: string,
  operationId: string,
  task: TaskContract,
  config: HarnessProjectConfig,
  testPath: string,
  workUnitId: string,
): Promise<{ contract: TaskContract; amendment: { amendmentDigest: string; exemptedPaths: string[]; ownerExemption?: unknown; amendmentPath: string } }> {
  const blocker = createRepairScopeBlockerReceipt({
    operationId,
    taskId: task.task.id,
    workUnitId,
    filesNeededOutsideScope: [{ path: testPath, reason: "new test coverage requires creating this file" }],
  });
  await writeRepairScopeBlockerReceipt(root, config, blocker);
  const pending = resolveRepairScopeBlockerViaProductChoice({ root, controlRoot: root, operationId, config, contract: task, blocker });
  const approve = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const current = await loadOperation(root, operationId);
      if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
        const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
        const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
        await recordControlCenterDecision(root, ledger, {
          operationId, requestId: current.decisionRequest.requestId,
          choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "approve exact new-test set",
        }, "human:control-center:test");
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("suspension never appeared for D12 setup approval");
  })();
  const resolved = await Promise.all([pending, approve]).then(([r]) => r);
  expect(resolved.status).toBe("AMENDED");
  if (resolved.status !== "AMENDED") throw new Error("expected AMENDED in D12 setup");
  return { contract: resolved.contract, amendment: resolved.amendment };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d12-nonowner-reuse-"));
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
    intent: "d12 non-owner-reuse test policy",
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
    project: { name: "d12-nonowner-reuse-test" },
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
