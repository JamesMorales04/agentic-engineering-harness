import { describe, expect, it } from "vitest";
import { resolveImplementationRoute } from "../src/agents/routingV2.js";
import { triageChange } from "../src/core/triage.js";

const config = {} as never;

describe("implementation routing v2", () => {
  it("keeps route and assurance independent", () => {
    expect(resolveImplementationRoute({ intent: "explain", explicitNoAgent: true, securityBoundary: true })).toMatchObject({ route: "NO_AGENT", assurance: "CRITICAL" });
    expect(resolveImplementationRoute({ intent: "bounded edit", files: ["src/a.ts"], scopeConfidence: "high" })).toMatchObject({ route: "DIRECT", assurance: "NONE" });
  });

  it("escalates ambiguous architectural work to formal SDD", () => {
    expect(resolveImplementationRoute({ intent: "redesign", architecture: true, ambiguity: true })).toMatchObject({ route: "FORMAL_SDD" });
  });

  it("accepts a semantic formalization recommendation without keyword heuristics", () => {
    const result = resolveImplementationRoute({
      intent: "make the product behavior work better",
      files: ["src/product.ts"],
      scopeConfidence: "high",
      semanticAssessment: {
        recommendedRoute: "FORMAL_SDD",
        scopeClarity: "LOW",
        decompositionNeed: false,
        coordinationNeed: false,
        architectureUncertainty: false,
        productUncertainty: true,
        formalizationNeed: "REQUIRED",
        semanticRiskSignals: ["multiple plausible outcomes"],
        evidenceRefs: ["request"],
        unknowns: ["desired outcome"]
      }
    });
    expect(result).toMatchObject({ route: "FORMAL_SDD", mechanism: "HYBRID" });
  });

  it("keeps route and assurance independent for an explicit security boundary", () => {
    expect(resolveImplementationRoute({ intent: "bounded authorization correction", files: ["src/auth.ts"], scopeConfidence: "high", securityBoundary: true })).toMatchObject({ route: "DIRECT", assurance: "CRITICAL", mechanism: "DETERMINISTIC" });
  });

  it("exposes the canonical route on legacy-compatible triage", () => {
    const decision = triageChange(config, { request: "update one unit test", files: ["tests/example.test.ts"], risk: "low" });
    expect(decision).toMatchObject({ route: "DIRECT", assurance: "NONE" });
  });
});
