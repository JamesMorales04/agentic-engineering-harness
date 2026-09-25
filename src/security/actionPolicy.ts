import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationKind } from "../operations/state.js";
import type { HumanDecisionRequirementV1 } from "../architecture/executionIdentity.js";
import type { ToolActionKindV1 } from "./actionKinds.js";

/** Deterministic allowlist for externally observable delivery effects. */
export function configuredExternalEffects(config: HarnessProjectConfig, kind: OperationKind): ToolActionKindV1[] {
  if (kind === "audit") return [];
  const effects: ToolActionKindV1[] = [];
  const github = config.delivery?.github;
  if (github?.enabled === true) {
    effects.push("github.issue.create", "github.branch.create");
    if (github.finalizeOnAcceptance === true) effects.push("git.push", "github.pull-request.create");
  }
  return [...new Set(effects)].sort();
}

/** External publication and non-idempotent creation always need exact human action authorization. */
export function requiredHumanActionAuthorizations(effects: readonly ToolActionKindV1[]): HumanDecisionRequirementV1[] {
  const requiresHuman = new Set<ToolActionKindV1>(["git.push", "github.issue.create", "github.pull-request.create"]);
  return [...new Set(effects)].filter((action) => requiresHuman.has(action)).sort().map((action) => ({ kind: "ACTION_AUTHORIZATION", action }));
}
