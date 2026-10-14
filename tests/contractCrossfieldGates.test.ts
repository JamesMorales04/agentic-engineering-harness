import { describe, expect, it } from "vitest";
import {
  explorerOutputSchema,
  implementerOutputSchema,
  outputJsonSchema,
  plannerOutputSchema,
  reviewerOutputSchema,
  supervisorOutputSchema,
  validateAgentOutput,
} from "../src/agents/outputContracts.js";

const finding = (severity: "critical" | "high" | "medium" = "critical") => ({
  id: "F1",
  severity,
  category: "correctness",
  location: { file: "src/a.ts", startLine: 1, endLine: 2 },
  evidence: "ex",
  impact: "im",
  recommendedFix: "fix",
  requiredCompetencies: ["general-engineering"],
});

const workUnit = () => ({
  id: "wu-1",
  objective: "Do the thing",
  scope: ["src/**"],
  dependencies: [],
  requirementRefs: [],
  acceptanceRefs: [],
  competencies: ["general-engineering"],
  riskTags: [],
  changeKinds: ["source"] as const[],
  risk: "low" as const,
});

describe("H-NEW-2 cross-field gates (RED first)", () => {
  it("rejects reviewer PASS + critical finding + SAFE", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS", findings: [finding()], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects reviewer PASS_WITH_WARNINGS + high finding + SAFE", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS_WITH_WARNINGS", findings: [finding("high")], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects reviewer FAIL with zero findings", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects supervisor SAFE with non-empty unresolved", () => {
    expect(
      validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: ["open"], roadmap: [], finalizationSafety: "SAFE" }).ok,
    ).toBe(false);
  });
  it("rejects supervisor SAFE with non-empty missingEvidence", () => {
    expect(
      validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: ["no proof"], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }).ok,
    ).toBe(false);
  });
  it("rejects fully-empty implementer result", () => {
    expect(
      validateAgentOutput("implementer", { filesChanged: [], behaviorImplemented: [], decisions: [], assumptions: [], risks: [], validationCommands: [], followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects fully-empty explorer result", () => {
    expect(
      validateAgentOutput("explorer", { summary: "done", relevantFiles: [], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] }).ok,
    ).toBe(false);
  });
  it("rejects planner with empty workUnits", () => {
    expect(validateAgentOutput("planner", { workUnits: [] }).ok).toBe(false);
  });
  it("audit and change lanes agree on FAIL-empty reviewer output (shared schema gate)", () => {
    // Both src/agents/reviewLifecycle.ts (change lane) and src/audit/run.ts (audit lane)
    // parse via reviewerOutputSchema; the FAIL-empty gate must live in the schema.
    expect(
      reviewerOutputSchema.safeParse({ verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] }).success,
    ).toBe(false);
  });

  it("positive controls stay valid", () => {
    expect(validateAgentOutput("reviewer", { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }).ok).toBe(true);
    expect(validateAgentOutput("reviewer", { verdict: "FAIL", findings: [finding()], finalizationSafety: "BLOCKED", followUp: [] }).ok).toBe(true);
    expect(validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }).ok).toBe(true);
    expect(validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: ["x"], roadmap: [], finalizationSafety: "BLOCKED" }).ok).toBe(true);
    expect(validateAgentOutput("implementer", { filesChanged: ["src/a.ts"], behaviorImplemented: [], decisions: [], assumptions: [], risks: [], validationCommands: [], followUp: [] }).ok).toBe(true);
    expect(explorerOutputSchema.safeParse({ summary: "s", relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }] }).success).toBe(true);
    expect(plannerOutputSchema.safeParse({ workUnits: [workUnit()] }).success).toBe(true);
  });
});

// FAM-WIRE schema parity: the provider-facing JSON schema ALONE must reject each
// violating payload (no zod second layer). Minimal in-test JSON Schema validator
// (ajv-style, strict-subset only: type/required/properties/enum/const/minItems/
// maxItems/minLength/maxLength/pattern/items/additionalProperties/anyOf) — no new
// deps; mirrors how schemas are shipped via Paseo `--output-schema` (strict:true,
// src/paseo/runtimeCore.ts + src/semantic/assessment.ts) and Codex `--output-schema`
// (src/workers/agentPrompt.ts executeCodex).
function wireValid(schema: unknown, value: unknown): boolean {
  const node = schema as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") return true;
  const type = node["type"] as string | undefined;
  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) return false;
  if (type === "array" && !Array.isArray(value)) return false;
  if (type === "string" && typeof value !== "string") return false;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (type === "integer" && !(typeof value === "number" && Number.isInteger(value))) return false;
  if (type === "number" && typeof value !== "number") return false;
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node["const"])) return false;
  if (Array.isArray(node["enum"])) {
    const allowed = node["enum"] as unknown[];
    if (!allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return false;
  }
  if (typeof value === "string") {
    if (typeof node["minLength"] === "number" && value.length < (node["minLength"] as number)) return false;
    if (typeof node["maxLength"] === "number" && value.length > (node["maxLength"] as number)) return false;
    if (typeof node["pattern"] === "string" && !new RegExp(node["pattern"] as string).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof node["minItems"] === "number" && value.length < (node["minItems"] as number)) return false;
    if (typeof node["maxItems"] === "number" && value.length > (node["maxItems"] as number)) return false;
    const items = node["items"] as unknown;
    if (items && typeof items === "object") {
      for (const entry of value) if (!wireValid(items, entry)) return false;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(node["required"])) {
      for (const key of node["required"] as string[]) if (!(key in record)) return false;
    }
    const properties = node["properties"] as Record<string, unknown> | undefined;
    if (properties && typeof properties === "object") {
      for (const [key, sub] of Object.entries(properties)) {
        if (key in record && !wireValid(sub, record[key])) return false;
      }
      if (node["additionalProperties"] === false) {
        const allowed = new Set(Object.keys(properties));
        for (const key of Object.keys(record)) if (!allowed.has(key)) return false;
      }
    }
  }
  if (Array.isArray(node["anyOf"])) {
    const branches = node["anyOf"] as unknown[];
    if (branches.length === 0) return false;
    if (!branches.some((branch) => wireValid(branch, value))) return false;
  }
  return true;
}

function wireSchema(contract: string): Record<string, unknown> {
  const schema = outputJsonSchema(contract);
  expect(schema).toBeDefined();
  return schema as Record<string, unknown>;
}

const wireFinding = (severity: "critical" | "high" | "medium" | "low" = "critical") => ({
  ...finding(severity),
  reviewDimensions: [] as string[],
});

describe("FAM-WIRE parity: JSON schema alone rejects violating payloads", () => {
  it("planner wire rejects empty workUnits (minItems:1)", () => {
    const schema = wireSchema("planner");
    expect((schema["properties"] as Record<string, unknown>)["workUnits"]).toMatchObject({ minItems: 1 });
    expect(
      wireValid(schema, { workUnits: [], affectedAreas: [], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] }),
    ).toBe(false);
    expect(
      wireValid(schema, { workUnits: [workUnit()], affectedAreas: [], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] }),
    ).toBe(true);
  });

  it("explorer wire rejects all-empty evidence (anyOf x7)", () => {
    const schema = wireSchema("explorer");
    expect(schema).toHaveProperty("anyOf");
    expect((schema["anyOf"] as unknown[]).length).toBe(7);
    const empty = {
      summary: "done",
      relevantFiles: [],
      findings: [],
      moduleBoundaries: [],
      tests: [],
      dependencies: [],
      risks: [],
      openQuestions: [],
    };
    expect(wireValid(schema, empty)).toBe(false);
    expect(
      wireValid(schema, { ...empty, relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }] }),
    ).toBe(true);
    expect(wireValid(schema, { ...empty, openQuestions: ["q?"] })).toBe(true);
  });

  it("spec-authoring wire rejects READY without proposal/tasks, accepts BLOCKED", () => {
    const schema = wireSchema("spec-authoring");
    expect(schema).toHaveProperty("anyOf");
    const base = {
      change: "change-test-1",
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [],
      validationReady: true,
    };
    const readyMissing = { ...base, status: "READY", artifacts: { specs: [] } };
    const readyMissingProposal = { ...base, status: "READY", artifacts: { tasks: "- [ ] work", specs: [] } };
    const readyMissingTasks = { ...base, status: "READY", artifacts: { proposal: "# Proposal", specs: [] } };
    const readyEmpty = { ...base, status: "READY", artifacts: { proposal: "", tasks: "", specs: [] } };
    const readyFull = { ...base, status: "READY", artifacts: { proposal: "# Proposal", tasks: "- [ ] work", specs: [] } };
    const blockedBare = { ...base, status: "BLOCKED", artifacts: { specs: [] }, validationReady: false };
    expect(wireValid(schema, readyMissing)).toBe(false);
    expect(wireValid(schema, readyMissingProposal)).toBe(false);
    expect(wireValid(schema, readyMissingTasks)).toBe(false);
    expect(wireValid(schema, readyEmpty)).toBe(false);
    expect(wireValid(schema, readyFull)).toBe(true);
    expect(wireValid(schema, blockedBare)).toBe(true);
  });

  it("reviewer wire rejects FAIL without findings (unsafe-PASS stays zod-only)", () => {
    const schema = wireSchema("reviewer");
    expect(schema).toHaveProperty("anyOf");
    expect(wireValid(schema, { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] })).toBe(false);
    expect(wireValid(schema, { verdict: "FAIL", findings: [wireFinding()], finalizationSafety: "BLOCKED", followUp: [] })).toBe(true);
    expect(wireValid(schema, { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] })).toBe(true);
    // Residual: unsafe PASS (critical/high + SAFE) has no strict-legal wire
    // encoding (`contains`/`not` over nested severity); zod stays authoritative.
    // Wire intentionally still passes it — must NOT narrow to findings-empty.
    expect(wireValid(schema, { verdict: "PASS", findings: [wireFinding()], finalizationSafety: "SAFE", followUp: [] })).toBe(true);
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS", findings: [wireFinding()], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });

  it("supervisor wire rejects SAFE with unresolved/missingEvidence", () => {
    const schema = wireSchema("supervisor");
    expect(schema).toHaveProperty("anyOf");
    const base = { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], roadmap: [] };
    expect(wireValid(schema, { ...base, missingEvidence: [], unresolved: ["open"], finalizationSafety: "SAFE" })).toBe(false);
    expect(wireValid(schema, { ...base, missingEvidence: ["no proof"], unresolved: [], finalizationSafety: "SAFE" })).toBe(false);
    expect(wireValid(schema, { ...base, missingEvidence: [], unresolved: [], finalizationSafety: "SAFE" })).toBe(true);
    expect(wireValid(schema, { ...base, missingEvidence: [], unresolved: ["x"], finalizationSafety: "BLOCKED" })).toBe(true);
    expect(wireValid(schema, { ...base, missingEvidence: ["e"], unresolved: ["x"], finalizationSafety: "RISK_KNOWN" })).toBe(true);
  });

  it("wire schemas stay strict-legal (no rejected keywords)", () => {
    for (const contract of ["planner", "explorer", "spec-authoring", "reviewer", "supervisor"]) {
      const schema = wireSchema(contract);
      const text = JSON.stringify(schema);
      expect(text).not.toContain("$schema");
      expect(schema).not.toHaveProperty("$ref");
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).not.toHaveProperty("not");
      expect(text).not.toContain("\"if\"");
      expect(text).not.toContain("\"contains\"");
      expect(text).not.toContain("propertyNames");
    }
  });
});
