import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation, repairProtectedPaths } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  REPAIR_SCOPE_DENY_CHOICE_ID,
  applyRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  repairHardProtectedPaths,
  repairScopeBlockerValidationCheck,
  repairScopeProductChoices,
  resolveRepairScopeBlockerViaProductChoice,
} from "../src/candidates/repairScope.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

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

import { runReviewLifecycle } from "../src/agents/reviewLifecycle.js";
import type { ResolvedRoute } from "../src/agents/types.js";

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
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("repair out-of-scope blocker → bounded replan channel", () => {
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
    } as never);
    const initial = (await loadOperation(root, operationId)).candidateRevision!;
    bindEnv(operationId, root);

    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

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

    expect(result.changeSet).toBeUndefined();
    expect(result.candidate).toBeUndefined();
    expect(result.scopeBlocker).toBeDefined();
    expect(result.scopeBlocker?.filesNeededOutsideScope).toMatchObject([
      { path: "package-lock.json", reason: expect.stringContaining("trivy") },
    ]);
    expect(await fs.readFile(path.join(root, "package-lock.json"), "utf8")).toBe("{\"lockfileVersion\":1}\n");
    expect((await loadOperation(root, operationId)).candidateRevision?.identityDigest).toBe(initial.identityDigest);

    const check = repairScopeBlockerValidationCheck(result.scopeBlocker!);
    expect(check.status).toBe("FAIL");
    expect(check.id).toBe("repair.scope-blocker");
    expect(check.message).toContain("package-lock.json");

    expect(repairProtectedPaths(config, task).some((p) => p === "package-lock.json")).toBe(true);
  });

  it("blocker receipt write failure throws fail-closed (no suppression, no blocker without durable receipt)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-RECEIPT-FAIL-1";
    const task = contract();
    // Block the receipt directory with a regular file so the durable write must fail.
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "repairs"), "not-a-directory", "utf8");
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:blocker", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (_isolatedRoot, participantId) => ({
          provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
          stdout: `AEH_RESULT_JSON=${JSON.stringify({
            filesChanged: [], behaviorRepaired: [], validationCommands: [],
            filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
          })}`,
          stderr: "",
        }),
      }),
    ).rejects.toThrow(/NOT_DURABLE|ENOTDIR|EEXIST|receipt/i);
  });

  it("ledger-approved amendment reseals and the single-file retry succeeds; silent expansion still throws", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-AMEND-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: {
        Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] },
      },
    });

    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: task.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_isolatedRoot, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" }],
        })}`,
        stderr: "",
      }),
    });
    expect(blockerResult.scopeBlocker).toBeDefined();

    // Ledger-gated approval: record + consume a CHOOSE product-choice for the
    // exact approve choice under a synthetic binding, then apply. The ledger
    // lives outside the repo workspace so its durable files never dirty the
    // candidate worktree digest.
    const binding = syntheticBinding(blockerResult.scopeBlocker!.operationId);
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-approve-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const requestId = "request:repair-scope-approve-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: "human:control-center:test",
      reason: "accept trivy transitive bump for package-lock.json only",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);

    const amended = await applyRepairScopeAmendment({
      root, config, contract: task, blocker: blockerResult.scopeBlocker!,
      authorization: { decision, binding, requestId },
      ledger,
    });
    expect(amended.status).toBe("AMENDED");
    if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(amended.contract.scope?.allowed).toContain("package-lock.json");
    expect(amended.amendment.exemptedPaths).toEqual(["package-lock.json"]);
    expect(amended.amendment.decidedBy).toBe("human");
    expect(amended.amendment.decisionId).toBe(decision.decisionId);
    expect(amended.amendment.requestId).toBe(requestId);
    expect(amended.amendment.decidedActor).toBe("human:control-center:test");
    expect(await fs.stat(path.join(root, ".harness", "contracts", `${task.task.id}.yaml`))).toBeDefined();
    expect(await fs.stat(path.join(root, amended.amendment.amendmentPath))).toBeDefined();
    expect(await fs.stat(path.join(root, amended.amendment.sealPath))).toBeDefined();
    expect((await listRepairScopeAmendments(root, config, task.task.id)).length).toBe(1);

    const retry = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:amended-retry", phase: "validation-repair",
      config, contract: amended.contract, selection, executionCatalog: catalog,
      allowedScope: amended.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
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

    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:silent-expansion", phase: "validation-repair",
        config, contract: amended.contract, selection, executionCatalog: catalog,
        allowedScope: amended.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        scopeAmendment: amended.amendment,
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, "acceptance", "flow.feature"), "Then any value is accepted\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("ChangeSet escaped its assigned scope");
    const effectiveForbidden = filterForbiddenScopeForAmendment(
      [...repairProtectedPaths(config, amended.contract)],
      amended.amendment,
    );
    expect(effectiveForbidden.some((p) => p === "package-lock.json")).toBe(false);
    expect(effectiveForbidden.length).toBeGreaterThan(0);
  });

  it("a caller-supplied decidedBy string alone never authorizes (self-label path deleted)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-SELF-LABEL-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    const selfLedgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-self-"));
    roots.push(selfLedgerDir);
    const ledger = new HumanDecisionLedgerV2(selfLedgerDir);
    // The deleted self-label shape carries no ledger proof and must throw
    // fail-closed (never AMENDED).
    await expect(
      applyRepairScopeAmendment({
        root, config, contract: task, blocker: blockerResult.scopeBlocker!,
        decision: { approved: true, decidedBy: "lead", reason: "self-label" },
      } as never),
    ).rejects.toThrow(/HumanDecision|ledger|provenance|authorization|decision/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    // A forged decidedBy (worker/model self-approval) as a bare authorization
    // without a consumed ledger receipt also throws.
    await expect(
      applyRepairScopeAmendment({
        root, config, contract: task, blocker: blockerResult.scopeBlocker!,
        authorization: {
          decision: { version: 2, kind: "CHOOSE", purpose: { kind: "PRODUCT_CHOICE", requestId: "request:forged", choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID }, actorId: "human:forged", reason: "x" },
          binding: syntheticBinding(operationId),
          requestId: "request:forged",
        },
        ledger,
      } as never),
    ).rejects.toThrow(/consumed|receipt|match|stale/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("deny choice and unconsumed decisions never amend: BLOCKED stands or fail-closed throw", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-DENIED-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: task.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    // Deny: consumed deny decision returns BLOCKED citing the blocker.
    {
      const binding = syntheticBinding(blockerResult.scopeBlocker!.operationId);
      const denyLedgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-deny-"));
      roots.push(denyLedgerDir);
      const ledger = new HumanDecisionLedgerV2(denyLedgerDir);
      const requestId = "request:repair-scope-deny-1";
      const decision = await ledger.recordProductChoice({
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_DENY_CHOICE_ID },
        kind: "CHOOSE", actorId: "human:control-center:test", reason: "lockfile churn not justified",
      }, requestId);
      await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
      const denied = await applyRepairScopeAmendment({
        root, config, contract: task, blocker: blockerResult.scopeBlocker!,
        authorization: { decision, binding, requestId }, ledger,
      });
      expect(denied.status).toBe("BLOCKED");
      if (denied.status !== "BLOCKED") throw new Error("expected BLOCKED");
      expect(denied.check.status).toBe("FAIL");
      expect(denied.check.message).toContain("package-lock.json");
      expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    }
    // Approve without consumption: fail-closed throw (no durable receipt).
    {
      const binding = syntheticBinding(blockerResult.scopeBlocker!.operationId);
      const unconsumedLedgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-unconsumed-"));
      roots.push(unconsumedLedgerDir);
      const ledger = new HumanDecisionLedgerV2(unconsumedLedgerDir);
      const requestId = "request:repair-scope-unconsumed-1";
      const decision = await ledger.recordProductChoice({
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
        kind: "CHOOSE", actorId: "human:control-center:test", reason: "would approve but never consumed",
      }, requestId);
      await expect(
        applyRepairScopeAmendment({
          root, config, contract: task, blocker: blockerResult.scopeBlocker!,
          authorization: { decision, binding, requestId }, ledger,
        }),
      ).rejects.toThrow(/UNCONSUMED|consumed|receipt/i);
      expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    }
  });

  it("max 1 amendment per task: a second blocker goes BLOCKED without a second suspension", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-BUDGET-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    // First resolution: approve via the canonical suspend/record/await path.
    const first = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const recordFirst = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const current = await loadOperation(root, operationId);
        if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
          const binding = bindingForCurrentOperation(current);
          const { HumanDecisionLedgerV2: Ledger } = await import("../src/security/humanDecision.js");
          const ledger = new Ledger(path.join(root, ".harness", "security", "human-decisions.json"));
          const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
          await recordControlCenterDecision(root, ledger, {
            operationId, requestId: current.decisionRequest.requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "approve exact lockfile",
          }, "human:control-center:test");
          void binding;
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("suspension never appeared for first blocker");
    })();
    const firstResult = await Promise.all([first, recordFirst]).then(([r]) => r);
    expect(firstResult.status).toBe("AMENDED");
    if (firstResult.status !== "AMENDED") throw new Error("expected AMENDED");
    expect((await listRepairScopeAmendments(root, config, task.task.id)).length).toBe(1);

    // Second blocker for the same task: BLOCKED without suspending again.
    // Second blocker for the same task: a genuinely blocked file (yarn.lock is
    // default-deny protected, not in the amended allowlist) goes BLOCKED
    // without a second suspension (max 1/task preserved).
    const secondBlocker = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker-2", phase: "validation-repair",
      config, contract: firstResult.contract, selection, executionCatalog: catalog,
      allowedScope: firstResult.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "yarn.lock", reason: "needs second manifest" }],
        })}`,
        stderr: "",
      }),
    });
    expect(secondBlocker.scopeBlocker).toBeDefined();
    const second = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: firstResult.contract, blocker: secondBlocker.scopeBlocker!,
      timeoutMs: 500,
    });
    expect(second.status).toBe("BLOCKED");
    const after = await loadOperation(root, operationId);
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  });

  it("timeout with no ledger decision leaves BLOCKED citing the blocker (fail closed, suspension remains)", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-TIMEOUT-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task,
      blocker: blockerResult.scopeBlocker!, timeoutMs: 500, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.status).toBe("FAIL");
    expect(resolved.check.message).toContain("package-lock.json");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    // No decision was recorded, so the suspension remains for a human decision
    // within expiry; nothing was amended and nothing was retried.
    const suspended = await loadOperation(root, operationId);
    expect(suspended.phase).toBe("HUMAN_REQUIRED");
    expect(suspended.continuation?.state).toBe("WAITING");
  });

  it("deny via the canonical suspend/record/await path returns BLOCKED and clears the suspension", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-DENY-FLOW-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const blockerResult = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      }),
    });
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker!,
    });
    const deny = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const current = await loadOperation(root, operationId);
        if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
          const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
          const { HumanDecisionLedgerV2: Ledger } = await import("../src/security/humanDecision.js");
          const ledger = new Ledger(path.join(root, ".harness", "security", "human-decisions.json"));
          await recordControlCenterDecision(root, ledger, {
            operationId, requestId: current.decisionRequest.requestId, choiceId: REPAIR_SCOPE_DENY_CHOICE_ID, reason: "not justified",
          }, "human:control-center:test");
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("suspension never appeared for deny flow");
    })();
    const resolved = await Promise.all([pending, deny]).then(([r]) => r);
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.message).toContain("package-lock.json");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    const cleared = await loadOperation(root, operationId);
    expect(cleared.continuation).toBeUndefined();
    expect(cleared.decisionRequest).toBeUndefined();
  });

  it("hard-protected blocker suspends bounded approve/decline; timeout leaves BLOCKED with suspension remaining; manifests stay amendable", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-REPAIR-HARD-1";
    const task = contract();
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const hardBlocker = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:blocker-hard", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [], behaviorRepaired: [], validationCommands: [],
          filesNeededOutsideScope: [{ path: sealPath, reason: "needs seal tweak" }],
        })}`,
        stderr: "",
      }),
    });
    expect(hardBlocker.scopeBlocker).toBeDefined();
    // HARD subset owns the seal; the amendable manifest is denied but exemptible.
    expect(repairHardProtectedPaths(config, task).some((p) => p === sealPath)).toBe(true);
    expect(findRepairHardProtectedViolations([sealPath], config, task)).toEqual([sealPath]);
    expect(findRepairHardProtectedViolations(["package-lock.json"], config, task)).toEqual([]);
    expect(repairHardProtectedPaths(config, task).some((p) => p === "package-lock.json")).toBe(false);
    expect(repairProtectedPaths(config, task).some((p) => p === "package-lock.json")).toBe(true);
    // Resolver suspends HUMAN_REQUIRED for hard paths with no covering grant;
    // timeout with no decision leaves BLOCKED citing hard paths with the
    // suspension remaining for a human decision within expiry (bounded).
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task,
      blocker: hardBlocker.scopeBlocker!, timeoutMs: 500, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.message).toMatch(/hard-protected/i);
    expect(resolved.check.message).toContain(sealPath);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    const after = await loadOperation(root, operationId);
    expect(after.phase).toBe("HUMAN_REQUIRED");
    expect(after.decisionRequest?.requestId).toMatch(/^request:/);
    expect(after.continuation?.state).toBe("WAITING");
    // Direct apply with a consumed ledger approval still throws (never exemptible).
    {
      const binding = syntheticBinding(hardBlocker.scopeBlocker!.operationId);
      const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-hard-"));
      roots.push(ledgerDir);
      const ledger = new HumanDecisionLedgerV2(ledgerDir);
      const requestId = "request:repair-scope-hard-1";
      const decision = await ledger.recordProductChoice({
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
        kind: "CHOOSE", actorId: "human:control-center:test", reason: "attempt seal exemption",
      }, requestId);
      await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
      await expect(
        applyRepairScopeAmendment({
          root, config, contract: task, blocker: hardBlocker.scopeBlocker!,
          authorization: { decision, binding, requestId }, ledger,
        }),
      ).rejects.toThrow(/NON_EXEMPTIBLE/i);
      expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    }
    // Manifest path keeps the existing approve flow: ledger approve → AMENDED.
    {
      const manifestBlocker = createRepairScopeBlockerReceipt({
        operationId, taskId: task.task.id, workUnitId: "validation-repair:blocker-manifest",
        filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy bump" }],
      });
      const binding = syntheticBinding(operationId);
      const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-ledger-manifest-"));
      roots.push(ledgerDir);
      const ledger = new HumanDecisionLedgerV2(ledgerDir);
      const requestId = "request:repair-scope-manifest-1";
      const decision = await ledger.recordProductChoice({
        ...binding,
        purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
        kind: "CHOOSE", actorId: "human:control-center:test", reason: "approve lockfile",
      }, requestId);
      await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
      const amended = await applyRepairScopeAmendment({
        root, config, contract: task, blocker: manifestBlocker,
        authorization: { decision, binding, requestId }, ledger,
      });
      expect(amended.status).toBe("AMENDED");
      if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
      expect(amended.amendment.exemptedPaths).toEqual(["package-lock.json"]);
      const effectiveForbidden = filterForbiddenScopeForAmendment(
        [...repairProtectedPaths(config, task)],
        amended.amendment,
        repairHardProtectedPaths(config, task),
      );
      expect(effectiveForbidden.some((p) => p === "package-lock.json")).toBe(false);
    }
  });

  it("repair prompt states the blocker path explicitly (report, don't expand)", async () => {
    const prompt = buildRepairPrompt(packet("REPAIR-PROMPT-CHECK"));
    expect(prompt).toContain("smallest targeted changes");
    expect(prompt).toContain("do not broaden scope");
    expect(prompt).toMatch(/filesNeededOutsideScope/i);
    expect(prompt).toMatch(/do not edit.*outside.*scope|report.*do.*expand/i);
  });

  it("repair-scope product choices cite the exact blocker paths with bounded approve/deny options", async () => {
    const blocker = {
      version: 1 as const, mechanism: "DETERMINISTIC" as const,
      operationId: "op-1", taskId: "T", workUnitId: "w",
      declaredAt: new Date().toISOString(),
      filesNeededOutsideScope: [
        { path: "package-lock.json", reason: "trivy bump" },
        { path: "yarn.lock", reason: "mirror bump" },
      ],
      digest: "0".repeat(64),
    };
    const { sha256Canonical } = await import("../src/core/digest.js");
    const { digest: _ignored, ...body } = blocker;
    void _ignored;
    const digest = sha256Canonical(body);
    const choices = repairScopeProductChoices({ ...blocker, digest });
    expect(choices.map((c) => c.choiceId)).toEqual([REPAIR_SCOPE_APPROVE_CHOICE_ID, REPAIR_SCOPE_DENY_CHOICE_ID]);
    expect(choices[0]!.description).toContain("package-lock.json");
    expect(choices[0]!.description).toContain("yarn.lock");
  });

  it("review remediation with a scope blocker propagates BLOCKED (no amendment, no silent ignore)", async () => {
    const root = await createRepoWithCheck();
    const operationId = "CHANGE-REVIEW-SCOPE-BLOCKER-1";
    const task = reviewContract();
    const config = reviewConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const reviewer = reviewSelection("reviewer", "Reviewer");
    const repairer = reviewSelection("repairer", "Repairer");
    const implementer = reviewSelection("implementer", "Implementer");
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    mocks.executeAgentPrompt.mockImplementation(async (_agentRoot: string, _c: unknown, _t: unknown, agent: AgentExecutionSelection, _prompt: string, options: { participantId?: string }) => {
      if (agent.role === "Repairer") {
        // No file changes; declare the genuinely blocked lockfile.
        return {
          provider: "test", logicalAgent: "repairer", participantId: options.participantId,
          exitCode: 0,
          stdout: `AEH_RESULT_JSON=${JSON.stringify({
            filesChanged: [], behaviorRepaired: [], validationCommands: [],
            filesNeededOutsideScope: [{ path: "package-lock.json", reason: "review fix needs the locked transitive dep" }],
          })}`,
          stderr: "",
        };
      }
      if (agent.role !== "Reviewer") throw new Error(`unexpected role ${agent.role}`);
      return {
        provider: "test", logicalAgent: "reviewer", participantId: options.participantId,
        exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          verdict: "FAIL",
          findings: [{
            id: "F-REVIEW-BLOCKER", severity: "medium", category: "correctness",
            location: { file: "src/value.ts" }, evidence: "The locked dep must move.",
            impact: "Wrong.", recommendedFix: "Bump.", requiredCompetencies: ["typescript"], reviewDimensions: ["correctness"],
          }],
          finalizationSafety: "SAFE",
        })}`,
        stderr: "",
      };
    });
    const { verifyTask } = await import("../src/core/verify.js");
    const initialReport = await verifyTask(root, config, task, { stateRoot: root, policyRoot: root });
    expect(initialReport.status).toBe("PASS");
    const result = await runReviewLifecycle({
      root, stateRoot: root, config, contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" } satisfies ResolvedRoute,
      reviewerSelections: { reviewer },
      repairerSelection: repairer,
      executionCatalog: catalog,
      implementationSelection: implementer,
      report: initialReport,
      revalidate: () => verifyTask(root, config, task, { stateRoot: root, policyRoot: root }),
    });
    // Tested rationale: review remediation does not own amendments (run.ts
    // validation-repair owns the single ledger-gated amendment). It propagates
    // BLOCKED fail-closed citing the exact blocker.
    expect(result.status).toBe("FAIL");
    expect(result.finalState).toBe("REQUIRES_PRODUCT_DECISION");
    expect(result.humanRequired).toBe(true);
    const blockerCheck = result.checks.find((check) => check.id === "repair.scope-blocker");
    expect(blockerCheck?.status).toBe("FAIL");
    expect(blockerCheck?.message).toContain("package-lock.json");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
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

async function createRepoWithCheck(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-scope-review-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await fs.writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
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
    intent: "repair-scope test policy",
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

function reviewConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "repair-scope-review-test" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
    workflow: { reviews: { leadAcceptance: false } },
  };
}

function reviewContract(): TaskContract {
  return {
    version: 1,
    task: { id: "REVIEW-SCOPE", title: "Review needs lockfile" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [{ id: "check", command: "node check.mjs" }] },
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

function reviewSelection(logicalAgent: string, role: AgentExecutionSelection["role"]): AgentExecutionSelection {
  return {
    logicalAgent, role, domains: [],
    runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex",
    modelAlias: "test", modelId: "fake", modelName: "fake", transport: "direct",
    skills: [], mcps: [],
    permissions: {
      read: "allow", write: role === "Reviewer" ? "deny" : "allow", shell: "allow",
      network: "deny", delegate: "deny", review: role === "Reviewer" ? "allow" : "deny", gitWrite: "deny",
    },
    outputContract: role === "Repairer" ? "repair-result" : role === "Reviewer" ? "reviewer" : "implementer",
    args: [], runtimeCapabilities: {},
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
