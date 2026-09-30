import { estimateTokens } from "../estimator.js";
export function projectValidation(fragment, report) {
    const raw = report ?? parseReport(fragment.content);
    const checks = raw?.checks ?? [];
    const failing = checks.filter((check) => check.status === "FAIL" || check.status === "WARN");
    const lines = [
        `status=${raw?.status ?? "UNKNOWN"}`,
        `taskId=${raw?.taskId ?? "unknown"}`,
        `checks=${checks.length} failingOrWarning=${failing.length}`,
        ...failing.map((check) => `${check.status} ${check.id}: ${check.message}${check.details ? ` details=${JSON.stringify(check.details)}` : ""}`),
        raw?.changedFiles?.length ? `changedFiles=${raw.changedFiles.join(",")}` : undefined,
        "authoritative raw validation artifact is available through the fragment source"
    ].filter((line) => Boolean(line));
    return { ...fragment, content: lines.join("\n"), estimatedTokens: estimateTokens(lines.join("\n")), originalTokens: estimateTokens(fragment.content), projected: true };
}
function parseReport(content) {
    try {
        const value = JSON.parse(content);
        return Array.isArray(value.checks) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=validation.js.map