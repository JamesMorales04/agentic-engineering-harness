import { estimateTokens } from "../estimator.js";
import type { ContextFragment, ContextFragmentProjection } from "../types.js";

export function projectDiff(fragment: ContextFragment): ContextFragmentProjection {
  const lines = fragment.content.split(/\r?\n/);
  const selected = lines.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-])/.test(line));
  const content = [...new Set(selected)].join("\n") || "No selected diff hunks; retrieve the authoritative diff artifact for exact anchors.";
  return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: true };
}
