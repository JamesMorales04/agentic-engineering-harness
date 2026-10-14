import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { directRouteMultiUnitBlockedV1, requiresDelegatedPlanningV1 } from "../src/agents/routingV2.js";
import { triageChange, triageChangeWithSemanticAssessment } from "../src/core/triage.js";
import { createRoutedContract } from "../src/core/contract.js";
import { executePlannerWaves } from "../src/agents/waveExecutor.js";
import { buildChangeIntentDigestV1 } from "../src/operations/change.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { PlannerOutput } from "../src/agents/outputContracts.js";

/**
 * FAM-ROUTE: the delegation floor is single-sourced on
 * `requiresDelegatedPlanningV1` with `expectedWorkUnits` threaded through
 * every triage/contract entry, and a DIRECT-sealed change decomposed into
 * more than one work unit is escalated/re-sealed or explicitly refused —
 * never silently DIRECT-executed. Also pins the preflight `intentDigest`
 * binding to the effective profile + policy revision.
 */

const config = { version: 1, project: { name: "fixture" } } as HarnessProjectConfig;

function directService() {
  return semanticTestService({
    payload: (request) => semanticPayload(request, {
      judgment: {
        type: "ROUTE", recommendedRoute: "DIRECT", scopeClarity: "HIGH",
        decompositionNeed: false, coordinationNeed: false,
        architectureUncertainty: false, productUncertainty: false,
        formalizationNeed: "NONE", semanticRiskSignals: [],
        evidenceRefs: request.evidenceRefs, unknowns: []
      }
    })
  });
}

function twoUnitPlan(): PlannerOutput {
  const unit = (id: string, scope: string, ref: string) => ({
    id,
    objective: `Implement ${id}`,
    scope: [scope],
    dependencies: [],
    requirementRefs: [ref],
    acceptanceRefs: [] as string[],
    competencies: [] as string[],
    riskTags: [] as string[],
    changeKinds: ["source", "test"] as ("source" | "test")[],
    risk: "low" as const,
    resourceClaims: [] as PlannerOutput["workUnits"][number]["resourceClaims"]
  });
  return {
    workUnits: [unit("u1", "src/a.ts", "R-1"), unit("u2", "src/b.ts", "R-2")],
    affectedAreas: [],
    reviewDimensions: [],
    validationRequirements: [],
    outOfScopeImprovements: [],
    filesNeededOutsideScope: []
  };
}

describe("delegation floor unification (FAM-ROUTE)", () => {
  it("threads expectedWorkUnits through the deterministic triage floor", () => {
    const bounded = { request: "touch one file", files: ["src/a.ts"], risk: "low" as const };
    expect(requiresDelegatedPlanningV1({ files: ["src/a.ts"] })).toBe(false);
    expect(triageChange(config, bounded).route).toBe("DIRECT");
    // The same bounded scope with two expected work units takes the
    // DELEGATED branch through the single floor predicate.
    expect(requiresDelegatedPlanningV1({ files: ["src/a.ts"], expectedWorkUnits: 2 })).toBe(true);
    expect(triageChange(config, { ...bounded, expectedWorkUnits: 2 }).route).toBe("DELEGATED");
    expect(triageChange(config, { ...bounded, expectedWorkUnits: 1 }).route).toBe("DIRECT");
  });

  it("applies the same unit count on the semantic DIRECT recommendation path", async () => {
    const input = { request: "touch one file", files: ["src/a.ts"], risk: "low" as const };
    const direct = await triageChangeWithSemanticAssessment(config, input, {
      service: directService(),
      binding: { projectId: "fixture", repositoryDigest: "repo-digest" },
      policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(direct.route).toBe("DIRECT");
    const escalated = await triageChangeWithSemanticAssessment(config, { ...input, expectedWorkUnits: 2 }, {
      service: directService(),
      binding: { projectId: "fixture", repositoryDigest: "repo-digest" },
      policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(escalated.route).toBe("DELEGATED");
  });

  it("seals DELEGATED when the contract input declares two work units", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-route-units-"));
    try {
      const single = await createRoutedContract(root, config, "TASK-UNITS-1", {
        title: "one unit", request: "touch one file", scope: ["src/a.ts"], expectedWorkUnits: 1
      });
      expect(single.contract.routing?.route).toBe("DIRECT");
      const multi = await createRoutedContract(root, config, "TASK-UNITS-2", {
        title: "two units", request: "touch one file", scope: ["src/a.ts"], expectedWorkUnits: 2
      });
      expect(multi.contract.routing?.route).toBe("DELEGATED");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the single DIRECT-multi-unit predicate (no silent multi-unit DIRECT)", () => {
    expect(directRouteMultiUnitBlockedV1("DIRECT", 2)).toBe(true);
    expect(directRouteMultiUnitBlockedV1("NO_AGENT", 2)).toBe(true);
    expect(directRouteMultiUnitBlockedV1("DIRECT", 1)).toBe(false);
    expect(directRouteMultiUnitBlockedV1("DELEGATED", 2)).toBe(false);
    expect(directRouteMultiUnitBlockedV1("FORMAL_SDD", 9)).toBe(false);
    expect(directRouteMultiUnitBlockedV1(undefined, 2)).toBe(false);
  });

  it("refuses a DIRECT-sealed change decomposed into two units (wave fallback)", async () => {
    const contract = {
      version: 1 as const,
      task: { id: "TASK-DIRECT-2", title: "direct sealed" },
      scope: { allowed: ["src/a.ts", "src/b.ts"] },
      routing: { intent: "implement", risk: "low" as const, route: "DIRECT" as const, assurance: "NONE" as const },
      requirements: [
        { id: "R-1", description: "first" },
        { id: "R-2", description: "second" }
      ]
    };
    const result = await executePlannerWaves({
      root: "/work/tree",
      stateRoot: "/work/tree",
      config: { version: 1, project: { name: "fixture" } } as never,
      contract: contract as never,
      implementationSelection: { logicalAgent: "implementer" } as never,
      executionCatalog: {} as never,
      capabilityRegistry: {} as never,
      precomputedPlan: twoUnitPlan(),
      revalidate: async () => { throw new Error("must not revalidate on pre-execution failure"); }
    });
    expect(result.used).toBe(true);
    expect(result.preExecutionFailure).toBe(true);
    expect(result.sessions).toEqual([]);
    expect(result.waves).toEqual([]);
    expect(`${result.aggregateSession?.stdout ?? ""}\n${result.aggregateSession?.stderr ?? ""}`).toContain("DIRECT_MULTI_UNIT_ESCALATION_REQUIRED");
  });

  it("keeps a single-unit DIRECT plan on the no-planning short-circuit", async () => {
    const contract = {
      version: 1 as const,
      task: { id: "TASK-DIRECT-1", title: "direct sealed" },
      scope: { allowed: ["src/a.ts"] },
      routing: { intent: "implement", risk: "low" as const, route: "DIRECT" as const, assurance: "NONE" as const },
      requirements: [{ id: "R-1", description: "only" }]
    };
    const plan = { ...twoUnitPlan(), workUnits: twoUnitPlan().workUnits.slice(0, 1) };
    const result = await executePlannerWaves({
      root: "/work/tree",
      stateRoot: "/work/tree",
      config: { version: 1, project: { name: "fixture" } } as never,
      contract: contract as never,
      implementationSelection: { logicalAgent: "implementer" } as never,
      executionCatalog: {} as never,
      capabilityRegistry: {} as never,
      precomputedPlan: plan,
      revalidate: async () => { throw new Error("unused"); }
    });
    expect(result.used).toBe(false);
    expect(result.preExecutionFailure).toBeUndefined();
  });
});

describe("change intent digest profile binding", () => {
  const base = {
    request: "touch one file",
    files: ["src/a.ts"] as readonly string[],
    domains: [] as readonly string[],
    risk: "low" as const,
    flags: [] as readonly string[]
  };
  it("binds the effective profile and policy revision (no cross-profile reuse)", () => {
    const a = buildChangeIntentDigestV1({ ...base, profile: "backend-workers", policyRevision: semanticCapabilityPolicyRevisionV1 });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(buildChangeIntentDigestV1({ ...base, profile: "backend-workers", policyRevision: semanticCapabilityPolicyRevisionV1 })).toBe(a);
    // A different profile never shares the binding...
    expect(buildChangeIntentDigestV1({ ...base, profile: "other-workers", policyRevision: semanticCapabilityPolicyRevisionV1 })).not.toBe(a);
    // ...nor does omitting it, nor does a policy rotation.
    expect(buildChangeIntentDigestV1({ ...base, policyRevision: semanticCapabilityPolicyRevisionV1 })).not.toBe(a);
    expect(buildChangeIntentDigestV1({ ...base, profile: "backend-workers", policyRevision: "next-revision" })).not.toBe(a);
    // Workflow-mode names normalize away exactly like topology resolution.
    expect(buildChangeIntentDigestV1({ ...base, profile: "change", policyRevision: semanticCapabilityPolicyRevisionV1 }))
      .toBe(buildChangeIntentDigestV1({ ...base, policyRevision: semanticCapabilityPolicyRevisionV1 }));
  });
});
