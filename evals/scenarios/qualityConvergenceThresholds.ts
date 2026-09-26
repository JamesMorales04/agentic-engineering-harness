import { analyzeQualityState, evaluateFinalQualityGate } from "../../src/agents/qualityConvergence.js";
import type { NormalizedFinding } from "../../src/agents/outputContracts.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { scenarioWorkspace, writeScenarioResult } from "./_result.js";

const workspace = scenarioWorkspace();
const taskId = "EVAL-QUALITY-1";
const config: HarnessProjectConfig = { version: 1, project: { name: "eval-quality-fixture" }, telemetry: { enabled: false } };

function finding(id: string, severity: NormalizedFinding["severity"]): NormalizedFinding {
  return {
    id,
    severity,
    category: "correctness",
    location: { file: "src/feature.ts", startLine: 1, endLine: 2 },
    evidence: "deterministic scenario evidence",
    impact: "fixture impact",
    recommendedFix: "apply the fixture remediation",
    requiredCompetencies: ["typescript"],
    reviewDimensions: ["correctness"]
  };
}

const clean = evaluateFinalQualityGate([finding("F-NOTE", "note")], config);
const critical = evaluateFinalQualityGate([finding("F-CRITICAL", "critical")], config);
const lowWithinBudget = evaluateFinalQualityGate([finding("F-LOW-1", "low"), finding("F-LOW-2", "low"), finding("F-LOW-3", "low")], config);
const state = analyzeQualityState([finding("F-CRITICAL", "critical")], [], config, "candidate:fixture:r1");

const checks = [
  { id: "quality.clean-gate-passes", status: clean.pass ? "PASS" as const : "FAIL" as const, message: `reasons=${clean.reasons.join("; ") || "none"}` },
  { id: "quality.critical-blocks", status: !critical.pass && critical.reasons.some((reason) => reason.includes("critical")) ? "PASS" as const : "FAIL" as const, message: `reasons=${critical.reasons.join("; ") || "none"}` },
  { id: "quality.low-budget", status: lowWithinBudget.pass ? "PASS" as const : "FAIL" as const, message: `low=${lowWithinBudget.counts.low} reasons=${lowWithinBudget.reasons.join("; ") || "none"}` },
  { id: "quality.remediation-required", status: state.gate.pass === false && state.candidateDigest === "candidate:fixture:r1" ? "PASS" as const : "FAIL" as const, message: `convergence=${state.convergence} candidateDigest=${state.candidateDigest}` }
];
const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
await writeScenarioResult({ workspace, taskId, status, checks, metrics: { firstPassSuccess: status === "PASS", repairCount: 1, humanInterventions: 0, costUsd: 0 } });
