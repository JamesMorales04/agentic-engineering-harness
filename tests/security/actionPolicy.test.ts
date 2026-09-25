import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import type { ToolActionKindV1 } from "../../src/security/actionKinds.js";
import { configuredExternalEffects, requiredHumanActionAuthorizations } from "../../src/security/actionPolicy.js";

function project(delivery: HarnessProjectConfig["delivery"]): HarnessProjectConfig {
  return { version: 1, project: { name: "action-policy-matrix" }, ...(delivery ? { delivery } : {}) };
}

const NO_DELIVERY = project(undefined);
const PASEO_ENABLED = project({ paseo: { enabled: true, createWorkspace: true } });
const PASEO_DISABLED = project({ paseo: { enabled: false, createWorkspace: true } });
const PASEO_CREATE_DISABLED = project({ paseo: { enabled: true, createWorkspace: false } });
const GITHUB_FINALIZE_OFF = project({ github: { enabled: true, finalizeOnAcceptance: false } });
const GITHUB_FINALIZE_DEFAULT = project({ github: { enabled: true } });
const GITHUB_FINALIZE_ON = project({ github: { enabled: true, finalizeOnAcceptance: true } });
const GITHUB_AND_PASEO_FINALIZE_ON = project({ github: { enabled: true, finalizeOnAcceptance: true }, paseo: { enabled: true, createWorkspace: true } });
const GITHUB_DISABLED_PASEO_ENABLED = project({ github: { enabled: false }, paseo: { enabled: true, createWorkspace: true } });

const ISSUE_AND_BRANCH: ToolActionKindV1[] = ["github.branch.create", "github.issue.create"];
const FULL_GITHUB_EFFECTS: ToolActionKindV1[] = ["git.push", "github.branch.create", "github.issue.create", "github.pull-request.create"];
const FULL_GITHUB_REQUIREMENTS = [
  { kind: "ACTION_AUTHORIZATION" as const, action: "git.push" as const },
  { kind: "ACTION_AUTHORIZATION" as const, action: "github.issue.create" as const },
  { kind: "ACTION_AUTHORIZATION" as const, action: "github.pull-request.create" as const }
];

describe("frozen S8 action policy contract", () => {
  describe("configuredExternalEffects", () => {
    it("configures no external delivery effects for audit operations regardless of delivery configuration", () => {
      for (const config of [NO_DELIVERY, PASEO_ENABLED, GITHUB_FINALIZE_OFF, GITHUB_FINALIZE_ON, GITHUB_AND_PASEO_FINALIZE_ON, GITHUB_DISABLED_PASEO_ENABLED]) {
        expect(configuredExternalEffects(config, "audit")).toEqual([]);
      }
    });

    it("configures no external delivery effects for run and change operations without enabled delivery providers", () => {
      for (const kind of ["run", "change"] as const) {
        expect(configuredExternalEffects(NO_DELIVERY, kind)).toEqual([]);
        expect(configuredExternalEffects(PASEO_ENABLED, kind)).toEqual([]);
        expect(configuredExternalEffects(PASEO_DISABLED, kind)).toEqual([]);
        expect(configuredExternalEffects(GITHUB_DISABLED_PASEO_ENABLED, kind)).toEqual([]);
      }
    });

    it("excludes controller-owned paseo.workspace.create from configured external effects regardless of Paseo configuration", () => {
      for (const config of [PASEO_ENABLED, PASEO_DISABLED, PASEO_CREATE_DISABLED, GITHUB_AND_PASEO_FINALIZE_ON]) {
        for (const kind of ["audit", "run", "change"] as const) {
          expect(configuredExternalEffects(config, kind)).not.toContain("paseo.workspace.create");
        }
      }
    });

    it("keeps issue and remote branch creation configured when GitHub delivery is enabled without finalization", () => {
      for (const kind of ["run", "change"] as const) {
        expect(configuredExternalEffects(GITHUB_FINALIZE_OFF, kind)).toEqual(ISSUE_AND_BRANCH);
        expect(configuredExternalEffects(GITHUB_FINALIZE_DEFAULT, kind)).toEqual(ISSUE_AND_BRANCH);
        expect(configuredExternalEffects(project({ github: { enabled: true }, paseo: { enabled: true } }), kind)).toEqual(ISSUE_AND_BRANCH);
      }
    });

    it("configures git.push and pull-request creation only when finalizeOnAcceptance is true", () => {
      for (const kind of ["run", "change"] as const) {
        expect(configuredExternalEffects(GITHUB_FINALIZE_ON, kind)).toEqual(FULL_GITHUB_EFFECTS);
        expect(configuredExternalEffects(GITHUB_AND_PASEO_FINALIZE_ON, kind)).toEqual(FULL_GITHUB_EFFECTS);
      }
    });

    it("returns stable, distinct, sorted effect lists", () => {
      const first = configuredExternalEffects(GITHUB_AND_PASEO_FINALIZE_ON, "change");
      const second = configuredExternalEffects(GITHUB_AND_PASEO_FINALIZE_ON, "change");
      expect(first).toEqual(FULL_GITHUB_EFFECTS);
      expect(second).toEqual(first);
      expect(new Set(first).size).toBe(first.length);
      expect(first).toEqual([...first].sort());
      expect(first).not.toContain("paseo.workspace.create");
    });
  });

  describe("requiredHumanActionAuthorizations", () => {
    it("requires exact authorization for push, issue creation, and pull-request creation only", () => {
      expect(requiredHumanActionAuthorizations(FULL_GITHUB_EFFECTS)).toEqual(FULL_GITHUB_REQUIREMENTS);
    });

    it("does not require human authorization for branch creation or local resource creation", () => {
      expect(requiredHumanActionAuthorizations(["github.branch.create", "paseo.workspace.create"])).toEqual([]);
      expect(requiredHumanActionAuthorizations([])).toEqual([]);
    });

    it("deduplicates and sorts repeated effect inputs deterministically", () => {
      const effects: ToolActionKindV1[] = [
        "github.pull-request.create",
        "git.push",
        "github.issue.create",
        "git.push",
        "github.issue.create",
        "github.pull-request.create"
      ];
      const requirements = requiredHumanActionAuthorizations(effects);
      expect(requirements).toEqual(FULL_GITHUB_REQUIREMENTS);
      expect(new Set(requirements.map((requirement) => requirement.action)).size).toBe(requirements.length);
    });

    it("derives requirements consistently from configured effects", () => {
      expect(requiredHumanActionAuthorizations(configuredExternalEffects(GITHUB_FINALIZE_OFF, "change"))).toEqual([
        { kind: "ACTION_AUTHORIZATION", action: "github.issue.create" }
      ]);
      expect(requiredHumanActionAuthorizations(configuredExternalEffects(GITHUB_FINALIZE_ON, "change"))).toEqual(FULL_GITHUB_REQUIREMENTS);
      expect(requiredHumanActionAuthorizations(configuredExternalEffects(GITHUB_FINALIZE_ON, "audit"))).toEqual([]);
      expect(requiredHumanActionAuthorizations(configuredExternalEffects(PASEO_ENABLED, "run"))).toEqual([]);
    });
  });
});
