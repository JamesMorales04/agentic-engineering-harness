import { describe, expect, it } from "vitest";
import { assertIntentDecisionForRoute, createIntentDecision, parseIntentDecision, validateIntentDecision } from "../src/audit/intentDecision.js";

describe("IntentDecisionV1", () => {
  it("accepts a lead semantic decision and keeps the route descriptive", () => {
    const decision = createIntentDecision("informational", "explain the validation flow", "lead-semantic", { userTurnId: "lead-1:turn-2" });
    expect(decision).toMatchObject({ version: 1, source: "lead-semantic", intent: "informational", userTurnId: "lead-1:turn-2" });
    expect(decision.effects).toEqual({ evaluate: false, mutateRepository: false, executePreparedTask: false, deliver: false });
    expect(assertIntentDecisionForRoute(decision, "informational")).toEqual(decision);
  });

  it.each([
    { intent: "informational", effects: { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false } },
    { intent: "audit", effects: { evaluate: true, mutateRepository: true, executePreparedTask: false, deliver: false } },
    { intent: "change", effects: { evaluate: false, mutateRepository: false, executePreparedTask: false, deliver: false } },
    { intent: "audit", effects: { evaluate: true, mutateRepository: false, executePreparedTask: false, deliver: true } }
  ])("rejects contradictory effects without reading a human request", ({ intent, effects }) => {
    const result = validateIntentDecision({ version: 1, source: "lead-semantic", intent, requestedOutcome: "compact outcome", effects });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects policy override fields through strict schema validation", () => {
    expect(() => parseIntentDecision({
      version: 1,
      source: "lead-semantic",
      intent: "change",
      requestedOutcome: "implement the selected fix",
      effects: { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false },
      skipValidation: true
    })).toThrow(/INVALID_INTENT_DECISION/);
  });

  it("does not allow an unresolved referent to authorize mutation", () => {
    expect(() => assertIntentDecisionForRoute(createIntentDecision("change", "fix that", "lead-semantic", { resolution: "unresolved-reference" }), "change")).toThrow(/resolved referent/);
  });

  it("does not let a route reinterpret the requested outcome", () => {
    const audit = createIntentDecision("audit", "explain why finding two matters", "lead-semantic");
    expect(() => assertIntentDecisionForRoute(audit, "informational")).toThrow(/does not match/);
  });
});
