import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { GITHUB_DELIVERY_ACTIONS_V1, type ToolActionKindV1 } from "../../src/security/actionKinds.js";
import { configuredDeliveryActions, configuredDeliveryPolicy, configuredExternalEffects, requiredHumanActionAuthorizations } from "../../src/security/actionPolicy.js";

function project(github?: NonNullable<HarnessProjectConfig["delivery"]>["github"]): HarnessProjectConfig {
  return { version: 1, project: { name: "action-policy-matrix" }, delivery: { github, paseo: { enabled: false } } };
}

const CHANGE_DELIVERY_ACTIONS: ToolActionKindV1[] = ["git.branch.create", "git.commit", "git.push", "github.pull-request.create"];
const CHANGE_EXTERNAL_EFFECTS: ToolActionKindV1[] = ["git.push", "github.pull-request.create"];
const CHANGE_HUMAN_REQUIREMENTS = [
  { kind: "ACTION_AUTHORIZATION" as const, action: "git.push" as const },
  { kind: "ACTION_AUTHORIZATION" as const, action: "github.pull-request.create" as const }
];

describe("frozen GitHub delivery action policy", () => {
  it("keeps disabled GitHub delivery blocked even when an action allowlist is present", () => {
    const config = project({ enabled: false, allowedActions: CHANGE_DELIVERY_ACTIONS, finalizeOnAcceptance: true });
    expect(configuredDeliveryActions(config, "change")).toEqual([]);
    expect(configuredExternalEffects(config, "change")).toEqual([]);
    expect(configuredExternalEffects(config, "audit")).toEqual([]);
  });

  it("requires explicit, exact project action scope for a self-hosted CHANGE", () => {
    const config = project({ enabled: true, allowedActions: CHANGE_DELIVERY_ACTIONS, finalizeOnAcceptance: true, pullRequests: true });
    expect(configuredDeliveryPolicy(config, "change")).toMatchObject({
      githubEnabled: true,
      finalizeOnAcceptance: true,
      allowedActions: CHANGE_DELIVERY_ACTIONS,
      allowedExternalEffects: CHANGE_EXTERNAL_EFFECTS
    });
    expect(requiredHumanActionAuthorizations(configuredExternalEffects(config, "change"))).toEqual(CHANGE_HUMAN_REQUIREMENTS);
  });

  it("does not imply issue creation or remote branch creation from GitHub enabled", () => {
    const config = project({ enabled: true, allowedActions: ["git.branch.create", "git.commit", "git.push", "github.pull-request.create"], finalizeOnAcceptance: true });
    expect(configuredExternalEffects(config, "change")).not.toContain("github.issue.create");
    expect(configuredExternalEffects(config, "change")).not.toContain("github.branch.create");
  });

  it("honors push-only and handoff-only action lists", () => {
    const pushOnly = project({ enabled: true, allowedActions: ["git.branch.create", "git.commit", "git.push"], finalizeOnAcceptance: true, pullRequests: false });
    expect(configuredExternalEffects(pushOnly, "change")).toEqual(["git.push"]);
    expect(requiredHumanActionAuthorizations(configuredExternalEffects(pushOnly, "change"))).toEqual([
      { kind: "ACTION_AUTHORIZATION", action: "git.push" }
    ]);

    const issueHandoff = project({ enabled: true, allowedActions: ["github.issue.create", "github.branch.create"], finalizeOnAcceptance: false });
    expect(configuredExternalEffects(issueHandoff, "change")).toEqual(["github.branch.create", "github.issue.create"]);
  });

  it("removes finalization actions when finalizeOnAcceptance is false", () => {
    const config = project({ enabled: true, allowedActions: CHANGE_DELIVERY_ACTIONS, finalizeOnAcceptance: false });
    expect(configuredDeliveryActions(config, "change")).toEqual(["git.branch.create"]);
    expect(configuredExternalEffects(config, "change")).toEqual([]);
  });

  it("does not allow merge, force-push, deletion, or credential mutation actions", () => {
    const unsupported = ["github.pull-request.merge", "git.push.force", "git.branch.delete", "github.repository.delete", "github.credentials.update"];
    for (const action of unsupported) {
      expect(GITHUB_DELIVERY_ACTIONS_V1).not.toContain(action);
    }
  });

  it("deduplicates and sorts configured actions deterministically", () => {
    const config = project({ enabled: true, allowedActions: ["github.pull-request.create", "git.push", "git.push", "git.commit", "git.branch.create"], finalizeOnAcceptance: true });
    expect(configuredDeliveryActions(config, "change")).toEqual([...CHANGE_DELIVERY_ACTIONS].sort());
    expect(configuredExternalEffects(config, "change")).toEqual([...CHANGE_EXTERNAL_EFFECTS].sort());
  });
});
