import { describe, expect, it } from "vitest";
import { knownOutputContracts, outputJsonSchema } from "../src/agents/outputContracts.js";

/**
 * WIRE SCHEMA STRICT-SHAPE: every shipped output contract must survive
 * Codex/Paseo `response_format strict:true` (reached via Paseo `--output-schema`
 * + Codex `--output-schema`, src/paseo/runtimeCore.ts + src/semantic/assessment.ts
 * + src/workers/agentPrompt.ts executeCodex, plus MCP `inputSchema` reuse in
 * src/workers/resultSinkMcp.ts).
 *
 * Generalizes tests/semanticCodexStrictSchema.test.ts:53
 * (all objects additionalProperties:false, all properties required, anyOf
 * branches full-shape) to EVERY shipped output contract.
 *
 * SCOPE (prevents recurrence without narrowing):
 * - (A) every `type: object` node (including nested + anyOf branches) carries
 *   `additionalProperties: false`;
 * - (B) every `anyOf` branch is FULL-SHAPE (strict-legal): `type: object`,
 *   `additionalProperties: false`, `required` mirrors the parent object's
 *   `required`, and `properties` keys mirror the parent's `properties` keys,
 *   narrowing only the single gated constraint (verdict enum, findings
 *   minItems:1, unresolved/missingEvidence maxItems:0, proposal/tasks
 *   minLength:1, explorer per-branch minItems:1, filesChanged/
 *   filesNeededOutsideScope maxItems:0). Partial branches
 *   (`{ properties: { gated: {...} } }` without additionalProperties/required)
 *   are rejected by Codex strict (`additionalProperties is required to be
 *   supplied and to be false`, docs/evidence/model-routing/
 *   codex-structured-output-probe-2026-10-04.json trial 4; `required ... including
 *   every key in properties`, codex-requalification-2026-10-04.json F4).
 * - (C) no rejected composition keywords ($schema/oneOf/not/if/contains/
 *   propertyNames/$ref/$defs/discriminator).
 *
 * PRE-EXISTING BASE OPTIONALS (reported separately, NOT silently fixed to avoid
 * narrowing): several base schemas list optional properties without requiring
 * them (planner filesNeededOutsideScope/formalization*, explorer notes,
 * reviewer confidence/exceptionType/location lines, supervisor roadmap/,
 * implementer filesNeededOutsideScope/contractSync, knowledge-pack
 * skillCandidate/sources.version, orchestrator validationStatus/
 * finalizationSafe, validator checks.evidence, spec artifacts proposal/design/
 * tasks, repair-result required:[]). Those mirror the zod `.optional()`/
 * `.default()` shapes and are accepted by the Paseo non-Codex providers in
 * production today; forcing them required would narrow (reject currently-valid
 * payloads). Branch check (B) therefore mirrors the BASE required list rather
 * than demanding every listed property be required. See repair report for the
 * full pre-existing inventory with evidence.
 */
function walk(node: unknown, visit: (node: Record<string, unknown>, path: string) => void, path = "root"): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record, path);
  if (record.properties && typeof record.properties === "object") {
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) walk(child, visit, `${path}.${key}`);
  }
  if (record.items && typeof record.items === "object" && !Array.isArray(record.items)) walk(record.items, visit, `${path}.items`);
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) branches.forEach((branch, index) => walk(branch, visit, `${path}.${keyword}[${index}]`));
  }
}

function schemaFor(contract: string): Record<string, unknown> {
  const schema = outputJsonSchema(contract);
  expect(schema).toBeDefined();
  return schema as Record<string, unknown>;
}

describe("wire schema strict-shape (every shipped contract)", () => {
  it("covers every shipped output contract", () => {
    expect(knownOutputContracts()).toEqual(
      expect.arrayContaining(["explorer", "planner", "knowledge-pack", "spec-authoring", "implementer", "repair-result", "reviewer", "validator", "recovery", "orchestrator", "supervisor", "semantic-assessment"]),
    );
    expect(knownOutputContracts().length).toBeGreaterThanOrEqual(12);
  });

  it("sets additionalProperties:false on every object (including anyOf branches)", () => {
    const violations: string[] = [];
    for (const contract of knownOutputContracts()) {
      const schema = schemaFor(contract);
      walk(schema, (node, path) => {
        if (node.type === "object" && node.additionalProperties !== false) {
          violations.push(`${contract} ${path}: additionalProperties !== false`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("keeps every anyOf branch full-shape (mirrors parent required + properties)", () => {
    const violations: string[] = [];
    for (const contract of knownOutputContracts()) {
      const schema = schemaFor(contract);
      const parentRequired = (schema.required ?? []) as string[];
      const parentProps = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
      const branches = (schema as { anyOf?: unknown[] }).anyOf;
      if (branches === undefined) continue;
      expect(Array.isArray(branches)).toBe(true);
      if (!Array.isArray(branches) || branches.length === 0) {
        violations.push(`${contract} root: empty anyOf`);
        continue;
      }
      branches.forEach((branch, index) => {
        const b = branch as Record<string, unknown>;
        const label = `${contract} anyOf[${index}]`;
        if (b.type !== "object") violations.push(`${label}: type !== object`);
        if (b.additionalProperties !== false) violations.push(`${label}: additionalProperties !== false`);
        const req = (b.required ?? []) as string[];
        const props = b.properties && typeof b.properties === "object" ? Object.keys(b.properties as Record<string, unknown>) : [];
        // Required must mirror the base required list (superset safety: optional
        // keys stay optional-present, never forced required to avoid narrowing).
        if (JSON.stringify([...req].sort()) !== JSON.stringify([...parentRequired].sort())) {
          violations.push(`${label}: required ${JSON.stringify(req)} !== base ${JSON.stringify(parentRequired)}`);
        }
        if (JSON.stringify([...props].sort()) !== JSON.stringify([...parentProps].sort())) {
          violations.push(`${label}: properties ${JSON.stringify(props)} !== base ${JSON.stringify(parentProps)}`);
        }
        // Every listed branch property must be in required unless it is optional
        // in the base (i.e. present in base properties but absent from base
        // required). A branch must never drop a base-required key from required.
        for (const key of props) {
          if (parentRequired.includes(key) && !req.includes(key)) {
            violations.push(`${label}: base-required '${key}' missing from branch required`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("carries no rejected strict keywords on any contract", () => {
    const violations: string[] = [];
    for (const contract of knownOutputContracts()) {
      const schema = schemaFor(contract);
      const text = JSON.stringify(schema);
      if (text.includes("$schema")) violations.push(`${contract}: $schema`);
      walk(schema, (node, path) => {
        for (const keyword of ["oneOf", "propertyNames", "$ref", "$defs", "discriminator", "not", "if"] as const) {
          if (keyword in node) violations.push(`${contract} ${path}: ${keyword}`);
        }
        if ("contains" in node) violations.push(`${contract} ${path}: contains`);
      });
    }
    expect(violations).toEqual([]);
  });

  it("explorer keeps seven full-shape branches (one gated array each)", () => {
    const schema = schemaFor("explorer") as { anyOf: Array<{ properties: Record<string, unknown> }> };
    expect(schema.anyOf.length).toBe(7);
    const gated = ["relevantFiles", "findings", "moduleBoundaries", "tests", "dependencies", "risks", "openQuestions"];
    gated.forEach((key, index) => {
      const props = schema.anyOf[index]!.properties;
      expect(props[key]).toMatchObject({ type: "array", minItems: 1 });
    });
  });
});
