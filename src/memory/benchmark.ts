import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import { runProcess } from "../utils/process.js";

const caseSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  query: z.string().min(1),
  expectedTerms: z.array(z.string()).default([]),
  forbiddenTerms: z.array(z.string()).default([])
});

export interface MemoryBenchmarkCase { version: 1; id: string; query: string; expectedTerms: string[]; forbiddenTerms: string[]; }
export interface MemoryBenchmarkCaseResult { caseId: string; success: boolean; latencyMs: number; recall: number; contamination: number; score: number; output: string; }
export interface MemoryBenchmarkProviderResult { provider: string; score: number; averageRecall: number; averageContamination: number; averageLatencyMs: number; cases: MemoryBenchmarkCaseResult[]; }
export interface MemoryBenchmarkReport { version: 1; createdAt: string; project: string; providers: MemoryBenchmarkProviderResult[]; }

export async function runMemoryBenchmark(root: string, config: HarnessProjectConfig): Promise<MemoryBenchmarkReport> {
  const providers = config.memory?.benchmark?.providers ?? [];
  if (!providers.length) throw new Error("No memory benchmark providers are configured in memory.benchmark.providers.");
  const cases = await loadCases(root, config);
  if (!cases.length) throw new Error("No memory benchmark cases found.");
  const results: MemoryBenchmarkProviderResult[] = [];

  for (const provider of providers) {
    const caseResults: MemoryBenchmarkCaseResult[] = [];
    for (const item of cases) {
      const command = provider.command.replaceAll("{query}", shellQuote(item.query)).replaceAll("{caseId}", item.id);
      const execution = await runProcess(command, { cwd: root, timeoutMs: (provider.timeoutSeconds ?? 60) * 1000 });
      const output = `${execution.stdout}\n${execution.stderr}`.trim();
      caseResults.push(scoreMemoryOutput(item, execution.exitCode === 0, execution.durationMs, output));
    }
    const divisor = Math.max(1, caseResults.length);
    results.push({
      provider: provider.name,
      score: round(caseResults.reduce((sum, item) => sum + item.score, 0) / divisor),
      averageRecall: round(caseResults.reduce((sum, item) => sum + item.recall, 0) / divisor),
      averageContamination: round(caseResults.reduce((sum, item) => sum + item.contamination, 0) / divisor),
      averageLatencyMs: round(caseResults.reduce((sum, item) => sum + item.latencyMs, 0) / divisor),
      cases: caseResults
    });
  }

  results.sort((a, b) => b.score - a.score || a.averageLatencyMs - b.averageLatencyMs);
  const report: MemoryBenchmarkReport = { version: 1, createdAt: new Date().toISOString(), project: config.project.name, providers: results };
  const dir = path.resolve(root, config.memory?.benchmark?.resultsDir ?? ".harness/memory-benchmarks");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function scoreMemoryOutput(item: MemoryBenchmarkCase, success: boolean, latencyMs: number, output: string): MemoryBenchmarkCaseResult {
  const normalized = output.toLocaleLowerCase();
  const expected = item.expectedTerms.map((term) => term.toLocaleLowerCase());
  const forbidden = item.forbiddenTerms.map((term) => term.toLocaleLowerCase());
  const recall = expected.length ? expected.filter((term) => normalized.includes(term)).length / expected.length : (success ? 1 : 0);
  const contamination = forbidden.length ? forbidden.filter((term) => normalized.includes(term)).length / forbidden.length : 0;
  const latencyPenalty = Math.min(10, latencyMs / 1000);
  const score = success ? Math.max(0, recall * 100 - contamination * 40 - latencyPenalty) : 0;
  return { caseId: item.id, success, latencyMs, recall: round(recall), contamination: round(contamination), score: round(score), output: trim(output) };
}

async function loadCases(root: string, config: HarnessProjectConfig): Promise<MemoryBenchmarkCase[]> {
  const dir = path.resolve(root, config.memory?.benchmark?.casesDir ?? "memory-benchmarks");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const cases: MemoryBenchmarkCase[] = [];
  for (const name of names.filter((value) => /\.ya?ml$/i.test(value)).sort()) {
    const raw = YAML.parse(await fs.readFile(path.join(dir, name), "utf8"));
    cases.push(caseSchema.parse(raw) as MemoryBenchmarkCase);
  }
  return cases;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function trim(value: string): string { return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n...[truncated]`; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
