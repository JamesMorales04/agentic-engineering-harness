import { describe, expect, it } from "vitest";
import { triageChange, triageChangeWithSemanticAssessment } from "../src/core/triage.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };

function routeService(recommendedRoute: "DIRECT" | "DELEGATED" | "FORMAL_SDD" = "DIRECT") {
  return semanticTestService({ payload: (request) => semanticPayload(request, { judgment: { type: "ROUTE", recommendedRoute, scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: request.evidenceRefs, unknowns: [] } }) });
}
describe("triageChange", () => {
  it("selects the direct route for a bounded low-risk cosmetic change", () => { const result = triageChange(config, { request: "Change the button padding from 12px to 16px", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" }); expect(result.route).toBe("DIRECT"); expect(result.assurance).toBe("NONE"); });
  it("keeps a bounded security change DIRECT while applying a CRITICAL assurance floor", () => { const result = triageChange(config, { request: "Change authorization permissions", files: ["src/auth.ts"], domains: ["security"], risk: "low" }); expect(result.route).toBe("DIRECT"); expect(result.assurance).toBe("CRITICAL"); expect(result.mechanism).toBe("DETERMINISTIC"); expect(result.reasons.join(" ")).toMatch(/security|assurance/i); });
  it("requires delegated or formal handling without a bounded scope", () => { expect(["DELEGATED", "FORMAL_SDD"]).toContain(triageChange(config, { request: "Fix typo", files: [] }).route); });

  it("uses a typed semantic route judgment while keeping assurance deterministic", async () => {
    const result = await triageChangeWithSemanticAssessment(config, { request: "Make the export workflow easier to use", files: ["src/export.ts"], domains: ["security"], risk: "low" }, {
      service: routeService(), binding: { projectId: "test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(result).toMatchObject({ route: "DIRECT", assurance: "CRITICAL", mechanism: "HYBRID", assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("keeps deterministic scope bounds authoritative over a direct model recommendation", async () => {
    const result = await triageChangeWithSemanticAssessment(config, { request: "Fix typo", files: [] }, {
      service: routeService("DIRECT"), binding: { projectId: "test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(result).toMatchObject({ route: "DELEGATED", assurance: "NONE", mechanism: "HYBRID" });
  });

  it("rejects route judgments that try to select the no-agent authority path", async () => {
    const service = semanticTestService({ payload: (request) => semanticPayload(request, { judgment: { type: "ROUTE", recommendedRoute: "NO_AGENT", scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: request.evidenceRefs, unknowns: [] } }) });
    await expect(triageChangeWithSemanticAssessment(config, { request: "Update one file", files: ["src/x.ts"] }, {
      service, binding: { projectId: "test", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });
});
