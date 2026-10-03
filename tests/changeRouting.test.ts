import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { delegatedCapsuleObjectiveV1, normalizeAgentProfile, requiresSpecEscalation, specEscalationConstraintV1, formalizeEscalatedTriage } from "../src/operations/change.js";
import { triageChange, triageChangeWithSemanticAssessment } from "../src/core/triage.js";
import { createRoutedContract } from "../src/core/contract.js";
import { requiresDelegatedPlanningV1 } from "../src/agents/routingV2.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

describe("natural-language change routing", () => {
  it("uses a validated concise outcome while retaining the full request in the TaskContract", async () => {
    const request = `Implement the user-requested repair while preserving every detail. ${"Additional acceptance context. ".repeat(40)}`;
    const objective = "Repair the Home operation flow and preserve its authorization gates.";
    const payload = { request, intentDecision: { version: 1, source: "lead-semantic", intent: "change", requestedOutcome: objective, effects: { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false } } } as const;

    expect(delegatedCapsuleObjectiveV1(payload as never)).toBe(objective);
    expect(payload.request).toBe(request);
    expect(request.length).toBeGreaterThan(500);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-long-request-contract-"));
    try {
      const { contract } = await createRoutedContract(root, { version: 1, project: { name: "fixture" } }, "TASK-LONG-REQUEST", {
        title: "Long request repair",
        request,
        scope: ["src/**"]
      });
      expect(contract.request).toBe(request);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when a delegated capsule has no usable concise objective", () => {
    expect(() => delegatedCapsuleObjectiveV1({ request: "x".repeat(501) })).toThrow("DELEGATED_CAPSULE_OBJECTIVE_REQUIRED");
    expect(() => delegatedCapsuleObjectiveV1({ request: "A short request", intentDecision: { version: 1, source: "lead-semantic", intent: "change", requestedOutcome: "x".repeat(501), effects: { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false } } })).toThrow("DELEGATED_CAPSULE_OBJECTIVE_INVALID");
  });

  it("uses the validated outcome as the objective on the short request path", () => {
    const request = "Repair the save button.";
    expect(delegatedCapsuleObjectiveV1({ request, intentDecision: { version: 1, source: "explicit-cli", intent: "change", requestedOutcome: request, effects: { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false } } })).toBe(request);
  });

  it("requires an operation intent even when the original request is short", () => {
    expect(() => delegatedCapsuleObjectiveV1({ request: "Repair the save button." })).toThrow("DELEGATED_CAPSULE_OBJECTIVE_REQUIRED");
  });

  it("binds configured project validators into deterministic contract requirement traceability", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-contract-validators-"));
    try {
      const config = {
        version: 1,
        project: { name: "fixture" },
        validation: {
          baseRef: "main",
          commands: [{ id: "fixture-greeting", command: "node scripts/validate.mjs", required: true }],
          validators: [{ id: "contract-test", adapter: "contract-test", command: "node scripts/contract.mjs" }]
        }
      } as HarnessProjectConfig;
      const { contract } = await createRoutedContract(root, config, "TASK-VALIDATORS", { title: "traceability", request: "add an export", scope: ["src/greeting.mjs"], acceptance: ["node scripts/validate.mjs passes"] });
      expect(contract.requirements).toEqual([expect.objectContaining({ id: "AC-1", validators: ["command.fixture-greeting", "contract-test"] })]);

      const explicit = await createRoutedContract(root, config, "TASK-EXPLICIT", { title: "explicit", request: "add an export", scope: [], requirements: [{ id: "R-1", description: "explicitly validated", validators: ["custom-check"] }] });
      expect(explicit.contract.requirements).toEqual([expect.objectContaining({ id: "R-1", validators: ["custom-check"] })]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret workflow modes as agent topology profiles", () => {
    expect(normalizeAgentProfile("formal-sdd")).toBeUndefined();
    expect(normalizeAgentProfile("CHANGE")).toBeUndefined();
    expect(normalizeAgentProfile("backend-workers")).toBe("backend-workers");
  });

  it("does not escalate a direct route because a scope packet names a product file", () => {
    const planner = { payload: {} } as never;
    expect(requiresSpecEscalation(planner)).toBe(false);
  });

  it("escalates a typed formalization requirement", () => {
    const planner = { payload: { formalizationNeed: "REQUIRED", formalizationReason: "PRODUCT_UNCERTAINTY", formalizationEvidenceRefs: ["planner:uncertainty"] } } as never;
    expect(requiresSpecEscalation(planner)).toBe(true);
    expect(specEscalationConstraintV1(planner)).toEqual({
      constraint: "PLANNER_FORMALIZATION_NEED_REQUIRED",
      plannerFormalizationNeed: "REQUIRED",
      plannerFormalizationReason: "PRODUCT_UNCERTAINTY",
      plannerFormalizationEvidenceRefs: ["planner:uncertainty"]
    });
  });

  it("routes the planner's evidence-bound OTHER formalization requirement to FORMAL_SDD", () => {
    const planner = { payload: { formalizationNeed: "REQUIRED", formalizationReason: "OTHER", formalizationEvidenceRefs: ["openspec/config.yaml", "planner:discovery"] } } as never;
    expect(requiresSpecEscalation(planner)).toBe(true);
  });

  it("does not escalate a PARTIAL explorer finding with planner formalizationNeed NONE (Round-11 AEH-V2-0110)", () => {
    const planner = { payload: { formalizationNeed: "NONE", workUnits: [] } } as never;
    expect(requiresSpecEscalation(planner)).toBe(false);
    expect(specEscalationConstraintV1({ payload: { formalizationNeed: "RECOMMENDED" } } as never)).toBeUndefined();
    expect(requiresSpecEscalation(undefined)).toBe(false);
  });

  it("rewrites route evidence when durable evidence escalates to formal SDD", () => {
    const initial = triageChange({}, { request: "coordinate this bounded implementation", files: ["src/example.ts"], risk: "low" });
    const escalated = formalizeEscalatedTriage(initial);
    expect(escalated).toMatchObject({ route: "FORMAL_SDD", assurance: "ELEVATED" });
    expect(escalated.routeEvidence.every((item) => item.route === "FORMAL_SDD")).toBe(true);
  });
});

describe("AEH-V2-0128 delegation floor unification", () => {
  const fixtureConfig = { version: 1, project: { name: "fixture" } } as HarnessProjectConfig;

  it("keeps the deterministic delegation floor independent of the concrete file count", async () => {
    expect(requiresDelegatedPlanningV1({ files: ["src/a.ts", "src/b.ts"] })).toBe(false);
    expect(requiresDelegatedPlanningV1({ files: ["src/a.ts"], expectedWorkUnits: 2 })).toBe(true);
    expect(requiresDelegatedPlanningV1({ files: [] })).toBe(true);
    expect(requiresDelegatedPlanningV1({ files: ["src/*.ts"] })).toBe(true);
    expect(requiresDelegatedPlanningV1({ files: ["a", "b", "c", "d", "e", "f"] })).toBe(true);
    expect(triageChange(fixtureConfig, { request: "add a farewell module and an export", files: ["src/farewell.mjs", "src/greeting.mjs"], risk: "low" }).route).toBe("DIRECT");
  });

  it("seals the same route the semantic triage selected for a concrete two-file scope", async () => {
    const files = ["src/farewell.mjs", "src/greeting.mjs"];
    const service = semanticTestService({ payload: (request) => semanticPayload(request, { judgment: { type: "ROUTE", recommendedRoute: "DIRECT", scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: request.evidenceRefs, unknowns: [] } }) });
    const semantic = await triageChangeWithSemanticAssessment(fixtureConfig, { request: "add a farewell module and an export", files, risk: "low" }, {
      service, binding: { projectId: "fixture", repositoryDigest: "repo-digest" }, policyRevision: semanticCapabilityPolicyRevisionV1
    });
    expect(semantic).toMatchObject({ route: "DIRECT", mechanism: "HYBRID" });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-routing-0128-"));
    try {
      const { contract } = await createRoutedContract(root, fixtureConfig, "TASK-0128", { title: "farewell", request: "add a farewell module and an export", scope: files, acceptance: ["node scripts/validate.mjs passes"] });
      expect(contract.routing?.route).toBe(semantic.route);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
