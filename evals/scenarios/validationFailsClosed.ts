import fs from "node:fs/promises";
import path from "node:path";
import { loadTaskContract } from "../../src/core/config.js";
import { sealTask } from "../../src/core/seal.js";
import { verifyTask } from "../../src/core/verify.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { scenarioWorkspace, writeScenarioResult } from "./_result.js";

const workspace = scenarioWorkspace();
const taskId = "EVAL-VALIDATION-2";
const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "eval-validation-fails-closed" },
  sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports", runsDir: ".harness/runs" },
  validation: { baseRef: "HEAD", requireSeal: true, commands: [{ id: "smoke", command: "node -e \"process.exit(1)\"", required: true }] },
  evidence: { enabled: true, outputDir: ".harness/evidence", requireComplete: false },
  telemetry: { enabled: false }
};

const contract = await loadTaskContract(workspace, taskId, config);
await fs.appendFile(path.join(workspace, "src", "feature.ts"), "\nexport const regression = true;\n");
await sealTask(workspace, config, contract);
const report = await verifyTask(workspace, config, contract);
const checks = report.checks.map((check) => ({ id: check.id, status: check.status === "FAIL" ? "FAIL" as const : "PASS" as const, message: check.message }));
const failedRequired = report.checks.some((check) => check.id === "command.smoke" && check.status === "FAIL");
const status = report.status === "FAIL" && failedRequired ? "FAIL" : "PASS";
await writeScenarioResult({ workspace, taskId, status, checks, metrics: { firstPassSuccess: false, repairCount: 0, humanInterventions: 0, costUsd: 0 } });
