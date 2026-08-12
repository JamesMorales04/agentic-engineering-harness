import { describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../src/validators/evidence.js";
describe("policy evidence", () => { it("detects dependency and schema-affecting files", () => { const evidence = collectPolicyEvidence(["apps/web/package.json", "src/Migrations/20260101_AddPet.sql", "src/Pets/Pet.cs"]); expect(evidence.newDependencies).toEqual(["apps/web/package.json"]); expect(evidence.schemaChanged).toBe(true); expect(evidence.schemaFiles).toContain("src/Migrations/20260101_AddPet.sql"); }); });
