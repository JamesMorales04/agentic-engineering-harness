import { estimateTokens } from "../estimator.js";
import type { ContextFragment, ContextFragmentProjection } from "../types.js";
import { projectStructuredResult } from "./structured.js";

export function projectExplorer(fragment: ContextFragment): ContextFragmentProjection {
  return projectStructuredResult(fragment, "explorer");
}
