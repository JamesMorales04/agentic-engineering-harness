import type { RunMetrics, ValidationReport } from "../core/types.js";

export interface EvalVariant {
  name: string;
  command?: string;
  env?: Record<string, string>;
}

export interface EvalCase {
  version: 1;
  id: string;
  taskId: string;
  baseRef: string;
  fixtureDir?: string;
  setupCommands?: string[];
  runCommand?: string;
  variants?: EvalVariant[];
  expectations?: {
    status?: "PASS" | "FAIL";
    maxRepairs?: number;
    maxHumanInterventions?: number;
    maxCostUsd?: number;
    requiredChecks?: string[];
  };
  weights?: {
    status?: number;
    firstPass?: number;
    repairs?: number;
    interventions?: number;
    efficiency?: number;
  };
}

export interface EvalResult {
  version: 1;
  caseId: string;
  variant: string;
  taskId: string;
  baseRef: string;
  status: "PASS" | "FAIL";
  commandExitCode: number;
  metrics?: RunMetrics;
  report?: ValidationReport;
  score: number;
  scoreBreakdown: Record<string, number>;
  startedAt: string;
  finishedAt: string;
  resultFile?: string;
}
