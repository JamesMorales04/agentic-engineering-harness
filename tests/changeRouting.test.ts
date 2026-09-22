import { describe, expect, it } from "vitest";
import { normalizeAgentProfile, requiresSpecEscalation, formalizeEscalatedTriage } from "../src/operations/change.js";
import { triageChange } from "../src/core/triage.js";

describe("natural-language change routing", () => {
  it("does not reinterpret workflow modes as agent topology profiles", () => {
    expect(normalizeAgentProfile("formal-sdd")).toBeUndefined();
    expect(normalizeAgentProfile("CHANGE")).toBeUndefined();
    expect(normalizeAgentProfile("backend-workers")).toBe("backend-workers");
  });

  it("does not escalate a direct route because a scope packet names a product file", () => {
    const planner = { payload: {} } as never;
    expect(requiresSpecEscalation(undefined, planner)).toBe(false);
  });

  it("escalates a typed formalization requirement", () => {
    const planner = { payload: { formalizationNeed: "REQUIRED", formalizationReason: "PRODUCT_UNCERTAINTY", formalizationEvidenceRefs: ["planner:uncertainty"] } } as never;
    expect(requiresSpecEscalation(undefined, planner)).toBe(true);
  });

  it("rewrites route evidence when durable evidence escalates to formal SDD", () => {
    const initial = triageChange({}, { request: "coordinate this bounded implementation", files: ["src/example.ts"], risk: "low" });
    const escalated = formalizeEscalatedTriage(initial);
    expect(escalated).toMatchObject({ route: "FORMAL_SDD", assurance: "ELEVATED" });
    expect(escalated.routeEvidence.every((item) => item.route === "FORMAL_SDD")).toBe(true);
  });
});
