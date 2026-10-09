import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationKind } from "../operations/state.js";
import type { HumanDecisionRequirementV1 } from "../architecture/executionIdentity.js";
import type { ToolActionKindV1 } from "./actionKinds.js";

export interface ConfiguredDeliveryPolicyV1 {
  githubEnabled: boolean;
  paseoEnabled: boolean;
  finalizeOnAcceptance: boolean;
  allowedActions: ToolActionKindV1[];
  allowedExternalEffects: ToolActionKindV1[];
  branchPattern?: string;
  repository?: string;
  pullRequestDraft: boolean;
  pullRequests: boolean;
  mergeMode: "PR_ONLY" | "AUTO_MERGE" | "RISK_GATED";
}

/** Exact project-configured delivery actions and branch/PR settings. This grants no authority by itself. */
export function configuredDeliveryPolicy(config: HarnessProjectConfig, kind: OperationKind): ConfiguredDeliveryPolicyV1 {
  if (kind === "audit") return { githubEnabled: false, paseoEnabled: false, finalizeOnAcceptance: false, allowedActions: [], allowedExternalEffects: [], pullRequestDraft: true, pullRequests: false, mergeMode: "PR_ONLY" };
  const github = config.delivery?.github;
  if (github?.enabled !== true) return {
    githubEnabled: false,
    paseoEnabled: config.delivery?.paseo?.enabled === true,
    finalizeOnAcceptance: false,
    allowedActions: [],
    allowedExternalEffects: [],
    branchPattern: github?.branchPattern,
    repository: github?.repository,
    pullRequestDraft: true,
    pullRequests: false,
    mergeMode: "PR_ONLY"
  };
  const configured = new Set(github.allowedActions ?? []);
  const finalizationActions = new Set<ToolActionKindV1>(["git.commit", "git.push", "github.pull-request.create", "github.pull-request.merge"]);
  const allowedActions = [...configured]
    .filter((action) => action !== "github.pull-request.create" || github.pullRequests !== false)
    .filter((action) => action !== "github.pull-request.merge" || (github.pullRequests !== false && (github.mergeMode === "AUTO_MERGE" || github.mergeMode === "RISK_GATED")))
    .filter((action) => !finalizationActions.has(action) || github.finalizeOnAcceptance === true)
    .sort();
  const external = new Set<ToolActionKindV1>(["git.push", "github.issue.create", "github.branch.create", "github.pull-request.create", "github.pull-request.merge"]);
  const mergeMode = github.mergeMode === "AUTO_MERGE" || github.mergeMode === "RISK_GATED" ? github.mergeMode : "PR_ONLY";
  return {
    githubEnabled: true,
    paseoEnabled: config.delivery?.paseo?.enabled === true,
    finalizeOnAcceptance: github.finalizeOnAcceptance === true,
    allowedActions,
    allowedExternalEffects: allowedActions.filter((action) => external.has(action)),
    branchPattern: github.branchPattern,
    repository: github.repository,
    pullRequestDraft: github.pullRequestDraft ?? true,
    pullRequests: github.pullRequests !== false,
    mergeMode
  };
}

/** Exact project-configured delivery actions. This list has no authority by itself. */
export function configuredDeliveryActions(config: HarnessProjectConfig, kind: OperationKind): ToolActionKindV1[] {
  return configuredDeliveryPolicy(config, kind).allowedActions;
}

/** Deterministic allowlist for externally observable delivery effects. */
export function configuredExternalEffects(config: HarnessProjectConfig, kind: OperationKind): ToolActionKindV1[] {
  return configuredDeliveryPolicy(config, kind).allowedExternalEffects;
}

/** External publication and non-idempotent creation always need exact human action authorization. */
export function requiredHumanActionAuthorizations(effects: readonly ToolActionKindV1[]): HumanDecisionRequirementV1[] {
  const requiresHuman = new Set<ToolActionKindV1>(["git.push", "github.issue.create", "github.pull-request.create"]);
  return [...new Set(effects)].filter((action) => requiresHuman.has(action)).sort().map((action) => ({ kind: "ACTION_AUTHORIZATION", action }));
}
