import { resourceClaimConflicts, validateWorkGraph, type WorkGraphV1 } from "../../src/architecture/workGraph.js";
import { scenarioWorkspace, writeScenarioResult } from "./_result.js";

const workspace = scenarioWorkspace();
const taskId = "EVAL-SCOPE-1";

function unit(id: string, dependencies: string[], resourceClaims: WorkGraphV1["units"][number]["resourceClaims"] = []) {
  return {
    version: 1 as const,
    id,
    objective: `Deliver ${id}`,
    scope: [`src/${id}.ts`],
    dependencies,
    requirementRefs: ["REQ-1"],
    acceptanceRefs: ["ACC-1"],
    competencies: ["typescript"],
    riskTags: [],
    changeKinds: ["source" as const],
    risk: "low" as const,
    status: "PENDING" as const,
    resourceClaims
  };
}

function graph(units: WorkGraphV1["units"]): WorkGraphV1 {
  return { version: 1, taskId, objective: "Scope governance evaluation", route: "DELEGATED", assurance: "STANDARD", requirementRefs: ["REQ-1"], acceptanceRefs: ["ACC-1"], units };
}

const valid = validateWorkGraph(graph([unit("alpha", []), unit("beta", ["alpha"])]));
const duplicateRejected = rejectionOf(() => validateWorkGraph(graph([unit("alpha", []), unit("alpha", [])])));
const missingDependencyRejected = rejectionOf(() => validateWorkGraph(graph([unit("alpha", ["missing"])])));
const exclusiveConflict = resourceClaimConflicts(
  [{ version: 1, resource: "schema:migrations", mode: "EXCLUSIVE_WRITE" }],
  [{ version: 1, resource: "schema:migrations", mode: "EXCLUSIVE_WRITE" }]
);
const sharedRead = resourceClaimConflicts(
  [{ version: 1, resource: "src/shared.ts", mode: "SHARED_READ" }],
  [{ version: 1, resource: "src/shared.ts", mode: "SHARED_READ" }]
);

const checks = [
  { id: "workgraph.valid", status: valid.units.length === 2 ? "PASS" as const : "FAIL" as const, message: `Validated graph with ${valid.units.length} units.` },
  { id: "workgraph.duplicate-rejected", status: duplicateRejected ? "PASS" as const : "FAIL" as const, message: duplicateRejected ?? "duplicate unit id was not rejected" },
  { id: "workgraph.missing-dependency-rejected", status: missingDependencyRejected ? "PASS" as const : "FAIL" as const, message: missingDependencyRejected ?? "missing dependency was not rejected" },
  { id: "workgraph.exclusive-write-conflict", status: exclusiveConflict.length > 0 ? "PASS" as const : "FAIL" as const, message: `Exclusive-write conflicts: ${exclusiveConflict.join("; ")}` },
  { id: "workgraph.shared-read-compatible", status: sharedRead.length === 0 ? "PASS" as const : "FAIL" as const, message: `Shared-read conflicts: ${sharedRead.join("; ")}` }
];
const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
await writeScenarioResult({ workspace, taskId, status, checks, metrics: { firstPassSuccess: status === "PASS", repairCount: 0, humanInterventions: 0, costUsd: 0 } });

function rejectionOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
