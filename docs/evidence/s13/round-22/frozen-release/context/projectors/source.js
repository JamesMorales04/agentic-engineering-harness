import { estimateTokens } from "../estimator.js";
export function projectSource(fragment) {
    return { ...fragment, content: fragment.content, estimatedTokens: estimateTokens(fragment.content), originalTokens: estimateTokens(fragment.content), projected: false };
}
//# sourceMappingURL=source.js.map