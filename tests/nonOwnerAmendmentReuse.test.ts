import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  applyReusableNonOwnerAmendmentForBlocker,
  createRepairScopeBlockerReceipt,
  listRepairScopeAmendments,
  loadAmendedContractForReuse,
  resolveRepairScopeBlockerViaProductChoice,
  writeRepairScopeBlockerReceipt,
} from "../src/candidates/repairScope.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
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
    // Reuse shape (D12 P1): the EXISTING amendment, flagged as a reuse, with
    // the LOADED persisted amended contract — never the caller's stale one.
    expect(second.amendment.amendmentDigest).toBe(first.amendment.amendmentDigest);
    expect(second.reused).toBe(true);
    expect(second.ownerExemption).toBeUndefined();
    expect(second.contract).not.toBe(task);
    expect(second.contract.scope?.allowed).toContain(covered);
    const { default: YAML } = await import("yaml");
    const persisted = YAML.parse(
      await fs.readFile(path.join(root, ".harness", "contracts", `${task.task.id}.yaml`), "utf8"),
    ) as TaskContract;
    expect(second.contract).toEqual(persisted);
    // Cap-stable: no second suspension opened, no new artifact written.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");

    // P1 retry proof (mirrors the D4/protection-tier retry mechanics): the
    // retry assembly requires every exempted path in the RETRY contract's
    // allowlist (repair.ts REPAIR_SCOPE_AMENDMENT_NOT_SEALED), so only the
    // loaded amended contract backs a successful retry. Remove the
    // race-created file first so the workspace digest is restored (the
    // proven protection-tier pattern), then retry through the amendment path.
    await fs.rm(path.join(root, covered), { force: true });
    const { selection, catalog } = repairerBinding();
    // Negative control: the stale caller contract (pre-amendment allowlist)
    // cannot back the same retry — the assembly fails closed NOT_SEALED.
    // This is the exact pre-fix failure mode (reuse returned the caller's
    // contract): with the stale contract the retry dies here.
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:d12-retry-stale", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: task.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        scopeAmendment: second.amendment,
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.mkdir(path.dirname(path.join(isolatedRoot, covered)), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, covered), "it('covers range', () => {});\n// d12 stale control\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/NOT_SEALED/);
    const retry = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:d12-retry-proof", phase: "validation-repair",
      config, contract: second.contract, selection, executionCatalog: catalog,
      allowedScope: second.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      scopeAmendment: second.amendment,
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.mkdir(path.dirname(path.join(isolatedRoot, covered)), { recursive: true });
        await fs.writeFile(path.join(isolatedRoot, covered), "it('covers range', () => {});\n// d12 amended retry\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(covered);
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

  it("(h) forged amendment citing an alternate same-task contract is refused even with a recomputed digest (Luna D12 round 2)", async () => {
    const root = await createRepo();
    const operationId = "D12-ALT-CONTRACT-1";
    const task = contract("D12-ALT-CONTRACT-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-alt-new.spec.js";
    await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-first");
    const [stored] = await listRepairScopeAmendments(root, config, task.task.id);
    // Forge: same task id, broader allowlist, digest recomputed so the
    // artifact is self-consistent — only the canonical-path gate stands.
    const altRelative = ".harness/alt-contracts/D12-ALT-CONTRACT-1.yaml";
    const altBody = { ...task, scope: { ...(task.scope ?? {}), allowed: ["**"] } };
    await fs.mkdir(path.join(root, ".harness", "alt-contracts"), { recursive: true });
    const { default: YAML } = await import("yaml");
    await fs.writeFile(path.join(root, altRelative), YAML.stringify(altBody));
    const { amendmentDigest: _dropped, ...unsigned } = stored!;
    const forged = { ...unsigned, contractPath: altRelative };
    const forgedRecord = { ...forged, amendmentDigest: sha256Canonical(forged) };
    await fs.writeFile(path.join(root, stored!.amendmentPath), `${JSON.stringify(forgedRecord, null, 2)}\n`);

    expect(await loadAmendedContractForReuse(root, config, forgedRecord as never)).toBeUndefined();
  });

  it("(i) symlink escape in the cited contract path is refused (Luna D12 round 2)", async () => {
    const root = await createRepo();
    const operationId = "D12-SYMLINK-1";
    const task = contract("D12-SYMLINK-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-symlink-new.spec.js";
    await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-first");
    const [stored] = await listRepairScopeAmendments(root, config, task.task.id);
    // Swap the canonical contract file for a symlink pointing outside root.
    // The cited path string stays canonical, so only realpath containment
    // can refuse it.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d12-outside-"));
    roots.push(outside);
    const { default: YAML } = await import("yaml");
    await fs.writeFile(path.join(outside, "evil.yaml"), YAML.stringify({ ...task, scope: { allowed: ["**"] } }));
    const canonicalFile = path.join(root, stored!.contractPath);
    await fs.rm(canonicalFile, { force: true });
    await fs.symlink(path.join(outside, "evil.yaml"), canonicalFile);

    expect(await loadAmendedContractForReuse(root, config, stored!)).toBeUndefined();
  });

  it("(j) post-seal contract tampering is refused by the seal gate (Luna D12 round 2)", async () => {
    const root = await createRepo();
    const operationId = "D12-SEAL-1";
    const task = contract("D12-SEAL-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-seal-new.spec.js";
    await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-first");
    const [stored] = await listRepairScopeAmendments(root, config, task.task.id);
    // Tamper the persisted contract file after sealing (widen allowlist):
    // bytes no longer match the frozen seal, so the loader must refuse even
    // though task id + allowlist membership would otherwise pass.
    const { default: YAML } = await import("yaml");
    const contractFile = path.join(root, stored!.contractPath);
    const onDisk = YAML.parse(await fs.readFile(contractFile, "utf8")) as TaskContract;
    await fs.writeFile(contractFile, YAML.stringify({ ...onDisk, scope: { ...(onDisk.scope ?? {}), allowed: ["**"] } }));

    expect(await loadAmendedContractForReuse(root, config, stored!)).toBeUndefined();
  });

  it("(d) amendments for another task or operation are ignored", async () => {    const root = await createRepo();
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

/**
 * D12 P2 call-site coverage note: run.ts (amended-retry second-blocker
 * honor) and reviewLifecycle.ts (review-remediation honor) adopt the
 * wrapper's AMENDED contract through the IDENTICAL code path as the existing
 * owner-honored handling (same contract adoption, same retry-once
 * mechanics, same event shapes with a non-owner source marker); any
 * non-AMENDED wrapper outcome falls into the pre-existing BLOCKED branch
 * untouched. The only new decision logic at those sites is this wrapper
 * (find + load), covered directly here; the shared loader + real retry
 * mechanics are proven end-to-end by test (a) above. A full run.ts
 * repair-loop run is not unit-reachable (provider-backed turns), so
 * wrapper-direct coverage is the precise unit boundary — call-site behavior
 * follows by construction (mechanical adoption of the wrapper result).
 */
describe("D12 applyReusableNonOwnerAmendmentForBlocker (second-blocker call sites)", () => {
  it("(e) covered second blocker returns AMENDED with the loaded amended contract", async () => {
    const root = await createRepo();
    const operationId = "D12-WRAPPER-REUSE-1";
    const task = contract("D12-WRAPPER-REUSE-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-wrapper-reuse.spec.js";
    const first = await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-wrapper-first");
    // The live shape again: the caller still holds the ORIGINAL contract.
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-wrapper-second",
      filesNeededOutsideScope: [{ path: covered, reason: "second blocker needs the same covered new-test file" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await applyReusableNonOwnerAmendmentForBlocker({
      root, controlRoot: root, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED reuse");
    expect(resolved.amendment.amendmentDigest).toBe(first.amendment.amendmentDigest);
    expect(resolved.reused).toBe(true);
    expect(resolved.contract).not.toBe(task);
    expect(resolved.contract.scope?.allowed).toContain(covered);
    const { default: YAML } = await import("yaml");
    const persisted = YAML.parse(
      await fs.readFile(path.join(root, ".harness", "contracts", `${task.task.id}.yaml`), "utf8"),
    ) as TaskContract;
    expect(resolved.contract).toEqual(persisted);
    // Consult-only: no suspension opened, no new artifact written.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(f) distinct-path blocker returns NO_COVERING_GRANT (no suspension, no artifact)", async () => {
    const root = await createRepo();
    const operationId = "D12-WRAPPER-MISS-1";
    const task = contract("D12-WRAPPER-MISS-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    await amendViaApproval(root, operationId, task, config, "tests/d12-wrapper-miss.spec.js", "validation-repair:d12-wrapper-first");
    const hardPath = `specs/changes/${task.task.id}/spec.md`;
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-wrapper-distinct",
      filesNeededOutsideScope: [{ path: hardPath, reason: "distinct hard path needs owner approval" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await applyReusableNonOwnerAmendmentForBlocker({
      root, controlRoot: root, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("NO_COVERING_GRANT");
    if (resolved.status !== "NO_COVERING_GRANT") throw new Error("expected NO_COVERING_GRANT");
    expect(resolved.failures.length).toBeGreaterThan(0);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(g) unverifiable persisted contract (exempted path outside the persisted allowlist) returns NO_COVERING_GRANT", async () => {
    const root = await createRepo();
    const operationId = "D12-WRAPPER-DRIFT-1";
    const task = contract("D12-WRAPPER-DRIFT-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d12-wrapper-drift.spec.js";
    await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d12-wrapper-first");
    // Drift the persisted contract: drop the exempted path from the
    // allowlist (the loader's exact-membership gate must refuse it).
    const { default: YAML } = await import("yaml");
    const contractFile = path.join(root, ".harness", "contracts", `${task.task.id}.yaml`);
    const persisted = YAML.parse(await fs.readFile(contractFile, "utf8")) as TaskContract;
    expect(persisted.scope?.allowed).toContain(covered);
    await fs.writeFile(
      contractFile,
      YAML.stringify({ ...persisted, scope: { ...(persisted.scope ?? {}), allowed: ["src/**"] } }),
    );
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:d12-wrapper-second",
      filesNeededOutsideScope: [{ path: covered, reason: "second blocker needs the covered new-test file" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await applyReusableNonOwnerAmendmentForBlocker({
      root, controlRoot: root, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("NO_COVERING_GRANT");
    if (resolved.status !== "NO_COVERING_GRANT") throw new Error("expected NO_COVERING_GRANT");
    expect(resolved.failures.join(" ")).toMatch(/UNVERIFIED/);
    expect((await loadOperation(root, operationId)).phase).not.toBe("HUMAN_REQUIRED");
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

function packet(taskId: string) {
  return {
    version: 1 as const,
    taskId,
    attempt: 1,
    createdAt: new Date().toISOString(),
    failures: [{ id: "d12.reuse", category: "scope", message: "needs covered path" }],
  };
}

function repairerBinding() {
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
  return { selection, catalog };
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
