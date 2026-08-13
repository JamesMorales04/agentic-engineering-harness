import { describe, expect, it } from "vitest";
import { evaluateOperationWake, operationLivenessPolicy } from "../src/operations/liveness.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo" } } as never;

describe("operation stalled-supervisor escalation", () => {
  it("escalates an unchanged stalled revision after the bounded supervisor wake budget", () => {
    const now = Date.now();
    const record: OperationRecordV2 = {
      version: 2, id: "AUDIT-STALL", kind: "audit", status: "RUNNING", phase: "reviewing", root: "/repo",
      payload: { request: "review" }, revision: 7,
      createdAt: new Date(now - 600_000).toISOString(), updatedAt: new Date(now - 300_000).toISOString(), lastProgressAt: new Date(now - 300_000).toISOString(),
      lead: { agentId: "lead-1", generation: 1, boundAt: new Date(now - 600_000).toISOString(), acknowledgedRevision: 6 },
      supervision: { required: true, materialized: true, activeGeneration: 1, generations: [{ generation: 1, agentId: "supervisor-1", status: "ACTIVE", createdAt: new Date(now - 600_000).toISOString() }] },
      stages: {}, participants: {}, progress: { expected: 4, registered: 4, running: 1, completed: 3, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 6, terminalDelivered: false, attempts: 0 }
    };
    const policy = operationLivenessPolicy(config);
    expect(evaluateOperationWake(record, policy, now, 0).target).toBe("supervisor");
    expect(evaluateOperationWake(record, policy, now, 1).target).toBe("supervisor");
    const escalated = evaluateOperationWake(record, policy, now, 2);
    expect(escalated).toEqual(expect.objectContaining({ reason: "stalled", target: "lead", revision: 7 }));
    expect(escalated.message).toContain("2/2");
  });
});
