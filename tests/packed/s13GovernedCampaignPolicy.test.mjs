import assert from "node:assert/strict";
import test from "node:test";
import { accountWorkspaceCleanupV1, workspaceArchiveDecision } from "./s13GovernedCampaignPolicy.mjs";

test("workspace archive requires a durable terminal operation and an exited controller", () => {
  assert.deepEqual(workspaceArchiveDecision("RUNNING", true), { eligible: false, operationTerminal: false, controllerExited: false });
  assert.deepEqual(workspaceArchiveDecision("FAILED", true), { eligible: false, operationTerminal: true, controllerExited: false });
  assert.deepEqual(workspaceArchiveDecision("RUNNING", false), { eligible: false, operationTerminal: false, controllerExited: true });
  assert.deepEqual(workspaceArchiveDecision("FAILED", false), { eligible: true, operationTerminal: true, controllerExited: true });
});

test("R18-F2: workspace accounting fails when an inventory entry is neither archived nor remaining", () => {
  const inventory = [{ workspaceId: "wks_a" }, { workspaceId: "wks_b" }, { workspaceId: "wks_c" }];
  const archived = [{ workspaceId: "wks_a", exitCode: 0 }];
  const remaining = [{ workspaceId: "wks_b" }];
  const result = accountWorkspaceCleanupV1(inventory, archived, remaining);
  assert.equal(result.accounted, false);
  assert.deepEqual(result.unaccounted, ["wks_c"]);
  assert.equal(result.inventoryCount, 3);
  assert.equal(result.archivedCount, 1);
  assert.equal(result.remainingCount, 1);
});

test("R18-F2: workspace accounting accepts archived + explicitly remaining entries and ignores non-zero archives", () => {
  const inventory = ["wks_a", "wks_b", "wks_c"];
  const result = accountWorkspaceCleanupV1(inventory, [{ workspaceId: "wks_a", exitCode: 0 }, { workspaceId: "wks_c", exitCode: 1 }], ["wks_b", "wks_c"]);
  assert.equal(result.accounted, true);
  assert.deepEqual(result.unaccounted, []);
  assert.equal(result.archivedCount, 1);
  assert.equal(result.remainingCount, 2);
});
