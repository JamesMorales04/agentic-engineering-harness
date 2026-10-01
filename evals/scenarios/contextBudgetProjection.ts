import { ContextBudgetGateway } from "../../src/context/gateway.js";
import type { ContextFragment } from "../../src/context/types.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { scenarioWorkspace, writeScenarioResult } from "./_result.js";

const workspace = scenarioWorkspace();
const taskId = "EVAL-CONTEXT-1";
const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "eval-context-fixture" },
  telemetry: { enabled: false },
  context: { mode: "enforce", semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false }, retrieval: { maxRequestsPerTurn: 2, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 200 } }
};

const verbatimContent = "sealed acceptance text\n\u2028exact anchor";
const fragments: ContextFragment[] = [
  { id: "normative", kind: "normative", preservation: "VERBATIM", priority: 100, content: verbatimContent },
  { id: "repository", kind: "repository-map", preservation: "PROJECTABLE", priority: 50, content: "src/feature.ts exports accepted" },
  { id: "scratch", kind: "tool-output", preservation: "DISCARDABLE", priority: 1, content: "discardable scratch output" }
];

const gateway = new ContextBudgetGateway(workspace, config, { telemetry: false });
const result = await gateway.prepare({ operationId: taskId, logicalAgent: "reviewer", phase: "review", fragments, capabilities: { authorizedRetrieval: false, semanticRetrieval: false } });
const delivered = result.envelope.fragments;
const normative = delivered.find((fragment) => fragment.id === "normative");
const scratch = delivered.find((fragment) => fragment.id === "scratch");

const checks = [
  { id: "context.verbatim-preserved", status: normative?.content === verbatimContent ? "PASS" as const : "FAIL" as const, message: normative ? `Normative content bytes preserved: ${normative.content === verbatimContent}.` : "Normative fragment was not delivered." },
  { id: "context.discardable-dropped", status: scratch ? "FAIL" as const : "PASS" as const, message: scratch ? "Discardable fragment was delivered." : "Discardable fragment was discarded." },
  { id: "context.budget-accounted", status: result.metrics.deliveredBytes <= result.metrics.rawBytes ? "PASS" as const : "FAIL" as const, message: `deliveredBytes=${result.metrics.deliveredBytes} rawBytes=${result.metrics.rawBytes}` },
  { id: "context.rendered", status: result.rendered.includes("AEH ContextEnvelope") ? "PASS" as const : "FAIL" as const, message: "Rendered envelope present." }
];
const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
await writeScenarioResult({ workspace, taskId, status, checks, metrics: { firstPassSuccess: status === "PASS", repairCount: 0, humanInterventions: 0, costUsd: 0 } });
