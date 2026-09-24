import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationKind } from "../operations/state.js";
import type { HumanDecisionRequirementV1 } from "../architecture/executionIdentity.js";
import type { ToolActionKindV1 } from "./actionKinds.js";

/**
 * Deterministic action allowlist for the effects the managed controller can
 * request from the frozen project delivery configuration. Workspace creation
 * is the mandatory controller bootstrap effect for managed operations.
 */
export function configuredExternalEffects(config: HarnessProjectConfig, kind: OperationKind): ToolActionKindV1[] {
  const effects: ToolActionKindV1[] = ["paseo.workspace.create"];
  if (kind === "audit") return effects;
  const github = config.delivery?.github;
  if (github?.enabled === true) {
    effects.push("github.issue.create", "github.branch.create");
    if (github.finalizeOnAcceptance === true) effects.push("git.push", "github.pull-request.create");
  }
  if (config.delivery?.paseo?.enabled === true && config.delivery.paseo.createWorkspace !== false) effects.push("paseo.workspace.create");
  return [...new Set(effects)].sort();
}

/** External publication and non-idempotent creation always need exact human action authorization. */
export function requiredHumanActionAuthorizations(effects: readonly ToolActionKindV1[]): HumanDecisionRequirementV1[] {
  const requiresHuman = new Set<ToolActionKindV1>(["git.push", "github.issue.create", "github.pull-request.create"]);
  return [...new Set(effects)].filter((action) => requiresHuman.has(action)).sort().map((action) => ({ kind: "ACTION_AUTHORIZATION", action }));
}
