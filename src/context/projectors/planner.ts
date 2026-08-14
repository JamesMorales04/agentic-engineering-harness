import type { ContextFragment, ContextFragmentProjection } from "../types.js";
import { projectStructuredResult } from "./structured.js";

export function projectPlanner(fragment: ContextFragment): ContextFragmentProjection {
  return projectStructuredResult(fragment, "planner");
}
