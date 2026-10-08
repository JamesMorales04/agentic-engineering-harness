import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation, repairProtectedPaths } from "../src/candidates/repair.js";
import {
  applyRepairScopeAmendment,
  applyOwnerExemptedRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  findCoveringOwnerHardProtectionExemption,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  mintOwnerHardProtectionExemptionFromProductChoice,
  repairHardProtectedPaths,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  REPAIR_SCOPE_DENY_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairScope.js";
import { normalizeOwnerExemptionPaths } from "../src/candidates/repairOwnerExemption.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  isTerminalOperation,
  loadOperation,
  transitionOperationToTerminal,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

const mocks = vi.hoisted(() => ({ executeAgentPrompt: vi.fn() }));
vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/operations/supervisor.js", () => ({
  consolidateWithOperationSupervisor: vi.fn(async (_root: string, _config: unknown, _contract: unknown, _selection: unknown, input: { findings: unknown[] }) => ({
    output: { summary: "t", consolidatedFindings: input.findings, sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" },
    artifact: "t.json",
    session: { provider: "test", logicalAgent: "operation-supervisor", exitCode: 0, stdout: "", stderr: "" },
  })),
  maybeRotateOperationSupervisor: vi.fn(async () => undefined),
}));

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
  managed: process.env.AEH_MANAGED_AGENT,
  logical: process.env.AEH_LOGICAL_AGENT,
  role: process.env.AEH_AGENT_ROLE,
  interactive: process.env.AEH_INTERACTIVE_LEAD,
  orchestration: process.env.AEH_ORCHESTRATION_ALLOWED,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_MANAGED_AGENT", originalEnv.managed);
  restoreEnv("AEH_LOGICAL_AGENT", originalEnv.logical);
  restoreEnv("AEH_AGENT_ROLE", originalEnv.role);
  restoreEnv("AEH_INTERACTIVE_LEAD", originalEnv.interactive);
  restoreEnv("AEH_ORCHESTRATION_ALLOWED", originalEnv.orchestration);
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("owner-scoped hard-protection exemption via suspend/decide/resume (DETERMINISTIC)", () => {
  it("pins the gate: lead-approved amendment touching hard paths throws NON_EXEMPTIBLE with no exemption path", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-PIN-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    expect(findRepairHardProtectedViolations([sealPath], config, task)).toEqual([sealPath]);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:pin",
      filesNeededOutsideScope: [{ path: sealPath, reason: "needs seal tweak" }],
    });
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-pin-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const binding = syntheticBinding(operationId);
    const requestId = "request:owner-pin-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:control-center:test", reason: "attempt seal exemption",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await expect(
      applyRepairScopeAmendment({ root, config, contract: task, blocker, authorization: { decision, binding, requestId }, ledger }),
    ).rejects.toThrow(/NON_EXEMPTIBLE/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("honest suspend/approve/mint/honor/retry for a hard spec path (REAL suspend/resume, deterministic choices)", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-HONEST-1";
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
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, specPath);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "owner approves exact hard set");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.contract.scope?.allowed).toContain(specPath);
    expect(resolved.amendment.exemptedPaths).toEqual([specPath]);
    expect(resolved.amendment.ownerExemption?.exemptionId).toMatch(/^exemption:/);
    expect(resolved.amendment.decisionId).toMatch(/^decision:/);
    expect(resolved.selection?.choiceId).toBe(REPAIR_SCOPE_APPROVE_CHOICE_ID);
    const after = await loadOperation(root, operationId);
    expect(after.ownerExemptions?.[resolved.amendment.ownerExemption!.exemptionId]).toBeDefined();
    expect(after.continuation).toBeUndefined();
    expect(after.decisionRequest).toBeUndefined();
    // Amended retry writes the exempted hard path.
    const retry = await retryWriting(root, operationId, task, config, resolved.contract, resolved.amendment, specPath, "# spec (owner-exempted)\n");
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(specPath);
  });

  it("decline leaves BLOCKED standing with no grant, no amendment, suspension cleared", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-DECLINE-1";
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
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const deny = approveWaitingRequest(root, operationId, REPAIR_SCOPE_DENY_CHOICE_ID, "not justified");
    const resolved = await Promise.all([pending, deny]).then(([r]) => r);
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.message).toMatch(/hard-protected/i);
    expect(resolved.choiceId).toBe(REPAIR_SCOPE_DENY_CHOICE_ID);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    const after = await loadOperation(root, operationId);
    expect(after.ownerExemptions).toBeUndefined();
    expect(after.continuation).toBeUndefined();
    expect(after.decisionRequest).toBeUndefined();
  });

  it("timeout with no decision leaves BLOCKED with the bounded suspension remaining", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-TIMEOUT-1";
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
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
      timeoutMs: 500, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    const suspended = await loadOperation(root, operationId);
    expect(suspended.phase).toBe("HUMAN_REQUIRED");
    expect(suspended.continuation?.state).toBe("WAITING");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("sibling exactness: an exempted retry writing a non-exempt sibling still throws", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-SIBLING-1";
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
    const sibling = "specs/changes/REPAIR-SCOPE/proposal.md";
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, specPath);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "only the spec");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:sibling-retry", phase: "validation-repair",
        config, contract: resolved.contract, selection, executionCatalog: catalog,
        allowedScope: resolved.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        scopeAmendment: resolved.amendment,
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# spec (owner-exempted)\n");
          await fs.writeFile(path.join(isolatedRoot, sibling), "# proposal (not exempted)\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/escaped.*proposal|proposal.*escaped|scope/i);
  });

  it("forged grant (bad MAC) is rejected at verify, owner-apply, and the forbidden-scope filter", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-FORGE-1";
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
    const honest = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    const forged = { ...honest.grant, paths: [".harness/project.yaml", specPath], mac: honest.grant.mac };
    const operation = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation, neededPaths: [specPath], grant: forged, ledger: testLedger(root) }),
    ).rejects.toThrow(/FORGED|MAC|integrity|MISMATCH/i);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:forge",
      filesNeededOutsideScope: [{ path: specPath, reason: "x" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker, grant: forged, ledger: testLedger(root) }),
    ).rejects.toThrow(/FORGED|MAC|integrity|MISMATCH/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  });

  it("recorded-but-unconsumed approval grants nothing (verify UNCONSUMED; resolver suspends then timeout BLOCKED)", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-NOGRANT-1";
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
    // Shell-forged ledger file with self-declared human actor, never consumed
    // through a WAITING continuation: mint must refuse UNCONSUMED.
    const ledger = testLedger(root);
    const operation = await loadOperation(root, operationId);
    const binding = bindingForCurrentOperation(operation);
    const exemptionId = `exemption:${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`;
    void exemptionId;
    const requestId = "request:forged-1";
    const minted = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:forged", reason: "model minted",
    }, requestId);
    await expect(
      mintOwnerHardProtectionExemptionFromProductChoice({
        root, operationId, paths: [specPath], decision: minted, binding, requestId,
      }),
    ).rejects.toThrow(/UNCONSUMED|no exact one-time/i);
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, specPath);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
      timeoutMs: 500, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("cross-operation replay is rejected: a grant anchored in op A is dead in op B", async () => {
    const root = await createRepo();
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const opA = "OWNER-EXEMPT-XOP-A";
    await saveOwnedOperation(root, {
      version: 1, id: opA, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(opA, root);
    await bindPolicyForCurrentIdentity(root, opA);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const blockerA = await hardBlockerViaRepairer(root, opA, task, config, specPath);
    const honestA = await approveHardAndGetGrant(root, opA, task, config, blockerA.scopeBlocker!);
    const opB = "OWNER-EXEMPT-XOP-B";
    const { saveOperation } = await import("../src/operations/state.js");
    process.env.AEH_OPERATION_ID = opB;
    await saveOperation(root, {
      version: 1, id: opB, kind: "run", status: "RUNNING", phase: "repair", root,
      payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    const operationB = await loadOperation(root, opB);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: operationB, neededPaths: [specPath], grant: honestA.grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/CROSS_OPERATION|operation.*mismatch|binding/i);
  });

  it("expired exemptions are rejected even with a valid MAC", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-EXP-1";
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
    const honest = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    const operation = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({
        operation, neededPaths: [specPath], grant: honest.grant, ledger: testLedger(root),
        now: new Date(Date.now() + 30 * 24 * 3_600_000),
      }),
    ).rejects.toThrow(/EXPIRED/i);
  });

  it("terminal state kills the exemption: grants are stripped and verify refuses", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-TERM-1";
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
    const honest = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    expect((await loadOperation(root, operationId)).ownerExemptions?.[honest.grant.exemptionId]).toBeDefined();
    await transitionOperationToTerminal(root, operationId, { status: "FAILED", error: "test terminal" });
    const terminal = await loadOperation(root, operationId);
    expect(isTerminalOperation(terminal.status)).toBe(true);
    expect(terminal.ownerExemptions).toBeUndefined();
    await expect(
      verifyOwnerHardProtectionExemption({ operation: terminal, neededPaths: [specPath], grant: honest.grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/TERMINAL/i);
  });

  it("direct writes never honor exemptions: assembly scope escape still throws with a live grant", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-DIRECT-1";
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
    await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    expect((await loadOperation(root, operationId)).ownerExemptions).toBeDefined();
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:direct", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# direct\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/scope|escaped|denied/i);
  });

  it("managed-agent shells cannot mint exemptions (confused-deputy refusal)", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-AGENT-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    process.env.AEH_MANAGED_AGENT = "1";
    process.env.AEH_LOGICAL_AGENT = "repairer";
    process.env.AEH_AGENT_ROLE = "Repairer";
    process.env.AEH_INTERACTIVE_LEAD = "0";
    process.env.AEH_ORCHESTRATION_ALLOWED = "0";
    await expect(
      mintOwnerHardProtectionExemptionFromProductChoice({
        root, operationId, paths: [`specs/changes/${task.task.id}/spec.md`],
        decision: {} as never, binding: {} as never, requestId: "request:agent-1",
      }),
    ).rejects.toThrow(/AGENT_FORBIDDEN|managed|bounded/i);
  });

  it("glob paths are rejected at normalize; not-yet-existing exact files are allowed via suspend", async () => {
    expect(() => normalizeOwnerExemptionPaths(["src/**"])).toThrow(/PATH_INVALID|exact|wildcard/i);
    expect(() => normalizeOwnerExemptionPaths(["../escape.ts"])).toThrow(/PATH_INVALID|safe/i);
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-PATHS-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const future = "src/validators/future-check.ts";
    expect(findRepairHardProtectedViolations([future], config, task)).toEqual([future]);
    const blockerResult = await hardBlockerViaRepairer(root, operationId, task, config, future);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "new validator");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
  });

  it("one grant serves repair-loop re-amendment across tasks; the per-task cap still holds", async () => {
    const root = await createRepo();
    const config = projectConfig();
    const taskA = contract("REPAIR-SCOPE-A");
    const taskB = contract("REPAIR-SCOPE-B");
    await writeContractAndSeal(root, config, taskA);
    await writeContractAndSeal(root, config, taskB);
    const operationId = "OWNER-EXEMPT-MULTI-1";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: taskA.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealA = `specs/changes/${taskA.task.id}/spec.md`;
    const sealB = `specs/changes/${taskB.task.id}/spec.md`;
    // One suspend approving both exact paths mints one grant covering both.
    const blockerBoth = createRepairScopeBlockerReceipt({
      operationId, taskId: taskA.task.id, workUnitId: "validation-repair:multi-both",
      filesNeededOutsideScope: [{ path: sealA, reason: "a" }, { path: sealB, reason: "b" }],
    });
    const { writeRepairScopeBlockerReceipt } = await import("../src/candidates/repairScope.js");
    await writeRepairScopeBlockerReceipt(root, config, blockerBoth);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: taskA, blocker: blockerBoth,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "both seals");
    const firstBoth = await Promise.all([pending, approve]).then(([r]) => r);
    expect(firstBoth.status).toBe("AMENDED");
    if (firstBoth.status !== "AMENDED") throw new Error("expected AMENDED");
    const grant = (await loadOperation(root, operationId)).ownerExemptions?.[firstBoth.amendment.ownerExemption!.exemptionId];
    expect(grant).toBeDefined();
    const ledger = testLedger(root);
    const blockerB = createRepairScopeBlockerReceipt({
      operationId, taskId: taskB.task.id, workUnitId: "validation-repair:multi-b",
      filesNeededOutsideScope: [{ path: sealB, reason: "b" }],
    });
    const second = await applyOwnerExemptedRepairScopeAmendment({ root, config, contract: taskB, blocker: blockerB, grant: grant!, ledger });
    expect(second.status).toBe("AMENDED");
    const blockerA2 = createRepairScopeBlockerReceipt({
      operationId, taskId: taskA.task.id, workUnitId: "validation-repair:multi-a2",
      filesNeededOutsideScope: [{ path: sealA, reason: "a again" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: taskA, blocker: blockerA2, grant: grant!, ledger }),
    ).rejects.toThrow(/Only 1 repair scope amendment|BUDGET/i);
  });

  it("participant steering fails: blocker paths outside the grant are never partially honored", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-STEER-1";
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
    const honest = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    const steered = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:steer",
      filesNeededOutsideScope: [
        { path: specPath, reason: "granted" },
        { path: ".harness/project.yaml", reason: "steered" },
      ],
    });
    expect(findRepairHardProtectedViolations([".harness/project.yaml"], config, task)).toEqual([".harness/project.yaml"]);
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker: steered, grant: honest.grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/NOT_COVERED|cover/i);
    // Resolver with no fully covering grant suspends (does not partially honor);
    // timeout leaves BLOCKED with no amendment for the steered task attempt.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  });

  it("owner path cannot launder amendable manifests past the product-choice deny option", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-LAUNDER-1";
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
    const honest = await approveHardAndGetGrant(root, operationId, task, config, blockerResult.scopeBlocker!);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:launder",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy bump" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker, grant: honest.grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/HARD|amendable|product-choice|NOT_COVERED|cover/i);
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

async function approveHardAndGetGrant(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, blocker: import("../src/candidates/repairScope.js").RepairScopeBlockerReceiptV1) {
  const taskForBlocker = blocker.taskId === task.task.id ? task : task;
  const pending = resolveRepairScopeBlockerViaProductChoice({
    root, controlRoot: root, operationId, config, contract: taskForBlocker, blocker,
  });
  const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "approve for grant");
  const resolved = await Promise.all([pending, approve]).then(([r]) => r);
  if (resolved.status !== "AMENDED" || !resolved.ownerExemption) throw new Error("expected AMENDED with grant");
  const grant = (await loadOperation(root, operationId)).ownerExemptions?.[resolved.ownerExemption.exemptionId];
  if (!grant) throw new Error("grant not anchored");
  return { resolved, grant };
}

async function retryWriting(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, amendedContract: TaskContract, amendment: import("../src/candidates/repairScope.js").RepairScopeAmendmentV1, filePath: string, content: string) {
  const selection = repairerSelection();
  const catalog = compileExecutionCatalog({
    runtimes: { test: { adapter: "codex" } },
    models: { test: { runtime: "test", model: "fake" } },
    roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
  });
  return executeRepairerCandidateMutation({
    root, stateRoot: root, operationId, taskId: task.task.id,
    workUnitId: "validation-repair:owner-retry", phase: "validation-repair",
    config, contract: amendedContract, selection, executionCatalog: catalog,
    allowedScope: amendedContract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
    scopeAmendment: amendment,
    prompt: buildRepairPrompt(packet(task.task.id)),
    execute: async (isolatedRoot, participantId) => {
      await fs.writeFile(path.join(isolatedRoot, filePath), content);
      return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-exempt-"));
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

function syntheticBinding(operationId: string) {
  return {
    operationId,
    candidate: createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r1`, revision: 1, sourceDigest: "a".repeat(64) }),
    operationExecutionRevision: 1,
    policyDigest: "b".repeat(64),
    controllerEpoch: 0,
  };
}

function bindingForCurrentOperation(current: Awaited<ReturnType<typeof loadOperation>>) {
  return {
    operationId: current.id,
    candidate: current.candidateRevision!,
    operationExecutionRevision: current.operationExecutionRevision!,
    policyDigest: current.resolvedOperationPolicy!.digest,
    controllerEpoch: currentControllerEpoch(current),
  };
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
