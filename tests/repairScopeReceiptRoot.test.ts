import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRepairScopeBlockerReceipt,
  repairScopeBlockerReceiptPath,
  writeRepairScopeBlockerReceipt,
} from "../src/candidates/repairScope.js";
import { resolveOperationStateRoot } from "../src/operations/state.js";

const savedEnv: Record<string, string | undefined> = {};
for (const key of ["AEH_OPERATION_STATE_REDIRECT", "AEH_OPERATION_ID", "AEH_CONTROL_ROOT"]) {
  savedEnv[key] = process.env[key];
}
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * RED-first regression for the LIVE-PROVEN receipt-root divergence
 * (op CHANGE-20261009T001827Z-9d496bda rev 100-111):
 * the correction-turn write (repair.ts ~L349, input.stateRoot = runTask
 * controlRoot = executionRoot/isolated worktree) and the suspend read
 * (repairScope.ts ~L1478-1483, resolveOperationStateRoot(controlRoot) =
 * durable AEH_CONTROL_ROOT) resolved DIFFERENT roots, so
 * suspendHardRepairScopeForProductChoice failed RECEIPT_MISSING while the
 * receipt survived only as a workspace-evidence snapshot copy.
 */
describe("repair scope blocker receipt canonical durable root", () => {
  it("write-then-read through the REAL call chain finds the receipt when executionRoot != durableRoot", async () => {
    const executionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-exec-"));
    const durableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-durable-"));
    try {
      const operationId = `OP-TEST-${Date.now()}`;
      const taskId = `TASK-TEST-${Date.now()}`;
      process.env.AEH_OPERATION_STATE_REDIRECT = "1";
      process.env.AEH_OPERATION_ID = operationId;
      process.env.AEH_CONTROL_ROOT = durableRoot;

      const config = { project: { name: "receipt-root-test" } } as any;
      const blocker = createRepairScopeBlockerReceipt({
        operationId,
        taskId,
        workUnitId: `repair:${taskId}:1`,
        participantId: "participant:test",
        filesNeededOutsideScope: [{ path: "src/outside/file.ts", reason: "needs an out-of-scope fix" }],
      });

      // (a) correction-turn write site: writeRepairScopeBlockerReceipt(input.stateRoot, ...)
      // where input.stateRoot = runTask controlRoot = path.resolve(executionRoot).
      const writeRoot = path.resolve(executionRoot);
      const receiptFile = await writeRepairScopeBlockerReceipt(writeRoot, config, blocker);

      // (b) suspend read site: stateRoot = resolveOperationStateRoot(controlRoot),
      // receiptFile = repairScopeBlockerReceiptPath(stateRoot, config, blocker.taskId, blocker.workUnitId).
      const controlRoot = path.resolve(executionRoot);
      const readStateRoot = resolveOperationStateRoot(controlRoot);
      const readFile = repairScopeBlockerReceiptPath(readStateRoot, config, blocker.taskId, blocker.workUnitId);

      // The SINGLE canonical durable root: write and read must agree.
      expect(readFile).toBe(receiptFile);
      const content = await fs.readFile(readFile, "utf8").catch(() => undefined);
      expect(content, "suspend read must find the correction-turn write (no RECEIPT_MISSING)").toBeDefined();
      expect(JSON.parse(content!).digest).toBe(blocker.digest);
    } finally {
      await fs.rm(executionRoot, { recursive: true, force: true });
      await fs.rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("no behavior change when roots already agree (no redirect)", async () => {
    delete process.env.AEH_OPERATION_STATE_REDIRECT;
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-agree-"));
    try {
      const config = { project: { name: "receipt-root-agree" } } as any;
      const blocker = createRepairScopeBlockerReceipt({
        operationId: "OP-AGREE",
        taskId: "TASK-AGREE",
        workUnitId: "repair:TASK-AGREE:1",
        filesNeededOutsideScope: [{ path: "src/outside/other.ts", reason: "out of scope" }],
      });
      const receiptFile = await writeRepairScopeBlockerReceipt(root, config, blocker);
      expect(receiptFile).toBe(repairScopeBlockerReceiptPath(root, config, blocker.taskId, blocker.workUnitId));
      expect(receiptFile).toBe(path.join(root, ".harness", "repairs", "TASK-AGREE-scope-blocker-repair-TASK-AGREE-1.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("planner and repairer receipts for the same task do not collide (namespaced by workUnitId)", async () => {
    delete process.env.AEH_OPERATION_STATE_REDIRECT;
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-collide-"));
    try {
      const config = { project: { name: "receipt-collide" } } as any;
      const plannerBlocker = createRepairScopeBlockerReceipt({
        operationId: "OP-COLLIDE",
        taskId: "TASK-COLLIDE",
        workUnitId: "planner:TASK-COLLIDE",
        filesNeededOutsideScope: [{ path: "package-lock.json", reason: "planner needs manifest" }],
      });
      const repairerBlocker = createRepairScopeBlockerReceipt({
        operationId: "OP-COLLIDE",
        taskId: "TASK-COLLIDE",
        workUnitId: "wu-1",
        filesNeededOutsideScope: [{ path: "package.json", reason: "repairer needs manifest" }],
      });
      const plannerFile = repairScopeBlockerReceiptPath(root, config, plannerBlocker.taskId, plannerBlocker.workUnitId);
      const repairerFile = repairScopeBlockerReceiptPath(root, config, repairerBlocker.taskId, repairerBlocker.workUnitId);
      expect(plannerFile).not.toBe(repairerFile);
      const writtenPlanner = await writeRepairScopeBlockerReceipt(root, config, plannerBlocker);
      const writtenRepairer = await writeRepairScopeBlockerReceipt(root, config, repairerBlocker);
      expect(writtenPlanner).toBe(plannerFile);
      expect(writtenRepairer).toBe(repairerFile);
      // Both receipts survive — the second write must not overwrite the first.
      const persistedPlanner = JSON.parse(await fs.readFile(plannerFile, "utf8"));
      const persistedRepairer = JSON.parse(await fs.readFile(repairerFile, "utf8"));
      expect(persistedPlanner.digest).toBe(plannerBlocker.digest);
      expect(persistedPlanner.workUnitId).toBe("planner:TASK-COLLIDE");
      expect(persistedRepairer.digest).toBe(repairerBlocker.digest);
      expect(persistedRepairer.workUnitId).toBe("wu-1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
