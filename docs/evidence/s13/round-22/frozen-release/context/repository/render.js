import { estimateTokens } from "../estimator.js";
export function renderRepositoryMap(nodes, tokenBudget) {
    if (!Number.isInteger(tokenBudget) || tokenBudget <= 0)
        throw new Error("Repository map token budget must be positive.");
    const selected = [];
    const omitted = [];
    let tokens = 0;
    for (const node of nodes) {
        const line = `${node.file}${node.symbol ? ` :: ${node.symbol}` : ""}${node.signature ? ` ${node.signature}` : ""} [score=${node.score}${node.reasons.length ? ` ${node.reasons.join(",")}` : ""}]`;
        const next = estimateTokens(`${line}\n`);
        if (tokens + next <= tokenBudget) {
            selected.push(node);
            tokens += next;
        }
        else
            omitted.push(node);
    }
    const content = [...selected.map((node) => `${node.file}${node.symbol ? ` :: ${node.symbol}` : ""}${node.signature ? ` ${node.signature}` : ""} [score=${node.score}${node.reasons.length ? ` ${node.reasons.join(",")}` : ""}]`), omitted.length ? `[${omitted.length} lower-ranked repository nodes omitted; retrieve by authorized map fragment]` : undefined].filter((line) => Boolean(line)).join("\n");
    return { content, selected: selected.map((node) => node.id), omitted: omitted.map((node) => node.id), estimatedTokens: estimateTokens(content) };
}
//# sourceMappingURL=render.js.map