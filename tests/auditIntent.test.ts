import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig, ValidationCheck } from "../src/core/types.js";
import { classifyEngineeringIntentHeuristic, classifyEngineeringIntentWithSemanticAssessment } from "../src/audit/intent.js";
import { classifyAuditFailure } from "../src/audit/run.js";
import { semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "demo" }, orchestration: { provider: "none" } };

describe("engineering intent classification", () => {
  it("classifies pure explanations as informational", () => {
    const result = classifyEngineeringIntentHeuristic(config, { request: "What does src/core/run.ts do?" });
    expect(result.intent).toBe("informational");
    expect(result.changeTriage).toBeUndefined();
  });

  it("classifies repository reviews as AUDIT rather than a mutating route", () => {
    const result = classifyEngineeringIntentHeuristic(config, { request: "review the repo and validate the code for improvements" });
    expect(result.intent).toBe("audit");
    expect(result.changeTriage).toBeUndefined();
  });

  it("classifies bug hunts and security reviews as audit", () => {
    expect(classifyEngineeringIntentHeuristic(config, { request: "find bugs and regression risks in this repository" }).intent).toBe("audit");
    expect(classifyEngineeringIntentHeuristic(config, { request: "audit the authentication security model" }).intent).toBe("audit");
  });

  it("classifies mutation requests as CHANGE and selects canonical routes", () => {
    const direct = classifyEngineeringIntentHeuristic(config, { request: "fix the typo", files: ["README.md"], domains: ["docs"], risk: "low" });
    expect(direct.intent).toBe("change");
    expect(direct.changeTriage?.route).toBe("DIRECT");

    const security = classifyEngineeringIntentHeuristic(config, { request: "fix authentication authorization boundaries", files: ["src/auth.ts"], domains: ["auth"], risk: "high" });
    expect(security.intent).toBe("change");
    expect(security.changeTriage).toMatchObject({ route: "DIRECT", assurance: "CRITICAL", mechanism: "DETERMINISTIC" });
  });

  it("prefers CHANGE when a request asks to review and fix", () => {
    const result = classifyEngineeringIntentHeuristic(config, { request: "review this module and fix every bug you find", files: ["src/x.ts"] });
    expect(result.intent).toBe("change");
  });

  it("uses typed semantic intent for a natural-language mixed request and deterministic routing for CHANGE", async () => {
    const service = semanticTestService({});
    const decision = await classifyEngineeringIntentWithSemanticAssessment(config, { request: "Look over this file and correct the broken label", files: ["src/label.ts"], risk: "low" }, {
      service, binding: { projectId: "demo", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(decision).toMatchObject({ intent: "change", mechanism: "HYBRID", changeTriage: { route: "DIRECT", mechanism: "HYBRID" } });
    expect(decision.assessmentDigests).toHaveLength(2);
  });

  it("completes a HIGH-risk typed INTENT assessment within its existing policy bounds and retains the deterministic CRITICAL assurance floor", async () => {
    const requests: SemanticAssessmentRequestV1[] = [];
    const service = semanticTestService({ payload: (request) => { requests.push(request); return semanticPayload(request); } });
    const decision = await classifyEngineeringIntentWithSemanticAssessment(config, { request: "fix authentication authorization boundaries", files: ["src/auth.ts"], domains: ["auth"], risk: "high" }, {
      service, binding: { projectId: "demo", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    const intentRequest = requests.find((request) => request.assessmentType === "INTENT");
    expect(intentRequest).toBeDefined();
    expect(intentRequest!.reasoningRequirement).toEqual({
      reasoningClass: "LIGHT",
      structuredOutputRequired: true,
      independenceRequired: false,
      externalKnowledgeRequired: false,
      maxContextClass: "SMALL",
      riskClass: "HIGH"
    });
    expect(intentRequest!.budget).toEqual({ maxInputTokens: 2_000, maxOutputTokens: 300, deadlineMs: 10_000 });
    expect(decision).toMatchObject({ intent: "change", mechanism: "HYBRID", changeTriage: { route: "DIRECT", assurance: "CRITICAL", mechanism: "HYBRID" } });
    expect(decision.assessmentDigests).toHaveLength(2);
  });

  it("preserves the deterministic delegation floor for a HIGH-risk semantic change request without a concrete scope", async () => {
    const service = semanticTestService({});
    const decision = await classifyEngineeringIntentWithSemanticAssessment(config, { request: "fix authentication authorization boundaries", risk: "high" }, {
      service, binding: { projectId: "demo", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(decision).toMatchObject({ intent: "change", mechanism: "HYBRID", changeTriage: { route: "DELEGATED", mechanism: "HYBRID" } });
  });

  it("keeps explicit user-provided intent deterministic and does not call the model", async () => {
    let calls = 0;
    const service = semanticTestService({ runner: { assess: async () => { calls += 1; throw new Error("must not execute"); } } });
    const decision = await classifyEngineeringIntentWithSemanticAssessment(config, { request: "inspect this repository", explicitIntent: "audit" }, {
      service, binding: { projectId: "demo", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(decision).toMatchObject({ intent: "audit", mechanism: "DETERMINISTIC" });
    expect(calls).toBe(0);
  });

  it.each([
    "Explícame cómo funciona el sistema de validación de este repositorio.",
    "¿Cómo funciona la validación aquí?",
    "Explícame la arquitectura de validación.",
    "¿Qué validadores usa este proyecto?",
    "¿Cómo decide AEH si una tarea pasó?",
    "Quiero entender el flujo de validación.",
    "¿Cómo está implementado el sistema de validación?",
    "Explain how validation works in this repository.",
    "How is the validation system implemented?",
    "What validators does this project use?",
    "Help me understand the validation architecture.",
    "Review how validation works with me, but do not evaluate it."
  ])("keeps explanatory intent informational: %s", (request) => {
    expect(classifyEngineeringIntentHeuristic(config, { request }).intent).toBe("informational");
  });

  it.each([
    "Audita el sistema de validación.",
    "Revisa si los validators están bien implementados.",
    "Busca errores en el sistema de validación.",
    "Comprueba si los quality gates pueden ser saltados.",
    "Review the validation architecture for defects.",
    "Explain what is wrong with the validation system.",
    "Tell me how validation works and whether it has security problems.",
    "Revisa este repositorio y dime cuáles son los problemas más importantes.",
    "Lista los riesgos más importantes del repositorio.",
    "Find problems in validation."
  ])("routes evaluative intent to audit: %s", (request) => {
    expect(classifyEngineeringIntentHeuristic(config, { request }).intent).toBe("audit");
  });
});

describe("audit validator failure classification", () => {
  function failed(stderr: string): ValidationCheck {
    return { id: "command.test", category: "command", status: "FAIL", message: "test failed with exit code 1.", details: { stderr } };
  }

  it("distinguishes sandbox denial from assertion failures", () => {
    expect(classifyAuditFailure(failed("spawnSync git EPERM: operation not permitted"))).toBe("SANDBOX_DENIAL");
    expect(classifyAuditFailure(failed("AssertionError: expected 2 to equal 3"))).toBe("ASSERTION_FAILURE");
  });

  it("distinguishes missing dependencies and environmental failures", () => {
    expect(classifyAuditFailure(failed("sh: opengrep: command not found"))).toBe("MISSING_DEPENDENCY");
    expect(classifyAuditFailure(failed("command timed out after 30s"))).toBe("ENVIRONMENT_FAILURE");
  });

  it("uses NONE for passing checks", () => {
    expect(classifyAuditFailure({ id: "ok", category: "command", status: "PASS", message: "ok" })).toBe("NONE");
  });
});
