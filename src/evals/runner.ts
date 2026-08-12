import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import { runProcess } from "../utils/process.js";
import { rankEvalResults, scoreEvalResult } from "./scoring.js";
import type { EvalCase, EvalResult, EvalVariant } from "./types.js";

const variantSchema = z.object({ name: z.string().min(1), command: z.string().optional(), env: z.record(z.string(), z.string()).optional() });
const evalSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  baseRef: z.string().min(1),
  fixtureDir: z.string().optional(),
  setupCommands: z.array(z.string()).optional(),
  runCommand: z.string().optional(),
  variants: z.array(variantSchema).optional(),
  expectations: z.object({
    status: z.enum(["PASS", "FAIL"]).optional(),
    maxRepairs: z.number().int().nonnegative().optional(),
    maxHumanInterventions: z.number().int().nonnegative().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    requiredChecks: z.array(z.string()).optional()
  }).optional(),
  weights: z.object({ status: z.number().nonnegative().optional(), firstPass: z.number().nonnegative().optional(), repairs: z.number().nonnegative().optional(), interventions: z.number().nonnegative().optional(), efficiency: z.number().nonnegative().optional() }).optional()
});

export async function runEvalCase(root: string, config: HarnessProjectConfig, caseId: string, variantName?: string): Promise<EvalResult> {
  const evalCase = await loadEvalCase(root, config, caseId);
  const variant = selectVariant(evalCase, variantName);
  const startedAt = new Date().toISOString();
  const workspace = path.resolve(root, config.evals?.workspacesDir ?? ".harness/evals/workspaces", `${safe(caseId)}-${Date.now()}`);
  await fs.mkdir(path.dirname(workspace), { recursive: true });

  const add = await runProcess(`git worktree add --detach ${quote(workspace)} ${quote(evalCase.baseRef)}`, { cwd: root, timeoutMs: 120_000 });
  if (add.exitCode !== 0) throw new Error(`Unable to create eval worktree: ${add.stderr || add.stdout}`);

  try {
    if (evalCase.fixtureDir) {
      const fixture = path.resolve(root, evalCase.fixtureDir);
      await fs.cp(fixture, workspace, { recursive: true, force: true });
    }
    for (const setup of evalCase.setupCommands ?? []) {
      const result = await runProcess(template(setup, evalCase, workspace), { cwd: workspace, timeoutMs: 600_000, env: variant.env });
      if (result.exitCode !== 0) throw new Error(`Eval setup failed: ${result.stderr || result.stdout}`);
    }

    const command = template(variant.command ?? evalCase.runCommand ?? `aeh run ${quote(evalCase.taskId)}`, evalCase, workspace);
    const execution = await runProcess(command, { cwd: workspace, timeoutMs: 3_600_000, env: variant.env });
    const run = await readJson(path.join(workspace, ".harness", "runs", `${evalCase.taskId}.json`));
    const report = await readJson(path.join(workspace, ".harness", "reports", `${evalCase.taskId}.json`));
    const status = (run?.status ?? report?.status ?? (execution.exitCode === 0 ? "PASS" : "FAIL")) as "PASS" | "FAIL";
    const base: Omit<EvalResult, "score" | "scoreBreakdown"> = {
      version: 1,
      caseId: evalCase.id,
      variant: variant.name,
      taskId: evalCase.taskId,
      baseRef: evalCase.baseRef,
      status,
      commandExitCode: execution.exitCode,
      metrics: run?.metrics,
      report,
      startedAt,
      finishedAt: new Date().toISOString()
    };
    const scored = scoreEvalResult(evalCase, base);
    const output: EvalResult = { ...base, ...scored };
    const resultsDir = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results", safe(caseId));
    await fs.mkdir(resultsDir, { recursive: true });
    const file = path.join(resultsDir, `${Date.now()}-${safe(variant.name)}.json`);
    output.resultFile = path.relative(root, file).replaceAll("\\", "/");
    await fs.writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally {
    await runProcess(`git worktree remove --force ${quote(workspace)}`, { cwd: root, timeoutMs: 120_000 });
  }
}

export async function compareEvalCase(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalResult[]> {
  const dir = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results", safe(caseId));
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const results: EvalResult[] = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const value = await readJson(path.join(dir, file));
    if (value?.caseId === caseId) results.push(value as EvalResult);
  }
  return rankEvalResults(results);
}

async function loadEvalCase(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalCase> {
  const file = path.resolve(root, config.evals?.corpusDir ?? "evals/corpus", caseId, "eval.yaml");
  return evalSchema.parse(YAML.parse(await fs.readFile(file, "utf8"))) as EvalCase;
}

function selectVariant(evalCase: EvalCase, name?: string): EvalVariant {
  if (!evalCase.variants?.length) return { name: name ?? "default" };
  const selected = name ? evalCase.variants.find((variant) => variant.name === name) : evalCase.variants[0];
  if (!selected) throw new Error(`Unknown eval variant '${name}'.`);
  return selected;
}

function template(command: string, evalCase: EvalCase, workspace: string): string {
  return command.replaceAll("{taskId}", evalCase.taskId).replaceAll("{workspace}", workspace);
}

async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
