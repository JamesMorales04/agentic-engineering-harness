import fs from "node:fs/promises";
import path from "node:path";
import { runEvalCase, compareEvalCase } from "./runner.js";
export async function runRepeatedEval(root, config, caseId, variant, runs) {
    const count = runs ?? config.evals?.defaultRuns ?? 5;
    if (count < 2)
        throw new Error("Repeated evals require at least two runs to estimate variance.");
    for (let index = 0; index < count; index += 1)
        await runEvalCase(root, config, caseId, variant);
    return buildEvalDashboard(root, config, caseId);
}
export async function buildEvalDashboard(root, config, caseId) {
    const results = await compareEvalCase(root, config, caseId);
    const confidenceLevel = config.evals?.confidenceLevel ?? 0.95;
    const groups = new Map();
    for (const result of results) {
        const items = groups.get(result.variant) ?? [];
        items.push(result);
        groups.set(result.variant, items);
    }
    const variants = [...groups.entries()].map(([variant, items]) => aggregateVariant(variant, items, confidenceLevel)).sort((a, b) => b.passRate - a.passRate || b.score.mean - a.score.mean || a.variant.localeCompare(b.variant));
    const dashboard = { version: 1, caseId, generatedAt: new Date().toISOString(), confidenceLevel, variants };
    const output = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results", caseId, "dashboard.json");
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(dashboard, null, 2)}\n`);
    return dashboard;
}
export function aggregateVariant(variant, results, level = 0.95) {
    const passes = results.filter((result) => result.status === "PASS").length;
    const metric = (select) => { const values = results.map(select).filter((value) => Number.isFinite(value)); return values.length ? summarize(values, level) : undefined; };
    return {
        variant,
        runs: results.length,
        passRate: results.length ? passes / results.length : 0,
        passRateConfidence: wilson(passes, results.length, level),
        score: summarize(results.map((result) => result.score), level),
        durationMs: metric((result) => result.metrics?.durationMs),
        totalTokens: metric((result) => result.metrics?.usage.totalTokens),
        costUsd: metric((result) => result.metrics?.usage.costUsd),
        repairs: metric((result) => result.metrics?.repairCount),
        humanInterventions: metric((result) => result.metrics?.humanInterventions)
    };
}
export function summarize(values, level = 0.95) {
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const mean = sorted.reduce((sum, value) => sum + value, 0) / count;
    const variance = count > 1 ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1) : 0;
    const standardDeviation = Math.sqrt(variance);
    const median = count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
    const z = inverseNormal(0.5 + level / 2);
    const margin = count > 1 ? z * standardDeviation / Math.sqrt(count) : 0;
    return { count, mean, median, standardDeviation, confidence: { low: mean - margin, high: mean + margin, level } };
}
export function wilson(successes, count, level = 0.95) {
    if (!count)
        return { low: 0, high: 1, level };
    const z = inverseNormal(0.5 + level / 2);
    const p = successes / count;
    const z2 = z * z;
    const denominator = 1 + z2 / count;
    const center = (p + z2 / (2 * count)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * count)) / count) / denominator;
    return { low: Math.max(0, center - margin), high: Math.min(1, center + margin), level };
}
// Peter J. Acklam's rational approximation, sufficient for confidence reporting.
function inverseNormal(p) {
    if (!(p > 0 && p < 1))
        throw new Error("Normal quantile requires 0 < p < 1.");
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const low = 0.02425;
    const high = 1 - low;
    if (p < low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > high) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
//# sourceMappingURL=statistics.js.map