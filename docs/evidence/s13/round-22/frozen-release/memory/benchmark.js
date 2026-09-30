import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { runShell } from "../utils/process.js";
const caseSchema = z.object({
    version: z.literal(1),
    id: z.string().min(1),
    query: z.string().min(1),
    expectedTerms: z.array(z.string()).default([]),
    forbiddenTerms: z.array(z.string()).default([])
});
export async function runMemoryBenchmark(root, config) {
    const providers = config.memory?.benchmark?.providers ?? [];
    if (!providers.length)
        throw new Error("No memory benchmark providers are configured in memory.benchmark.providers.");
    const cases = await loadCases(root, config);
    if (!cases.length)
        throw new Error("No memory benchmark cases found.");
    const results = [];
    for (const provider of providers) {
        const caseResults = [];
        for (const item of cases) {
            const command = provider.command.replaceAll("{query}", shellQuote(item.query)).replaceAll("{caseId}", item.id);
            const execution = await runShell(command, { cwd: root, timeoutMs: (provider.timeoutSeconds ?? 60) * 1000 });
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
    const report = { version: 1, createdAt: new Date().toISOString(), project: config.project.name, providers: results };
    const dir = path.resolve(root, config.memory?.benchmark?.resultsDir ?? ".harness/memory-benchmarks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
export function scoreMemoryOutput(item, success, latencyMs, output) {
    const normalized = output.toLocaleLowerCase();
    const expected = item.expectedTerms.map((term) => term.toLocaleLowerCase());
    const forbidden = item.forbiddenTerms.map((term) => term.toLocaleLowerCase());
    const recall = expected.length ? expected.filter((term) => normalized.includes(term)).length / expected.length : (success ? 1 : 0);
    const contamination = forbidden.length ? forbidden.filter((term) => normalized.includes(term)).length / forbidden.length : 0;
    const latencyPenalty = Math.min(10, latencyMs / 1000);
    const score = success ? Math.max(0, recall * 100 - contamination * 40 - latencyPenalty) : 0;
    return { caseId: item.id, success, latencyMs, recall: round(recall), contamination: round(contamination), score: round(score), output: trim(output) };
}
async function loadCases(root, config) {
    const dir = path.resolve(root, config.memory?.benchmark?.casesDir ?? "memory-benchmarks");
    const names = await fs.readdir(dir).catch(() => []);
    const cases = [];
    for (const name of names.filter((value) => /\.ya?ml$/i.test(value)).sort()) {
        const raw = YAML.parse(await fs.readFile(path.join(dir, name), "utf8"));
        cases.push(caseSchema.parse(raw));
    }
    return cases;
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function trim(value) { return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n...[truncated]`; }
function round(value) { return Math.round(value * 1000) / 1000; }
//# sourceMappingURL=benchmark.js.map