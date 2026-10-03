import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import {
  assertOperationCapacity,
  bindPortfolioLead,
  loadOperationPortfolio,
  syncOperationPortfolio
} from "../src/operations/portfolio.js";
import { claimControllerEpoch, loadOperation, saveOperation, transitionOperationToTerminal, type OperationRecordV2 } from "../src/operations/state.js";
import { compileOperationOriginV1 } from "../src/operations/operationProvenance.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-portfolio-"));
  roots.push(value);
  return value;
}
function operation(root: string, id: string, priority: number): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "RUNNING",
    phase: "implementation",
    root,
    workspaceId: `workspace-${id}`,
    payload: { request: id, priority },
    intent: { classification: "CHANGE", request: id, priority },
    revision: priority + 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    origin: compileOperationOriginV1({
      kind: "USER_REQUEST", leadAgentId: "lead-1", controllerOwnerId: "controller:portfolio-test", requestEventId: `request:${id}`,
      authorizationDigest: sha256Canonical(`authorization:${id}`), userTurnId: `turn:${id}`, triggerEventId: `user.turn:turn:${id}`,
      requestDigest: sha256Canonical({ request: id }), recoveryDepth: 0,
      rootHardDeadlineAt: new Date(Date.parse(now) + 8 * 60 * 60_000).toISOString(), reason: id, createdAt: now
    }),
    lead: {
      agentId: "lead-1",
      generation: 1,
      boundAt: now,
      acknowledgedRevision: priority,
      acknowledgedAt: now
    },
    supervision: {
      required: true,
      materialized: true,
      activeGeneration: 1,
      generations: [{ generation: 1, agentId: `supervisor-${id}`, status: "ACTIVE", createdAt: now, activatedAt: now }]
    },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: priority, terminalDelivered: false, attempts: 0 }
  };
}
const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { operations: { concurrency: { maxActiveOperations: 2 } } }
} as never;

describe("operation portfolio", () => {
  it("tracks multiple concurrent workspaces and supervisors at operation granularity", async () => {
    const root = await tempRoot();
    await syncOperationPortfolio(root, "demo", operation(root, "CHANGE-A", 80));
    await syncOperationPortfolio(root, "demo", operation(root, "AUDIT-B", 50));
    const portfolio = await loadOperationPortfolio(root, "demo");

    expect(Object.keys(portfolio.operations).sort()).toEqual(["AUDIT-B", "CHANGE-A"]);
    expect(portfolio.operations["CHANGE-A"]).toEqual(expect.objectContaining({
      workspaceId: "workspace-CHANGE-A",
      supervisorAgentId: "supervisor-CHANGE-A",
      priority: 80,
      revision: 81,
      acknowledgedRevision: 80
    }));
  });

  it("rebinds portfolio lead generation without rewriting operation-specific supervisors", async () => {
    const root = await tempRoot();
    await syncOperationPortfolio(root, "demo", operation(root, "CHANGE-A", 80));
    const rebound = await bindPortfolioLead(root, "demo", "lead-2");
    expect(rebound.leadAgentId).toBe("lead-2");
    expect(rebound.leadGeneration).toBe(2);
    expect(rebound.operations["CHANGE-A"].supervisorAgentId).toBe("supervisor-CHANGE-A");
  });

  it("hydrates stale portfolio status and lineage fields from durable OperationRecords", async () => {
    const root = await tempRoot();
    const record = operation(root, "CHANGE-DURABLE", 50);
    await saveOperation(root, record);
    await syncOperationPortfolio(root, "demo", record);
    await claimControllerEpoch(root, record.id, "controller:portfolio-hydration", { pid: process.pid });
    const terminal = await transitionOperationToTerminal(root, record.id, { status: "FAILED", phase: "failed", error: "terminal fixture" });

    const portfolio = await loadOperationPortfolio(root, "demo", { currentLeadAgentId: "lead-2", currentUserTurnId: "another-turn" });
    expect(portfolio.operations[record.id]).toMatchObject({
      status: "FAILED",
      revision: terminal.record.revision,
      boundLeadAgentId: "lead-1",
      leadRelationship: "BOUND_OTHER_LEAD",
      lineageRelationship: "HISTORICAL_UNRELATED",
      ownerAttention: "CHAIN_SCOPED_BOUNDARY"
    });
    expect((await loadOperation(root, record.id)).status).toBe("FAILED");
  });

  it("fails closed when the configured active-operation portfolio limit is exhausted", async () => {
    const root = await tempRoot();
    await syncOperationPortfolio(root, "demo", operation(root, "CHANGE-A", 80));
    await syncOperationPortfolio(root, "demo", operation(root, "CHANGE-B", 40));
    await expect(assertOperationCapacity(root, config, 60)).rejects.toThrow("AEH_OPERATION_CAPACITY");
  });
});
