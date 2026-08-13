import { describe, expect, it } from "vitest";
import { supervisorOutputSchema } from "../src/agents/outputContracts.js";
import { supervisorEventSkills } from "../src/operations/supervisorEventPolicy.js";
import {
  compactDeterministicEvidence,
  supervisorCheckpointProjection,
  supervisorConsolidationProjection,
  supervisorInitializationProjection
} from "../src/operations/supervisorPrompt.js";

const operation = {
  id: "AUDIT-POLICY",
  kind: "audit",
  revision: 12,
  phase: "consolidating",
  status: "RUNNING",
  intent: { request: "large user intent" },
  lead: { generation: 1, acknowledgedRevision: 3 },
  stages: { reviewing: { name: "reviewing", status: "COMPLETED", revision: 10 } },
  progress: { expected: 4, registered: 4, running: 0, completed: 4, failed: 0, blocked: 0 },
  supervision: { materialized: true, required: true, generations: [], latestConsolidationArtifact: "old.json" },
  participants: {}
} as never;

describe("supervisor semantic prompt policy", () => {
  it("selects semantic skills by event instead of keeping a permanent supervisor skill bundle", () => {
    expect(supervisorEventSkills("initialize", "audit", false)).toEqual([]);
    expect(supervisorEventSkills("handoff", "audit", true)).toEqual([]);
    expect(supervisorEventSkills("recover", "audit", false)).toEqual(["recovery-classifier"]);
    expect(supervisorEventSkills("coordinate", "change", false)).toEqual(["verification-planning"]);
    expect(supervisorEventSkills("coordinate", "change", true)).toEqual(["verification-planning", "acceptance-traceability"]);
    expect(supervisorEventSkills("consolidate", "audit", false)).toEqual(["finding-dedup", "audit-consolidation-protocol"]);
    expect(supervisorEventSkills("consolidate", "audit", true)).toEqual(["finding-dedup", "audit-consolidation-protocol", "acceptance-traceability"]);
  });

  it("uses minimal per-turn projections while retaining rich durable checkpoint continuity", () => {
    const init = supervisorInitializationProjection(operation, 2);
    expect(init).toEqual({
      operationId: "AUDIT-POLICY",
      kind: "audit",
      revision: 12,
      generation: 2,
      status: "RUNNING"
    });
    expect(init).not.toHaveProperty("intent");
    expect(init).not.toHaveProperty("stages");

    const consolidation = supervisorConsolidationProjection(operation);
    expect(consolidation).not.toHaveProperty("intent");
    expect(consolidation).not.toHaveProperty("stages");
    expect(consolidation).toEqual(expect.objectContaining({
      progress: expect.objectContaining({ completed: 4, failed: 0 })
    }));

    const checkpoint = supervisorCheckpointProjection(operation, 0.8);
    expect(checkpoint).toHaveProperty("intent");
    expect(checkpoint).toHaveProperty("stages");
    expect(checkpoint).toHaveProperty("contextRatio", 0.8);
  });

  it("compacts passing deterministic evidence but keeps bounded failure diagnostics", () => {
    const compact = compactDeterministicEvidence([
      { id: "pass", status: "PASS", details: { exitCode: 0, stdout: "very verbose pass", stderr: "noise", summary: { testsPassed: 260 } } },
      { id: "fail", status: "FAIL", details: { exitCode: 1, stderr: "expected one received two", stdout: "failure context" } }
    ]) as Array<Record<string, any>>;
    expect(compact[0].details).not.toHaveProperty("stdout");
    expect(compact[0].details).not.toHaveProperty("stderr");
    expect(compact[0].details.summary.testsPassed).toBe(260);
    expect(compact[1].details.stderr).toContain("expected one received two");
    expect(compact[1].details.stdout).toContain("failure context");
  });

  it("supports a structured prioritized supervisor roadmap without breaking older payloads", () => {
    const base = {
      summary: "done",
      consolidatedFindings: [],
      sourceFindingIds: [],
      conflicts: [],
      missingEvidence: [],
      unresolved: [],
      finalizationSafety: "SAFE"
    };
    expect(supervisorOutputSchema.parse(base).roadmap).toEqual([]);
    expect(supervisorOutputSchema.parse({
      ...base,
      roadmap: [{ phase: "Immediate", priority: "P0", actions: ["fix lifecycle"], findingIds: ["F-1"] }]
    }).roadmap).toEqual([
      { phase: "Immediate", priority: "P0", actions: ["fix lifecycle"], findingIds: ["F-1"] }
    ]);
  });
});
