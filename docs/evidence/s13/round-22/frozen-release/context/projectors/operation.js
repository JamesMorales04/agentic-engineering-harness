import { estimateTokens } from "../estimator.js";
export function projectOperation(fragment, phase = "COORDINATE") {
    const value = parseJson(fragment.content);
    const lines = [`phase=${phase}`];
    for (const key of ["id", "status", "revision", "currentPhase", "error"])
        if (value?.[key] !== undefined)
            lines.push(`${key}=${format(value[key])}`);
    for (const key of ["participants", "findings", "progress", "result"])
        if (value?.[key] !== undefined)
            lines.push(`${key}=${summarize(value[key])}`);
    lines.push("authoritative OperationRecord remains in its durable artifact");
    const content = lines.join("\n");
    return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: true };
}
function parseJson(content) { try {
    const value = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
catch {
    return undefined;
} }
function format(value) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : summarize(value); }
function summarize(value) { if (Array.isArray(value))
    return `count=${value.length}`; if (value && typeof value === "object")
    return `keys=${Object.keys(value).sort().join(",")}`; return String(value ?? ""); }
//# sourceMappingURL=operation.js.map