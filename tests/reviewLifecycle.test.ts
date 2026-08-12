import { describe, expect, it } from "vitest";
import { isBlockingFinding } from "../src/agents/reviewLifecycle.js";
import type { NormalizedFinding } from "../src/agents/outputContracts.js";
function finding(severity: NormalizedFinding["severity"]): NormalizedFinding { return { id: "F", severity, category: "test", location: { file: "x.ts" }, evidence: "e", impact: "i", recommendedFix: "f", suggestedAgent: "implementation-worker" }; }
describe("review lifecycle policy", () => { it("blocks medium and above by default", () => { expect(isBlockingFinding(finding("critical"))).toBe(true); expect(isBlockingFinding(finding("medium"))).toBe(true); expect(isBlockingFinding(finding("low"))).toBe(false); }); });
