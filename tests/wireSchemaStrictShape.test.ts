import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knownOutputContracts, outputJsonSchema, outputStrictChannelSchema } from "../src/agents/outputContracts.js";

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
 * SCOPE (strict subset, no narrowing at the zod layer):
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
 * - (D) STRICT REQUIRED COVERAGE (OpenAI strict subset): every `type: object`
 *   node — root, nested, array items, and every anyOf branch — lists every one
 *   of its `properties` keys in `required`. Zod-optional scalars travel as
 *   nullable-typed entries (`type: [<base>, "null"]`) inside required;
 *   arrays/objects with Zod defaults travel required-present (empty = absent).
 *   The deterministic Zod validation stays authoritative for legacy payloads
 *   that omit optional keys (no payload-narrowing regression: legacy-acceptance
 *   and PASS+SAFE positive tests stay green at the Zod layer).
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
        // Required must mirror the base required list (both now cover every
        // property key per the strict subset; see the required-coverage test).
        if (JSON.stringify([...req].sort()) !== JSON.stringify([...parentRequired].sort())) {
          violations.push(`${label}: required ${JSON.stringify(req)} !== base ${JSON.stringify(parentRequired)}`);
        }
        if (JSON.stringify([...props].sort()) !== JSON.stringify([...parentProps].sort())) {
          violations.push(`${label}: properties ${JSON.stringify(props)} !== base ${JSON.stringify(parentProps)}`);
        }
        // A branch must never drop a base-required key from required.
        for (const key of props) {
          if (parentRequired.includes(key) && !req.includes(key)) {
            violations.push(`${label}: base-required '${key}' missing from branch required`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("requires every property key in required on EVERY object node (strict subset)", () => {
    // OpenAI strict subset: `required ... including every key in properties`
    // (codex-requalification-2026-10-04.json F4). The previous mirror-base
    // assertion alone was insufficient: a base with optional keys outside
    // required (repair-result 0/5, implementer 7/9, reviewer 4/5, supervisor
    // 7/8, spec artifacts proposal/design/tasks) passed the mirror check while
    // remaining non-strict. This walks root + nested + array-items + every
    // anyOf branch and demands required ⊇ properties keys everywhere.
    const violations: string[] = [];
    for (const contract of knownOutputContracts()) {
      const schema = schemaFor(contract);
      walk(schema, (node, path) => {
        if (node.type !== "object" || !node.properties || typeof node.properties !== "object") return;
        const props = Object.keys(node.properties as Record<string, unknown>);
        const required = node.required;
        if (!Array.isArray(required)) {
          violations.push(`${contract} ${path}: missing required (properties: ${props.join(",")})`);
          return;
        }
        for (const key of props) {
          if (!(required as unknown[]).includes(key)) {
            violations.push(`${contract} ${path}: property '${key}' not in required`);
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

  it("documented root-anyOf deviation surface is exactly as recorded (STRICT_DEVIATION)", () => {
    // Pins src/agents/outputContracts.ts STRICT_DEVIATION: root-level `anyOf`
    // on exactly the 6 cross-field-gate contracts is the SOLE deviation from
    // the OpenAI strict-root rule. Nested `anyOf` elsewhere is strict-legal
    // per OpenAI ("for anyOf, the nested schemas must each be a valid JSON
    // Schema") and pre-existing (semantic-assessment judgment union) — it is
    // NOT part of the deviation. Within the 6 gate contracts, `anyOf` appears
    // exactly once (at root); any nested anyOf/oneOf there fails here.
    const documented = ["explorer", "implementer", "repair-result", "reviewer", "spec-authoring", "supervisor"];
    const withRootAnyOf: string[] = [];
    const violations: string[] = [];
    for (const contract of knownOutputContracts()) {
      const schema = schemaFor(contract);
      walk(schema, (node, path) => {
        if ("oneOf" in node) violations.push(`${contract} ${path}: oneOf`);
        if (Array.isArray(node["anyOf"])) {
          if (path === "root") {
            withRootAnyOf.push(contract);
          } else if (documented.includes(contract)) {
            violations.push(`${contract} ${path}: nested anyOf (deviation allows root only)`);
          }
        }
      });
    }
    // Exactly the 6 documented contracts; planner (minItems:1 gate) stays root-clean.
    expect(withRootAnyOf.sort()).toEqual(
      ["explorer", "implementer", "repair-result", "reviewer", "spec-authoring", "supervisor"],
    );
    // Every branch object is otherwise strict-legal: object type,
    // additionalProperties:false, required covers every properties key, and
    // no other banned composition keyword inside the branch subtree.
    for (const contract of withRootAnyOf) {
      const schema = schemaFor(contract);
      const branches = (schema as { anyOf: unknown[] }).anyOf;
      for (const branch of branches) {
        walk(branch, (node, path) => {
          if (node.type === "object") {
            if (node.additionalProperties !== false) {
              violations.push(`${contract} branch ${path}: additionalProperties !== false`);
            }
            if (node.properties && typeof node.properties === "object") {
              const props = Object.keys(node.properties as Record<string, unknown>);
              const required = node.required;
              if (!Array.isArray(required)) {
                violations.push(`${contract} branch ${path}: missing required`);
              } else {
                for (const key of props) {
                  if (!(required as unknown[]).includes(key)) {
                    violations.push(`${contract} branch ${path}: property '${key}' not in required`);
                  }
                }
              }
            }
          }
          for (const keyword of ["oneOf", "not", "if", "propertyNames", "$ref", "$defs", "discriminator"] as const) {
            if (keyword in node) violations.push(`${contract} branch ${path}: ${keyword}`);
          }
          if ("contains" in node) violations.push(`${contract} branch ${path}: contains`);
          if (Array.isArray(node["anyOf"]) && path !== "root") {
            violations.push(`${contract} branch ${path}: nested anyOf`);
          }
        }, `${contract}-branch`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("strict-channel projection strips ONLY root anyOf (shapes otherwise identical)", () => {
    for (const contract of knownOutputContracts()) {
      const full = outputJsonSchema(contract) as Record<string, unknown>;
      const projected = outputStrictChannelSchema(contract) as Record<string, unknown>;
      expect(projected).toBeDefined();
      expect(projected).not.toHaveProperty("anyOf");
      const { anyOf: _dropped, ...fullRest } = full as Record<string, unknown> & { anyOf?: unknown };
      expect(projected).toEqual(fullRest);
      // Payload shapes unchanged: same properties/required keys.
      expect(projected["properties"]).toEqual(full["properties"]);
      expect(projected["required"]).toEqual(full["required"]);
      expect(projected["type"]).toBe("object");
    }
    expect(outputStrictChannelSchema("does-not-exist")).toBeUndefined();
    // Projection returns a clone: mutating it must not affect the full schema.
    const before = outputJsonSchema("reviewer") as Record<string, unknown>;
    const proj = outputStrictChannelSchema("reviewer") as Record<string, unknown>;
    (proj.properties as Record<string, unknown>)["verdict"] = { enum: ["MUTATED"] };
    expect((before.properties as Record<string, Record<string, unknown>>)["verdict"]).not.toEqual({ enum: ["MUTATED"] });
  });

  it("strict-channel sinks (Codex + Paseo --output-schema) serve the projection", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "..", "src", "workers", "agentPrompt.ts"), "utf8");
    const execCodex = source.slice(source.indexOf("async function executeCodex"));
    const nextFn = execCodex.indexOf("\nasync function ", 1);
    const codexBody = nextFn === -1 ? execCodex : execCodex.slice(0, nextFn);
    expect(codexBody).toContain("outputStrictChannelSchema");
    expect(codexBody).toContain("--output-schema");
    expect(codexBody).not.toContain("outputJsonSchema");
    // Paseo submission paths are strict channels too: Paseo runtime forwards
    // via --output-schema to OpenAI response_format json_schema strict:true
    // (src/paseo/runtimeCore.ts + src/semantic/assessment.ts), so the
    // materialized dispatch + executeViaPaseo (resume/materialized/fresh-launch)
    // paths must serve the strict projection (root-anyOf-free).
    const execPaseo = source.slice(source.indexOf("async function executeViaPaseo"));
    const paseoEnd = execPaseo.indexOf("\nasync function ", 1);
    const paseoBody = paseoEnd === -1 ? execPaseo : execPaseo.slice(0, paseoEnd);
    expect(paseoBody).toContain("outputStrictChannelSchema");
    expect(paseoBody).not.toMatch(/outputJsonSchema\s*\(/);
    // Materialized dispatch path (continueWithDurableResultReconciliation call
    // site) serves the projection as well.
    expect(source).toMatch(/outputStrictChannelSchema\(effectiveOptions\.outputContract\)/);
    expect(source).toMatch(/outputStrictChannelSchema\(options\.outputContract\)/);
    // Projection is root-anyOf-free on every shipped contract.
    for (const contract of knownOutputContracts()) {
      const projected = outputStrictChannelSchema(contract) as Record<string, unknown>;
      expect(projected).toBeDefined();
      expect(projected).not.toHaveProperty("anyOf");
    }
    // Justified full-schema use-sites stay intact: MCP inputSchema reuse +
    // provenance digest (STRICT_DEVIATION rationale — gates enforced by Zod
    // on receipt).
    expect(source).toMatch(/const outputSchema = outputJsonSchema\(options\.outputContract!\)/);
    const mcpSource = fs.readFileSync(path.join(here, "..", "src", "workers", "resultSinkMcp.ts"), "utf8");
    expect(mcpSource).toContain("outputJsonSchema(channel.contract)");
  });
});
