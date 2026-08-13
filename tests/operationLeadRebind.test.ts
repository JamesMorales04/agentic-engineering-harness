import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOperationCompletionTarget } from "../src/operations/completion.js";
import { rebindActiveOperationsToLead } from "../src/operations/leadBinding.js";
import { syncOperationPortfolio } from "../src/operations/portfolio.js";
import { loadOperation, saveOperation, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lead-rebind-"));
  roots.push(value);
  return value;
}
function operation(root: string, id: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "review" },
    revision: 4,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    lead: { agentId: "lead-old", generation: 1, boundAt: now, acknowledgedRevision: 2 },
    supervision: {
      required: true,
      materialized: true,
      activeGeneration: 1,
      generations: [{ generation: 1, agentId: "supervisor-1", status: "ACTIVE", createdAt: now, activatedAt: now }]
    },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 2, terminalDelivered: false, attempts: 0 }
  };
}
const config = { version: 1, project: { name: "demo" } } as never;

describe("operation lead rebinding", () => {
  it("moves active durable wake targets to the new lead without changing the active supervisor", async () => {
    const root = await tempRoot();
    const record = operation(root, "AUDIT-REBIND");
    await saveOperation(root, record);
    await syncOperationPortfolio(root, "demo", record);

    const rebound = await rebindActiveOperationsToLead(root, config, "lead-new", "lead-handoff");
    expect(rebound).toEqual(["AUDIT-REBIND"]);

    const current = await loadOperation(root, "AUDIT-REBIND");
    expect(current.lead).toEqual(expect.objectContaining({
      agentId: "lead-new",
      generation: 2,
      source: "lead-handoff"
    }));
    expect(current.supervision.generations[0]).toEqual(expect.objectContaining({
      agentId: "supervisor-1",
      status: "ACTIVE"
    }));
    expect(await loadOperationCompletionTarget(root, "AUDIT-REBIND")).toEqual(expect.objectContaining({
      agentId: "lead-new",
      status: "PENDING",
      source: "lead-handoff"
    }));
  });
});
