import fs from "node:fs/promises";
import path from "node:path";
import { loadTaskContract } from "../../src/core/config.js";
import { sealTask } from "../../src/core/seal.js";
import { verifyTask } from "../../src/core/verify.js";
import { buildRequirementEvidenceGraph } from "../../src/evidence/graph.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { scenarioWorkspace, writeScenarioResult } from "./_result.js";

const workspace = scenarioWorkspace();
const taskId = "EVAL-VALIDATION-1";
const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "eval-validation-fixture" },
  sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" },
  validation: { baseRef: "HEAD", requireSeal: true, commands: [{ id: "smoke", command: "node -e \"process.exit(0)\"", required: true }] },
  evidence: { enabled: true, outputDir: ".harness/evidence", requireComplete: true },
  telemetry: { enabled: false }
};

const contract = await loadTaskContract(workspace, taskId, config);
await fs.appendFile(path.join(workspace, "src", "feature.ts"), "\nexport const accepted = true;\n");
await sealTask(workspace, config, contract);
const report = await verifyTask(workspace, config, contract);
const graph = await buildRequirementEvidenceGraph({ root: workspace, config, contract, report });
const checks = [
  ...report.checks.map((check) => ({ id: check.id, status: check.status === "FAIL" ? "FAIL" as const : "PASS" as const, message: check.message })),
  { id: "evidence.graph", status: graph.complete ? "PASS" as const : "FAIL" as const, message: `RequirementEvidenceGraph complete=${graph.complete} sha256=${graph.sha256}.` }
];
const status = report.status === "PASS" && graph.complete ? "PASS" : "FAIL";
await writeScenarioResult({ workspace, taskId, status, checks, metrics: { firstPassSuccess: status === "PASS", repairCount: 0, humanInterventions: 0, costUsd: 0 } });
