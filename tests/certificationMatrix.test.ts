import { describe, expect, it } from "vitest";
import { CERTIFICATION_CAPABILITY_MATRIX } from "../src/certification/types.js";

describe("certification capability matrix", () => {
  it("covers the externally observable architecture journeys", () => {
    const capabilities = new Set(CERTIFICATION_CAPABILITY_MATRIX.map((item) => item.capability));
    expect(typeof capabilities.has).toBe("function");
    for (const required of ["startup", "informational", "audit", "direct-change", "delegated-change", "formal-sdd", "multi-worker", "product-repair", "certification-repair", "context-handoff", "permission-delegation", "issue-driven", "delivery", "distributed-execution", "project-home", "multi-project", "control-center", "authority"]) expect(capabilities.has(required as never)).toBe(true);
    expect(CERTIFICATION_CAPABILITY_MATRIX.every((item) => item.requiredEvidence.length > 0)).toBe(true);
  });
});
