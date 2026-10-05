import { describe, expect, it } from "vitest";
import {
  contractValidationRequirementsV1,
  validationRequirementSchema,
} from "../../src/architecture/validationRequirements.js";

const validators = [
  { id: "static-security", adapter: "opengrep", command: "node scripts/security/opengrep.mjs", required: true },
];

function homeLikeRequirements(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `CHANGE-20261005T095012Z-be9f5ac1-R${index + 1}`,
    validators: ["static-security"],
  }));
}

describe("contract evidence bound (CHANGE-20261005T095012Z-be9f5ac1 rev215)", () => {
  it("bounds evidenceNeeded to <=300 while preserving full requirementRefs", () => {
    const derived = contractValidationRequirementsV1({
      requirements: homeLikeRequirements(10),
      scope: ["**"],
      validators,
    });
    expect(derived).toHaveLength(1);
    const requirement = derived[0]!;
    expect(requirement.id).toBe("static-security");
    // Full binding must remain recoverable via structured refs (never silently dropped).
    expect(requirement.requirementRefs).toHaveLength(10);
    expect(requirement.acceptanceRefs).toHaveLength(10);
    expect(requirement.requirementRefs).toContain("CHANGE-20261005T095012Z-be9f5ac1-R1");
    expect(requirement.requirementRefs).toContain("CHANGE-20261005T095012Z-be9f5ac1-R10");
    // Deterministic bound: schema limits hold.
    expect(requirement.property.length).toBeLessThanOrEqual(500);
    expect(requirement.evidenceNeeded).toHaveLength(1);
    expect(requirement.evidenceNeeded[0]!.length).toBeLessThanOrEqual(300);
    // Typed bound behavior: schema parse must succeed (rev215 threw too_big at evidenceNeeded/0).
    expect(() => validationRequirementSchema.parse(requirement)).not.toThrow();
    // Bounded summary carries the count + check id; refs carry the full list.
    expect(requirement.evidenceNeeded[0]).toContain("static-security");
    expect(requirement.evidenceNeeded[0]).toContain("10");
  });

  it("keeps detailed evidence when it fits (no digest churn for small contracts)", () => {
    const derived = contractValidationRequirementsV1({
      requirements: [
        { id: "AC-1", validators: ["static-security"] },
        { id: "AC-2", validators: ["static-security"] },
      ],
      scope: ["src/**"],
      validators,
    });
    expect(derived).toHaveLength(1);
    const requirement = derived[0]!;
    expect(requirement.evidenceNeeded[0]).toContain("AC-1");
    expect(requirement.evidenceNeeded[0]).toContain("AC-2");
    expect(() => validationRequirementSchema.parse(requirement)).not.toThrow();
  });
});
