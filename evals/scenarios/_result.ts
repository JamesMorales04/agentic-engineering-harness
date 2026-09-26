import fs from "node:fs/promises";
import path from "node:path";

/**
 * Shared scenario result writer for the advisory eval corpus. A scenario
 * exercises real deterministic production subsystems against fixed inputs and
 * writes the run/report artifacts the eval runner scores. Scenario output is
 * an observation; it grants no authority and mutates no policy.
 */
export interface ScenarioCheck {
  id: string;
  status: "PASS" | "FAIL";
  message: string;
  details?: Record<string, unknown>;
}

export interface ScenarioResultInput {
  workspace: string;
  taskId: string;
  status: "PASS" | "FAIL";
  checks: ScenarioCheck[];
  metrics?: { firstPassSuccess?: boolean; repairCount?: number; humanInterventions?: number; costUsd?: number; durationMs?: number };
  report?: Record<string, unknown>;
}

export async function writeScenarioResult(input: ScenarioResultInput): Promise<void> {
  const runsDir = path.join(input.workspace, ".harness", "runs");
  const reportsDir = path.join(input.workspace, ".harness", "reports");
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  const report = input.report ?? {
    version: 1,
    taskId: input.taskId,
    status: input.status,
    checks: input.checks.map((check) => ({ id: check.id, category: "scenario", status: check.status, message: check.message, details: check.details })),
    changedFiles: [],
    findings: []
  };
  await fs.writeFile(path.join(reportsDir, `${input.taskId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(runsDir, `${input.taskId}.json`), `${JSON.stringify({
    taskId: input.taskId,
    status: input.status,
    checks: input.checks,
    metrics: {
      firstPassSuccess: input.metrics?.firstPassSuccess ?? input.status === "PASS",
      repairCount: input.metrics?.repairCount ?? 0,
      humanInterventions: input.metrics?.humanInterventions ?? 0,
      durationMs: input.metrics?.durationMs ?? 0,
      usage: { costUsd: input.metrics?.costUsd ?? 0 }
    }
  }, null, 2)}\n`);
  if (input.status === "FAIL") process.exitCode = 1;
}

export function scenarioWorkspace(): string {
  return path.resolve(process.argv[2] ?? process.cwd());
}
