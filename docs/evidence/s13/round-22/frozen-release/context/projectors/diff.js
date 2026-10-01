import { estimateTokens } from "../estimator.js";
export function projectDiff(fragment) {
    const lines = fragment.content.split(/\r?\n/);
    const selected = lines.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-])/.test(line));
    const content = [...new Set(selected)].join("\n") || "No selected diff hunks; retrieve the authoritative diff artifact for exact anchors.";
    return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: true };
}
//# sourceMappingURL=diff.js.map