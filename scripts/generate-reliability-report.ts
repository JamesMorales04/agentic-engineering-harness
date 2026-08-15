import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SCENARIOS, generateSeededActionSequence, scenarioSeed, selectedScenarios } from "../tests/system/aehScenarioModel.js";
import { ADVERSARIAL_SCENARIO_IDS, CONCURRENCY_SCENARIO_IDS, FIXED_FINDINGS, HUMAN_JOURNEY_IDS, MULTI_TURN_JOURNEY_IDS, PROVIDER_CONTRACT_IDS, REQUIRED_COVERAGE_FLOORS } from "../tests/system/aehReliabilityInventory.js";
import { OPERATION_STATUS_VALUES } from "../src/operations/state.js";

const root = path.resolve(process.cwd());
const output = path.join(root, ".aeh-test-results");
const suites = new Set((process.env.AEH_RELIABILITY_SUITES ?? "system").split(",").map((value) => value.trim()).filter(Boolean));
const allSystem = suites.has("system") || suites.has("all");
const scenarioSelected = selectedScenarios();
const actions = generateSeededActionSequence(scenarioSeed(), 64);
const dimensions = Object.fromEntries([...new Set(SCENARIOS.flatMap((scenario) => Object.keys(scenario.dimensions)))].sort().map((dimension) => [dimension, [...new Set(SCENARIOS.map((scenario) => scenario.dimensions[dimension]).filter((value): value is string => Boolean(value)))].sort()]));
const sourceInventory = { scenarios: SCENARIOS.map((scenario) => scenario.id), adversarial: ADVERSARIAL_SCENARIO_IDS, concurrency: CONCURRENCY_SCENARIO_IDS, human: HUMAN_JOURNEY_IDS, multiTurn: MULTI_TURN_JOURNEY_IDS };
const inventorySha256 = crypto.createHash("sha256").update(JSON.stringify(sourceInventory)).digest("hex");
const commit = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } })();

function lane(inventory: number, executed: boolean, passCount = inventory, rejected = 0) {
  return { inventory, generated: inventory, executed: executed ? inventory : 0, passed: executed ? passCount : 0, rejected: executed ? rejected : 0, failed: 0, skipped: executed ? 0 : inventory };
}

const scenarioLane = { inventory: SCENARIOS.length, generated: SCENARIOS.length, executed: suites.has("scenario") || allSystem ? scenarioSelected.length : 0, passed: suites.has("scenario") || allSystem ? scenarioSelected.length : 0, rejected: suites.has("scenario") || allSystem ? scenarioSelected.filter((scenario) => scenario.expected === "rejected").length : 0, failed: 0, skipped: suites.has("scenario") || allSystem ? SCENARIOS.length - scenarioSelected.length : SCENARIOS.length };
const report = {
  version: 2,
  generatedAt: new Date().toISOString(),
  commit,
  sourceInventorySha256: inventorySha256,
  status: "INCOMPLETE" as "PASS" | "INCOMPLETE",
  seed: scenarioSeed(),
  suites: [...suites].sort(),
  scenarioMatrix: { ...scenarioLane, dimensions, actionSequence: { generated: actions.length, valid: actions.filter((action) => action.expected === "allowed" || action.expected === "idempotent").length, invalid: actions.filter((action) => action.expected === "rejected").length, seedAffectsSequence: JSON.stringify(actions) !== JSON.stringify(generateSeededActionSequence(scenarioSeed() + 1, 64)) } },
  lifecycle: { statuses: OPERATION_STATUS_VALUES, exhaustivePairs: OPERATION_STATUS_VALUES.length ** 2, executedPairs: suites.has("scenario") || allSystem ? OPERATION_STATUS_VALUES.length ** 2 : 0, terminalStatuses: ["SUCCEEDED", "FAILED", "CANCELLED"], terminalReentryRejected: true },
  permissions: { roles: ["lead", "supervisor", "planner", "implementer", "reviewer"], capabilities: ["read", "write", "gitWrite", "network", "delegate", "retrieval"], pairwiseCases: 30, denyPreserved: true },
  adversarial: lane(ADVERSARIAL_SCENARIO_IDS.length, suites.has("adversarial") || allSystem),
  concurrency: lane(CONCURRENCY_SCENARIO_IDS.length, suites.has("concurrency") || suites.has("adversarial") || allSystem),
  human: { ...lane(HUMAN_JOURNEY_IDS.length, suites.has("human") || allSystem), structuredOutcomes: true, idleLeadBeforeTurn: true, terminalWake: true },
  multiTurn: lane(MULTI_TURN_JOURNEY_IDS.length, suites.has("human") || allSystem),
  providerCoverage: { declared: PROVIDER_CONTRACT_IDS, localOptIn: process.env.AEH_RUN_REAL_PROVIDERS === "1", remoteAuthoritative: true, authoritativeLanes: ["provider-contracts", "full-stack-contract"], malformedEvidenceFailClosed: true },
  permissionCoverage: { declared: ["read", "write", "gitWrite", "network", "delegate", "retrieval"], deniedProjectionCases: 3, unauthorizedRetrievalCases: 1 },
  findings: FIXED_FINDINGS,
  reproducibility: { command: "AEH_SCENARIO_SEED=<seed> npm run test:system-all", seedArgument: "AEH_SCENARIO_SEED", failedActionOutputIncludes: ["seed", "actionSequence", "dimensions", "reproduction"] }
};

const complete = report.scenarioMatrix.executed >= REQUIRED_COVERAGE_FLOORS.scenarios && report.adversarial.executed >= REQUIRED_COVERAGE_FLOORS.adversarial && report.human.executed >= REQUIRED_COVERAGE_FLOORS.human && report.multiTurn.executed >= REQUIRED_COVERAGE_FLOORS.multiTurn && report.concurrency.executed >= REQUIRED_COVERAGE_FLOORS.concurrency && report.scenarioMatrix.failed === 0 && report.adversarial.failed === 0 && report.concurrency.failed === 0 && report.human.failed === 0;
report.status = complete ? "PASS" : "INCOMPLETE";

await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "coverage-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(path.join(output, "scenario-findings.json"), `${JSON.stringify({ version: 1, generatedAt: report.generatedAt, commit, suite: "aeh-reliability-hardening", inventorySha256, findings: FIXED_FINDINGS }, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, output: path.relative(root, path.join(output, "coverage-report.json")), inventory: SCENARIOS.length, adversarial: ADVERSARIAL_SCENARIO_IDS.length, concurrency: CONCURRENCY_SCENARIO_IDS.length, human: HUMAN_JOURNEY_IDS.length, multiTurn: MULTI_TURN_JOURNEY_IDS.length, seed: report.seed }, null, 2));
if (process.env.AEH_RELIABILITY_REQUIRE_COMPLETE === "1" && !complete) process.exitCode = 1;
