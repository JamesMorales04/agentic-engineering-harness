import { describe, expect, it } from "vitest";
import { normalizeAgentProfile, requiresSpecEscalation } from "../src/operations/change.js";

describe("natural-language change routing", () => {
  it("does not reinterpret workflow modes as agent topology profiles", () => {
    expect(normalizeAgentProfile("quick")).toBeUndefined();
    expect(normalizeAgentProfile("SPEC")).toBeUndefined();
    expect(normalizeAgentProfile("backend-workers")).toBe("backend-workers");
  });

  it("does not escalate QUICK because a scope packet says product file", () => {
    const planner = { payload: { fallbackRouting: ["Reject any other product-file addition and return to the operation supervisor."] } } as never;
    expect(requiresSpecEscalation(undefined, planner)).toBe(false);
  });

  it("escalates an explicit product-decision fallback", () => {
    const planner = { payload: { fallbackRouting: ["Route to a human because this requires a product decision."] } } as never;
    expect(requiresSpecEscalation(undefined, planner)).toBe(true);
  });
});
