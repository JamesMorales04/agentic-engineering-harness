import { findingSchema, reviewerOutputSchema } from "./outputContracts.js";
const severityRank = { critical: 5, high: 4, medium: 3, low: 2, note: 1 };
export function extractFindings(value) { const reviewer = reviewerOutputSchema.safeParse(value); if (reviewer.success)
    return reviewer.data.findings; if (Array.isArray(value))
    return value.map((item) => findingSchema.parse(item)); return [findingSchema.parse(value)]; }
export function dedupeFindings(input) {
    const output = [];
    const merges = [];
    for (const finding of input) {
        const index = output.findIndex((current) => isDuplicate(current, finding));
        if (index < 0) {
            output.push(structuredClone(finding));
            continue;
        }
        const current = output[index];
        const winner = severityRank[finding.severity] > severityRank[current.severity] ? finding : current;
        const loser = winner === finding ? current : finding;
        const merged = { ...winner, evidence: joinUnique(winner.evidence, loser.evidence), impact: joinUnique(winner.impact, loser.impact), recommendedFix: joinUnique(winner.recommendedFix, loser.recommendedFix), location: { file: winner.location.file, startLine: minDefined(current.location.startLine, finding.location.startLine), endLine: maxDefined(current.location.endLine, finding.location.endLine) } };
        output[index] = merged;
        const existing = merges.find((item) => item.into === merged.id);
        if (existing)
            existing.from.push(loser.id);
        else
            merges.push({ into: merged.id, from: [loser.id], reason: `same/adjacent location and compatible category (${current.category}, ${finding.category})` });
    }
    return { inputCount: input.length, outputCount: output.length, findings: output, merges };
}
function isDuplicate(a, b) { if (a.location.file !== b.location.file)
    return false; if (!categoriesCompatible(a.category, b.category))
    return false; const aStart = a.location.startLine ?? 1; const aEnd = a.location.endLine ?? aStart; const bStart = b.location.startLine ?? 1; const bEnd = b.location.endLine ?? bStart; return aStart <= bEnd + 10 && bStart <= aEnd + 10; }
function categoriesCompatible(a, b) { if (a === b)
    return true; const pairs = [["security", "backend"], ["architecture", "maintainability"], ["api-contract", "backend"], ["coverage", "test"]]; return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x)); }
function joinUnique(a, b) { return a === b ? a : `${a}\n---\n${b}`; }
function minDefined(a, b) { if (a === undefined)
    return b; if (b === undefined)
    return a; return Math.min(a, b); }
function maxDefined(a, b) { if (a === undefined)
    return b; if (b === undefined)
    return a; return Math.max(a, b); }
//# sourceMappingURL=findings.js.map