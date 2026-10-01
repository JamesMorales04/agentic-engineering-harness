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
