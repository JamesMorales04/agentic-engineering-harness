import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFeatureCapsule,
  assertIntentDecision,
  createIntentDecision,
  createRouteEvidence,
  parseFeatureCapsule,
  serializeFeatureCapsule,
  validateFeatureCapsule,
  validateIntentDecision
} from "../src/architecture/index.js";
import { createDelegatedFeatureCapsule, persistFeatureCapsule } from "../src/architecture/index.js";

const evidence = createRouteEvidence("DELEGATED", "scope", "The feature crosses an independent implementation boundary.");

function capsule() {
  return {
    version: 1 as const,
    featureId: "feature-routing",
    intent: "implement bounded feature",
    route: "DELEGATED" as const,
    assurance: "ELEVATED" as const,
    routeEvidence: [evidence],
    progress: { total: 2, completed: 1, inProgress: 1, blocked: 0 },
    workUnits: [
      { id: "design", title: "Define contract", status: "COMPLETED" as const },
      { id: "implementation", title: "Implement contract", status: "IN_PROGRESS" as const, dependsOn: ["design"] }
    ]
  };
}

describe("AEH Core Architecture v2 contracts", () => {
  it("validates intent decisions and rejects malformed or contradictory route evidence", () => {
    const decision = createIntentDecision("change", "DIRECT", "STANDARD", [createRouteEvidence("DIRECT", "scope", "Only one bounded file is required.")]);
    expect(assertIntentDecision(decision)).toEqual(decision);
    expect(validateIntentDecision({ ...decision, route: "DELEGATED" })).toMatchObject({ ok: false });
    expect(validateIntentDecision({ ...decision, routeEvidence: [{ ...decision.routeEvidence[0], route: "DELEGATED" }] })).toMatchObject({ ok: false });
    expect(() => assertIntentDecision({ ...decision, assurance: "unknown" })).toThrow("INVALID_ARCHITECTURE_CONTRACT");
  });

  it("keeps implementation route and assurance as independently validated dimensions", () => {
    const noAgentCritical = createIntentDecision("explain", "NO_AGENT", "CRITICAL", [createRouteEvidence("NO_AGENT", "policy", "No implementation agent is needed.")]);
    const delegatedNone = createIntentDecision("implement", "DELEGATED", "NONE", [evidence]);
    expect(noAgentCritical).toMatchObject({ route: "NO_AGENT", assurance: "CRITICAL" });
    expect(delegatedNone).toMatchObject({ route: "DELEGATED", assurance: "NONE" });
    expect(assertIntentDecision(noAgentCritical).assurance).toBe("CRITICAL");
  });

  it("asserts compact progress/work-unit capsules and rejects inconsistent counts", () => {
    expect(assertFeatureCapsule(capsule()).workUnits).toHaveLength(2);
    expect(validateFeatureCapsule({ ...capsule(), progress: { ...capsule().progress, total: 3 } })).toMatchObject({ ok: false });
    expect(validateFeatureCapsule({ ...capsule(), workUnits: [capsule().workUnits[0], capsule().workUnits[0]] })).toMatchObject({ ok: false });
  });

  it("round-trips as compact durable JSON with stable serialization", () => {
    const value = capsule();
    const serialized = serializeFeatureCapsule(value);
    expect(serialized).not.toContain("\n");
    expect(serialized).not.toContain("  ");
    expect(serialized).toBe(serializeFeatureCapsule({ ...value }));
    expect(parseFeatureCapsule(serialized)).toEqual(value);
  });

  it("accepts the full task/objective/scope capsule shape", () => {
    const value = {
      version: 1 as const,
      taskId: "TASK-V2-1",
      objective: "make candidate completion evidence durable",
      scope: { allowed: ["src/operations/**"], forbidden: ["dist/**"] },
      constraints: { noNetwork: true },
      acceptance: ["stale receipts are rejected"],
      contextRefs: ["ctx-1"],
      route: "DELEGATED" as const,
      assurance: "ELEVATED" as const,
      routeEvidence: [evidence],
      candidateRevision: { operationId: "op-1", revision: 1 },
      progress: { total: 0, completed: 0, inProgress: 0, blocked: 0 },
      workUnits: []
    };
    expect(assertFeatureCapsule(value)).toEqual(value);
    expect(parseFeatureCapsule(serializeFeatureCapsule(value))).toEqual(value);
  });

  it("persists delegated work as a compact capsule rather than an SDD tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-feature-capsule-"));
    try {
      const value = createDelegatedFeatureCapsule({ taskId: "DELEGATED-1", objective: "coordinate a bounded change", scope: { allowed: ["src/**"] }, assurance: "STANDARD", routeEvidence: [evidence] });
      const file = await persistFeatureCapsule(root, value);
      expect(file).toBe(".harness/capsules/DELEGATED-1.json");
      expect(JSON.parse(await fs.readFile(path.join(root, file), "utf8"))).toMatchObject({ route: "DELEGATED", taskId: "DELEGATED-1", progress: { total: 0 } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
