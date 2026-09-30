import { estimateTokens } from "../estimator.js";
export function projectStructuredResult(fragment, role) {
    let content = fragment.content;
    try {
        const value = JSON.parse(fragment.content);
        if (value && typeof value === "object") {
            const record = value;
            const keys = Object.keys(record).sort();
            content = [`role=${role}`, ...keys.map((key) => `${key}=${summarize(record[key])}`), "authoritative structured result remains in its durable artifact"].join("\n");
        }
    }
    catch {
        content = `${fragment.content}\nauthoritative structured result remains in its durable artifact`;
    }
    return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: true };
}
function summarize(value) {
    if (Array.isArray(value))
        return `count=${value.length}`;
    if (value && typeof value === "object")
        return `keys=${Object.keys(value).sort().join(",")}`;
    return String(value ?? "");
}
//# sourceMappingURL=structured.js.map