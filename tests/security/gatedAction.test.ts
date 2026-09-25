import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../../src/architecture/executionIdentity.js";
import { sha256Canonical, sha256Utf8 } from "../../src/core/digest.js";
import { bindOperationCandidate, bindResolvedOperationPolicy, claimControllerEpoch, currentControllerEpoch, loadOperation, saveOperation } from "../../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import type { ActionReconciliationOutcomeV1, ActionReconciliationResultV1 } from "../../src/security/actionReconciliation.js";
import { executeGatedAction } from "../../src/security/gatedAction.js";
import { controllerActorId, loadActionIntent, loadActionReceipt, type ActionIntentV1, type ToolActionKindV1, type ToolActionRequestV1 } from "../../src/security/toolActionGate.js";

const NOW = "2026-01-01T00:00:00.000Z";
const roots: string[] = [];
const previousEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  epoch: process.env.AEH_CONTROLLER_EPOCH,
  token: process.env.AEH_CONTROLLER_TOKEN
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  restoreEnv("AEH_CONTROLLER_TOKEN", previousEnv.token);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("gated action execution and reconciliation", () => {
  it("persists exactly one regular receipt on deterministic execution success", async () => {
    const context = await createContext("RUN-GATED-EXEC-SUCCESS");
    let executeCount = 0;
    let reconcileCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        return { outcome: "SUCCEEDED" as const, evidence: { commit: "abc123" } };
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "SUCCEEDED");
      },
      now: new Date(NOW)
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.receipt?.outcome).toBe("SUCCEEDED");
    expect(result.receipt?.reconciledUnderEpoch).toBeUndefined();
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(0);
    expect(await countReceipts(context)).toBe(1);
    const stored = await loadActionReceipt(context.root, context.operationId, "delivery:commit");
    expect(stored?.receiptId).toBe(result.receipt?.receiptId);
    expect(stored?.outcome).toBe("SUCCEEDED");
  });

  it("persists exactly one regular receipt on deterministic execution failure without reconciling", async () => {
    const context = await createContext("RUN-GATED-EXEC-FAILURE");
    let executeCount = 0;
    let reconcileCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        return { outcome: "FAILED" as const, evidence: { exitCode: 1, stderr: "nothing to commit" } };
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "SUCCEEDED");
      },
      now: new Date(NOW)
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.receipt?.outcome).toBe("FAILED");
    expect(result.receipt?.reconciledUnderEpoch).toBeUndefined();
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(0);
    expect(await countReceipts(context)).toBe(1);
  });

  it("reconciles a thrown executor to one reconciled SUCCEEDED receipt without re-executing", async () => {
    const context = await createContext("RUN-GATED-THROW-SUCCEEDED");
    let sideEffectApplied = false;
    let executeCount = 0;
    let reconcileCount = 0;
    let reconciledIntentId: string | undefined;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        sideEffectApplied = true;
        throw new Error("transport reset after the effect was applied");
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        reconciledIntentId = intent.intentId;
        return makeReconciliation(intent, "SUCCEEDED", "head-observed");
      },
      now: new Date(NOW)
    });

    expect(sideEffectApplied).toBe(true);
    expect(result.status).toBe("RECONCILED");
    expect(result.receipt?.outcome).toBe("SUCCEEDED");
    expect(result.receipt?.reconciledUnderEpoch).toBe(context.epoch);
    expect(result.reconciliation?.outcome).toBe("SUCCEEDED");
    expect(reconciledIntentId).toBe(result.intent.intentId);
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(1);
    expect(await countReceipts(context)).toBe(1);
    const stored = await loadActionReceipt(context.root, context.operationId, "delivery:commit");
    expect(stored?.receiptId).toBe(result.receipt?.receiptId);
  });

  it("records only the reconciled FAILED receipt when the executor throws and state failed", async () => {
    const context = await createContext("RUN-GATED-THROW-FAILED");
    let executeCount = 0;
    let reconcileCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        throw new Error("connection closed before any output");
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "FAILED", "head-unchanged");
      },
      now: new Date(NOW)
    });

    expect(result.status).toBe("RECONCILED");
    expect(result.receipt?.outcome).toBe("FAILED");
    expect(result.receipt?.reconciledUnderEpoch).toBe(context.epoch);
    expect(result.reconciliation?.outcome).toBe("FAILED");
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(1);
    expect(await countReceipts(context)).toBe(1);
    const stored = await loadActionReceipt(context.root, context.operationId, "delivery:commit");
    expect(stored?.outcome).toBe("FAILED");
    expect(stored?.reconciledUnderEpoch).toBe(context.epoch);
  });

  it("returns an unresolved result without a receipt when reconciliation observes UNKNOWN", async () => {
    const context = await createContext("RUN-GATED-THROW-UNKNOWN");
    let executeCount = 0;
    let reconcileCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        throw new Error("executor crashed");
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "UNKNOWN", "head-unreadable");
      },
      now: new Date(NOW)
    });

    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.receipt).toBeUndefined();
    expect(result.reconciliation?.outcome).toBe("UNKNOWN");
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(1);
    expect(await countReceipts(context)).toBe(0);
    const intent = await loadActionIntent(context.root, context.operationId, "delivery:commit");
    expect(intent?.intentId).toBe(result.intent.intentId);
  });

  it("returns HUMAN_REQUIRED without a receipt when reconciliation requires a human", async () => {
    const context = await createContext("RUN-GATED-THROW-HUMAN");
    let executeCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        throw new Error("executor crashed");
      },
      reconcile: async (intent) => makeReconciliation(intent, "HUMAN_REQUIRED", "provider-identity-inspection-unavailable"),
      now: new Date(NOW)
    });

    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.receipt).toBeUndefined();
    expect(result.reconciliation?.outcome).toBe("HUMAN_REQUIRED");
    expect(executeCount).toBe(1);
    expect(await countReceipts(context)).toBe(0);
    await expect(loadActionIntent(context.root, context.operationId, "delivery:commit")).resolves.toBeDefined();
  });

  it("returns an unresolved result without a receipt when reconciliation itself throws", async () => {
    const context = await createContext("RUN-GATED-THROW-RECONCILER");
    let executeCount = 0;
    let reconcileCount = 0;

    const result = await executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit"),
      execute: async () => {
        executeCount += 1;
        throw new Error("executor crashed");
      },
      reconcile: async () => {
        reconcileCount += 1;
        throw new Error("reconciler transport down");
      },
      now: new Date(NOW)
    });

    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.receipt).toBeUndefined();
    expect(result.reconciliation).toBeUndefined();
    expect(result.detail).toContain("reconciler transport down");
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(1);
    expect(await countReceipts(context)).toBe(0);
    const intent = await loadActionIntent(context.root, context.operationId, "delivery:commit");
    expect(intent?.intentId).toBe(result.intent.intentId);
  });

  it("reconciles an unresolved prior intent before any later retry can execute", async () => {
    const context = await createContext("RUN-GATED-RETRY");
    const request = controllerRequest(context, "git.commit", "delivery:commit");
    let executeCount = 0;
    let reconcileCount = 0;

    const first = await executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        executeCount += 1;
        throw new Error("executor crashed after the effect may have applied");
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "UNKNOWN", "head-unreadable");
      },
      now: new Date(NOW)
    });
    expect(first.status).toBe("RECONCILIATION_REQUIRED");
    expect(await countReceipts(context)).toBe(0);

    const second = await executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        throw new Error("execute must never run for an unresolved prior intent");
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "SUCCEEDED", "head-observed");
      },
      now: new Date(NOW)
    });

    expect(second.status).toBe("RECONCILED");
    expect(second.receipt?.outcome).toBe("SUCCEEDED");
    expect(second.receipt?.reconciledUnderEpoch).toBe(context.epoch);
    expect(second.intent.intentId).toBe(first.intent.intentId);
    expect(executeCount).toBe(1);
    expect(reconcileCount).toBe(2);
    expect(await countReceipts(context)).toBe(1);

    const third = await executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        throw new Error("execute must never run once a receipt exists");
      },
      reconcile: async (intent) => makeReconciliation(intent, "SUCCEEDED")
    });
    expect(third.status).toBe("ALREADY_COMPLETED");
    expect(third.receipt?.receiptId).toBe(second.receipt?.receiptId);
    expect(executeCount).toBe(1);
    expect(await countReceipts(context)).toBe(1);
  });

  it("keeps the prior intent unresolved when a later reconciliation throws", async () => {
    const context = await createContext("RUN-GATED-RETRY-THROW");
    const request = controllerRequest(context, "git.commit", "delivery:commit");
    let executeCount = 0;

    await executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        executeCount += 1;
        throw new Error("executor crashed");
      },
      reconcile: async (intent) => makeReconciliation(intent, "UNKNOWN"),
      now: new Date(NOW)
    });

    const retry = await executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        throw new Error("execute must never run for an unresolved prior intent");
      },
      reconcile: async () => {
        throw new Error("reconciler unavailable");
      },
      now: new Date(NOW)
    });

    expect(retry.status).toBe("RECONCILIATION_REQUIRED");
    expect(retry.receipt).toBeUndefined();
    expect(executeCount).toBe(1);
    expect(await countReceipts(context)).toBe(0);
    await expect(loadActionIntent(context.root, context.operationId, "delivery:commit")).resolves.toBeDefined();
  });

  it("leaves execute uncalled and creates no effect when the frozen policy denies the action", async () => {
    const context = await createContext("RUN-GATED-DENIED");
    let executeCount = 0;

    await expect(executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "github.issue.create", "issue:create"),
      execute: async () => {
        executeCount += 1;
        return { outcome: "SUCCEEDED" as const, evidence: {} };
      },
      reconcile: async (intent) => makeReconciliation(intent, "SUCCEEDED")
    })).rejects.toThrow("TOOL_ACTION_POLICY_DENIED");

    expect(executeCount).toBe(0);
    await expect(loadActionIntent(context.root, context.operationId, "issue:create")).resolves.toBeUndefined();
    expect(await countReceipts(context)).toBe(0);
  });

  it("leaves execute uncalled and creates no effect when controller fencing is stale", async () => {
    const context = await createContext("RUN-GATED-FENCED");
    let executeCount = 0;

    await expect(executeGatedAction({
      root: context.root,
      request: controllerRequest(context, "git.commit", "delivery:commit", undefined, context.epoch + 1),
      execute: async () => {
        executeCount += 1;
        return { outcome: "SUCCEEDED" as const, evidence: {} };
      },
      reconcile: async (intent) => makeReconciliation(intent, "SUCCEEDED")
    })).rejects.toThrow("TOOL_ACTION_CONTROLLER_FENCED");

    expect(executeCount).toBe(0);
    await expect(loadActionIntent(context.root, context.operationId, "delivery:commit")).resolves.toBeUndefined();
    expect(await countReceipts(context)).toBe(0);
  });

  it("leaves execute and reconcile uncalled when the request candidate is stale", async () => {
    const context = await createContext("RUN-GATED-STALE-CANDIDATE");
    const request = controllerRequest(context, "git.commit", "delivery:commit");
    await bindOperationCandidate(context.root, context.operationId, createCandidateRevisionV1({
      operationId: context.operationId,
      candidateId: "candidate-newer",
      projectId: context.candidate.projectId,
      taskId: context.candidate.taskId,
      revision: context.candidate.revision + 1,
      parentCandidateId: context.candidate.candidateId,
      sourceDigest: context.candidate.sourceDigest,
      worktree: context.candidate.worktree,
      createdAt: NOW
    }));
    let executeCount = 0;
    let reconcileCount = 0;

    await expect(executeGatedAction({
      root: context.root,
      request,
      execute: async () => {
        executeCount += 1;
        return { outcome: "SUCCEEDED" as const, evidence: {} };
      },
      reconcile: async (intent) => {
        reconcileCount += 1;
        return makeReconciliation(intent, "SUCCEEDED");
      },
      now: new Date(NOW)
    })).rejects.toThrow("TOOL_ACTION_POLICY_REQUIRED");

    expect(executeCount).toBe(0);
    expect(reconcileCount).toBe(0);
    await expect(loadActionIntent(context.root, context.operationId, "delivery:commit")).resolves.toBeUndefined();
    expect(await countReceipts(context)).toBe(0);
  });
});

interface GatedContext {
  root: string;
  operationId: string;
  candidate: CandidateRevisionV1;
  epoch: number;
}

async function createContext(operationId: string, options: { allowedExternalEffects?: ToolActionKindV1[] } = {}): Promise<GatedContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-gated-action-"));
  roots.push(root);
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: NOW, updatedAt: NOW });
  const candidate = (await loadOperation(root, operationId)).candidateRevision!;
  const owned = await claimControllerEpoch(root, operationId, `controller:${operationId}`, { pid: process.pid });
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: owned.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(owned),
    intent: "gated action test",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: {},
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: options.allowedExternalEffects ?? ["github.branch.create"],
    humanDecisionRequirements: []
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return { root, operationId, candidate, epoch: currentControllerEpoch(owned) };
}

function controllerRequest(context: GatedContext, action: ToolActionKindV1, actionKey: string, payload: unknown = { taskId: "T-1", action }, epoch = context.epoch): ToolActionRequestV1 {
  return {
    root: context.root,
    operationId: context.operationId,
    participantId: controllerActorId(context.operationId),
    candidate: context.candidate,
    actionKey,
    action,
    payload,
    authority: { kind: "controller-authority", operationId: context.operationId, controllerEpoch: epoch },
    now: new Date(NOW)
  };
}

function makeReconciliation(intent: ActionIntentV1, outcome: ActionReconciliationOutcomeV1, detail = `${outcome.toLowerCase()}-observed`): ActionReconciliationResultV1 {
  const evidence = { intentId: intent.intentId, action: intent.action, outcome, detail };
  return {
    version: 1,
    intentId: intent.intentId,
    action: intent.action,
    outcome,
    detail,
    evidenceDigest: sha256Canonical(evidence),
    evidence,
    reconciledAt: NOW
  };
}

async function countReceipts(context: GatedContext): Promise<number> {
  const directory = path.resolve(context.root, ".harness", "security", "tool-actions", sha256Utf8(context.operationId).slice(0, 32));
  try {
    return (await fs.readdir(directory)).filter((name) => name.endsWith(".receipt.json")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
