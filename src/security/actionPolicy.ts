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

/** External publication and non-idempotent creation always need exact human action authorization.
 *
 * MERGE_AUTHORIZATION (FAM-MERGE decision (b); see docs/ARCHITECTURE.md delivery section):
 * `github.pull-request.merge` is intentionally ABSENT from this set. Merge
 * authorization is the conjunction of (1) frozen-policy authorization —
 * Owner-delegated policy (`allowedActions` containing
 * `github.pull-request.merge` + an explicit `mergeMode` of `AUTO_MERGE` /
 * `RISK_GATED` + `finalizeOnAcceptance`, frozen at operation start and never
 * widened from live config), (2) a freshness-bound independent ACCEPTED
 * review (`IndependentPullRequestReview`, exact final head/base/candidate/
 * policy binding), and (3) live pre-merge revalidation (live PR identity,
 * branch-protection required checks, and mergeable_state re-observed
 * immediately before the merge). Per-merge human ACTION_AUTHORIZATION is
 * intentionally not required: human control is exercised through the
 * `git.push` + `github.pull-request.create` action authorizations and the
 * Owner-delegated delivery policy itself. Do NOT add
 * `github.pull-request.merge` here without an explicit Owner-approved
 * decision; doing so would silently convert governed autonomous merge into a
 * per-merge human gate.
 */
export function requiredHumanActionAuthorizations(effects: readonly ToolActionKindV1[]): HumanDecisionRequirementV1[] {
  const requiresHuman = new Set<ToolActionKindV1>(["git.push", "github.issue.create", "github.pull-request.create"]);
  return [...new Set(effects)].filter((action) => requiresHuman.has(action)).sort().map((action) => ({ kind: "ACTION_AUTHORIZATION", action }));
}
