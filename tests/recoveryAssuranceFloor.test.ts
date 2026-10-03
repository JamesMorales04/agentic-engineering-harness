import { describe, expect, it } from "vitest";
import { inheritAssuranceFloorV1 } from "../src/operations/change.js";

describe("linked recovery assurance floor", () => {
  it("raises low semantic triage to the frozen elevated parent minimum", () => {
    expect(inheritAssuranceFloorV1("NONE", "ELEVATED")).toBe("ELEVATED");
  });

  it("preserves higher child assurance and leaves non-recovery assurance unchanged", () => {
    expect(inheritAssuranceFloorV1("CRITICAL", "ELEVATED")).toBe("CRITICAL");
    expect(inheritAssuranceFloorV1("NONE", "NONE")).toBe("NONE");
  });
});
