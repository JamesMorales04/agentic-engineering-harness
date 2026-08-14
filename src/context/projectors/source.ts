import type { ContextFragment, ContextFragmentProjection } from "../types.js";
import { estimateTokens } from "../estimator.js";

export function projectSource(fragment: ContextFragment): ContextFragmentProjection {
  return { ...fragment, content: fragment.content, estimatedTokens: estimateTokens(fragment.content), originalTokens: estimateTokens(fragment.content), projected: false };
}
