import type { EvalCase, EvalResult } from "./types.js";

export function scoreEvalResult(evalCase: EvalCase, input: Omit<EvalResult, "score" | "scoreBreakdown">): Pick<EvalResult, "score" | "scoreBreakdown"> {
  const weights = {
    status: evalCase.weights?.status ?? 60,
    firstPass: evalCase.weights?.firstPass ?? 15,
    repairs: evalCase.weights?.repairs ?? 10,
    interventions: evalCase.weights?.interventions ?? 10,
    efficiency: evalCase.weights?.efficiency ?? 5
  };
  const expectedStatus = evalCase.expectations?.status ?? "PASS";
  const breakdown: Record<string, number> = {};
  breakdown.status = input.status === expectedStatus ? weights.status : 0;
  breakdown.firstPass = input.metrics?.firstPassSuccess ? weights.firstPass : 0;

  const repairs = input.metrics?.repairCount ?? Number.POSITIVE_INFINITY;
  const repairBudget = evalCase.expectations?.maxRepairs ?? 2;
  breakdown.repairs = Number.isFinite(repairs) && repairs <= repairBudget
    ? weights.repairs * Math.max(0, 1 - repairs / (repairBudget + 1))
    : 0;

  const interventions = input.metrics?.humanInterventions ?? Number.POSITIVE_INFINITY;
  const interventionBudget = evalCase.expectations?.maxHumanInterventions ?? 0;
  breakdown.interventions = Number.isFinite(interventions) && interventions <= interventionBudget ? weights.interventions : 0;

  const maxCost = evalCase.expectations?.maxCostUsd;
  const cost = input.metrics?.usage.costUsd;
  breakdown.efficiency = maxCost === undefined
    ? weights.efficiency
    : cost !== undefined && cost <= maxCost
      ? weights.efficiency * Math.max(0, 1 - cost / Math.max(maxCost, 0.000001) * 0.5)
      : 0;

  if (evalCase.expectations?.requiredChecks?.length && input.report) {
    const checks = new Map(input.report.checks.map((check) => [check.id, check.status]));
    const missing = evalCase.expectations.requiredChecks.filter((id) => checks.get(id) !== "PASS");
    if (missing.length) breakdown.status = 0;
  }

  const score = round(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  return { score, scoreBreakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, round(value)])) };
}

export function rankEvalResults(results: EvalResult[]): EvalResult[] {
  return [...results].sort((a, b) => b.score - a.score || (a.metrics?.usage.costUsd ?? Infinity) - (b.metrics?.usage.costUsd ?? Infinity));
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }
