export const TOOL_ACTION_KINDS_V1 = [
  "git.branch.create",
  "git.commit",
  "git.push",
  "github.issue.create",
  "github.branch.create",
  "github.pull-request.create",
  "paseo.workspace.create"
] as const;

export type ToolActionKindV1 = (typeof TOOL_ACTION_KINDS_V1)[number];

/** Project-configurable GitHub delivery surface. Destructive and credential actions are not supported here. */
export const GITHUB_DELIVERY_ACTIONS_V1 = [
  "git.branch.create",
  "git.commit",
  "git.push",
  "github.issue.create",
  "github.branch.create",
  "github.pull-request.create"
] as const satisfies readonly ToolActionKindV1[];

export type GitHubDeliveryActionV1 = (typeof GITHUB_DELIVERY_ACTIONS_V1)[number];
