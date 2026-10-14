import { describe, expect, it } from "vitest";
import {
  explorerOutputSchema,
  findingSchema,
  implementerOutputSchema,
  outputJsonSchema,
  outputStrictChannelSchema,
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
  resourceClaims: [] as unknown[],
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
  // Strict-subset nullable form: Zod-optional scalars travel as
  // `type: [<base>, "null"]` inside required (OpenAI strict subset: required
  // must cover every property key). A null value is valid only where the type
  // list includes "null"; absent keys still fail `required` above the wire.
  const rawType = node["type"] as string | string[] | undefined;
  const types = Array.isArray(rawType) ? rawType : rawType === undefined ? [] : [rawType];
  // Strict-legal nullable enums MUST list null in `enum` (type includes "null"
  // alone is insufficient: a real validator checks enum membership for null).
  // The previous form returned on null before the enum check, vacuously
  // passing wire enums that exclude null.
  if (value === null) {
    if (!types.includes("null")) return false;
    if (Array.isArray(node["enum"])) {
      return (node["enum"] as unknown[]).some((entry) => entry === null);
    }
    return true;
  }
  const isType = (t: string) => types.includes(t);
  if (isType("object") && (typeof value !== "object" || value === null || Array.isArray(value))) return false;
  if (isType("array") && !Array.isArray(value)) return false;
  if (isType("string") && typeof value !== "string") return false;
  if (isType("boolean") && typeof value !== "boolean") return false;
  if (isType("integer") && !(typeof value === "number" && Number.isInteger(value))) return false;
  if (isType("number") && typeof value !== "number") return false;
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

const zodFinding = (severity: "critical" | "high" | "medium" | "low" = "critical") => ({
  ...finding(severity),
  reviewDimensions: [] as string[],
});

// Wire strict form: every finding key required-present; the Zod-optional
// exceptionType travels explicit null (zod stays authoritative for the legacy
// shape that omits the key — see the no-narrowing test below).
const wireFinding = (severity: "critical" | "high" | "medium" | "low" = "critical") => ({
  ...zodFinding(severity),
  exceptionType: null as null,
});

describe("FAM-WIRE parity: JSON schema alone rejects violating payloads", () => {
  it("planner wire rejects empty workUnits (minItems:1)", () => {
    const schema = wireSchema("planner");
    expect((schema["properties"] as Record<string, unknown>)["workUnits"]).toMatchObject({ minItems: 1 });
    // Strict form: required covers all 9 root keys; Zod-optional scalars travel
    // nullable (formalizationNeed/Reason null), arrays required-present.
    const strictBase = {
      affectedAreas: [],
      reviewDimensions: [],
      validationRequirements: [],
      outOfScopeImprovements: [],
      filesNeededOutsideScope: [],
      formalizationNeed: null,
      formalizationReason: null,
      formalizationEvidenceRefs: [],
    };
    expect(
      wireValid(schema, { ...strictBase, workUnits: [] }),
    ).toBe(false);
    expect(
      wireValid(schema, { ...strictBase, workUnits: [workUnit()] }),
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

  it("explorer wire accepts each single-nonempty-array branch (all seven, no narrowing)", () => {
    const schema = wireSchema("explorer");
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
    // Each evidence array alone must satisfy its own full-shape branch.
    expect(wireValid(schema, { ...empty, relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }] })).toBe(true);
    expect(wireValid(schema, { ...empty, findings: [{ id: "F1", status: "CONFIRMED", evidence: [], notes: null }] })).toBe(true);
    expect(wireValid(schema, { ...empty, moduleBoundaries: ["src/**"] })).toBe(true);
    expect(wireValid(schema, { ...empty, tests: ["tests/a.test.ts"] })).toBe(true);
    expect(wireValid(schema, { ...empty, dependencies: ["dep"] })).toBe(true);
    expect(wireValid(schema, { ...empty, risks: ["risk"] })).toBe(true);
    expect(wireValid(schema, { ...empty, openQuestions: ["q?"] })).toBe(true);
    // Full-shape branches must still accept payloads where other arrays are
    // present (empty or not): additionalProperties:false + full required must
    // not reject extra present evidence.
    expect(
      wireValid(schema, {
        summary: "done",
        relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }],
        findings: [{ id: "F1", status: "CONFIRMED", evidence: ["e"], notes: null }],
        moduleBoundaries: ["m"],
        tests: [],
        dependencies: ["d"],
        risks: [],
        openQuestions: ["q?"],
      }),
    ).toBe(true);
    // Zod agrees: fully-empty still rejected, single-branch still accepted.
    expect(
      explorerOutputSchema.safeParse({ summary: "s", relevantFiles: [], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] }).success,
    ).toBe(false);
    expect(explorerOutputSchema.safeParse({ summary: "s", relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }], findings: [], moduleBoundaries: ["m"], tests: [], dependencies: [], risks: [], openQuestions: [] }).success).toBe(true);
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
    const readyMissing = { ...base, status: "READY", artifacts: { proposal: null, design: null, tasks: null, specs: [] } };
    const readyMissingProposal = { ...base, status: "READY", artifacts: { proposal: null, design: null, tasks: "- [ ] work", specs: [] } };
    const readyMissingTasks = { ...base, status: "READY", artifacts: { proposal: "# Proposal", design: null, tasks: null, specs: [] } };
    const readyEmpty = { ...base, status: "READY", artifacts: { proposal: "", design: null, tasks: "", specs: [] } };
    const readyFull = { ...base, status: "READY", artifacts: { proposal: "# Proposal", design: null, tasks: "- [ ] work", specs: [] } };
    const blockedBare = { ...base, status: "BLOCKED", artifacts: { proposal: null, design: null, tasks: null, specs: [] }, validationReady: false };
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
    expect(wireValid(schema, { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", confidence: null, followUp: [] })).toBe(false);
    expect(wireValid(schema, { verdict: "FAIL", findings: [wireFinding()], finalizationSafety: "BLOCKED", confidence: null, followUp: [] })).toBe(true);
    expect(wireValid(schema, { verdict: "PASS", findings: [], finalizationSafety: "SAFE", confidence: null, followUp: [] })).toBe(true);
    // Residual: unsafe PASS (critical/high + SAFE) has no strict-legal wire
    // encoding (`contains`/`not` over nested severity); zod stays authoritative.
    // Wire intentionally still passes it — must NOT narrow to findings-empty.
    expect(wireValid(schema, { verdict: "PASS", findings: [wireFinding()], finalizationSafety: "SAFE", confidence: null, followUp: [] })).toBe(true);
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS", findings: [zodFinding()], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });

  it("reviewer zod-valid PASS+SAFE with medium/low findings proves no narrowing", () => {
    // The wire gate narrows only FAIL-empty; PASS with medium/low + SAFE must
    // stay valid in BOTH layers (the unsafe-PASS residual is critical/high only).
    for (const severity of ["medium", "low"] as const) {
      const payload = { verdict: "PASS" as const, findings: [zodFinding(severity)], finalizationSafety: "SAFE" as const, followUp: [] as string[] };
      // Wire strict form carries confidence explicitly null and per-finding
      // exceptionType null; zod stays authoritative for the legacy shape
      // without those keys (no narrowing).
      expect(wireValid(wireSchema("reviewer"), { ...payload, confidence: null, findings: [wireFinding(severity)] })).toBe(true);
      expect(validateAgentOutput("reviewer", payload).ok).toBe(true);
    }
    // PASS_WITH_WARNINGS with medium/low + SAFE is likewise valid.
    const warnPayload = { verdict: "PASS_WITH_WARNINGS" as const, findings: [zodFinding("medium")], finalizationSafety: "SAFE" as const, followUp: [] as string[] };
    expect(wireValid(wireSchema("reviewer"), { ...warnPayload, confidence: null, findings: [wireFinding("medium")] })).toBe(true);
    expect(validateAgentOutput("reviewer", warnPayload).ok).toBe(true);
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

  it("spec-authoring whitespace-only proposal/tasks passes wire but fails zod (documented residual)", () => {
    // Wire minLength:1 counts whitespace; zod trim rejects it. The deterministic
    // zod gate stays authoritative for this half; wire must NOT narrow to trim.
    const schema = wireSchema("spec-authoring");
    const base = {
      change: "change-test-1",
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [],
      validationReady: true,
    };
    const whitespaceReady = { ...base, status: "READY", artifacts: { proposal: "   ", design: "# Design", tasks: "  \n ", specs: [] } };
    expect(wireValid(schema, whitespaceReady)).toBe(true);
    expect(validateAgentOutput("spec-authoring", whitespaceReady).ok).toBe(false);
    // Genuine content still passes both layers.
    const genuine = { ...base, status: "READY", artifacts: { proposal: "# Proposal", design: "# Design", tasks: "- [ ] work", specs: [] } };
    expect(wireValid(schema, genuine)).toBe(true);
    expect(validateAgentOutput("spec-authoring", genuine).ok).toBe(true);
  });

  it("planner optional properties stay accepted on wire and zod (strict-travel coverage)", () => {
    // Planner travels strict:true (executeAgentPrompt outputContract "planner"
    // via Paseo --output-schema / Codex --output-schema / MCP inputSchema:
    // src/agents/waveExecutor.ts:201,242, src/operations/change.ts:879,
    // src/agents/reviewLifecycle.ts:574). Wire strict form requires every key
    // present (Zod-optional scalars nullable, arrays required-present); the
    // deterministic zod gate stays authoritative for legacy payloads that omit
    // optional keys (no payload-narrowing regression).
    const schema = wireSchema("planner");
    const strictMinimal = {
      workUnits: [workUnit()],
      affectedAreas: [],
      reviewDimensions: [],
      validationRequirements: [],
      outOfScopeImprovements: [],
      filesNeededOutsideScope: [],
      formalizationNeed: null,
      formalizationReason: null,
      formalizationEvidenceRefs: [],
    };
    expect(wireValid(schema, strictMinimal)).toBe(true);
    // Legacy shape without optional keys still passes zod (authoritative).
    const legacyMinimal = { workUnits: [workUnit()], affectedAreas: [], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] };
    expect(validateAgentOutput("planner", legacyMinimal).ok).toBe(true);
    const full = {
      ...strictMinimal,
      filesNeededOutsideScope: [{ path: "src/a.ts", reason: "needs protected file" }],
      formalizationNeed: "RECOMMENDED" as const,
      formalizationReason: "OTHER" as const,
      formalizationEvidenceRefs: ["ev"],
    };
    expect(wireValid(schema, full)).toBe(true);
    expect(validateAgentOutput("planner", full).ok).toBe(true);
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

describe("P1b nullable round-trip regressions (reviewer exact cases)", () => {
  it("helper genuinely validates null against enum (non-vacuous)", () => {
    // Pre-repair helper returned true for ANY null with type including
    // "null", ignoring enum. A strict-legal nullable enum must include null.
    expect(wireValid({ type: ["string", "null"], enum: ["NONE", "RECOMMENDED", "REQUIRED"] }, null)).toBe(false);
    expect(wireValid({ type: ["string", "null"], enum: ["NONE", "RECOMMENDED", "REQUIRED", null] }, null)).toBe(true);
    expect(wireValid({ type: ["string", "null"], enum: ["NONE", "RECOMMENDED", "REQUIRED", null] }, "BOGUS")).toBe(false);
    expect(wireValid({ type: ["string", "null"], enum: ["NONE", "RECOMMENDED", "REQUIRED", null] }, "NONE")).toBe(true);
    expect(wireValid({ type: ["string", "null"] }, null)).toBe(true);
    expect(wireValid({ type: "string" }, null)).toBe(false);
  });

  it("planner wire nullable enums include null (formalizationNeed/Reason)", () => {
    const schema = wireSchema("planner");
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["formalizationNeed"]!["enum"]).toContain(null);
    expect(props["formalizationReason"]!["enum"]).toContain(null);
  });

  it("planner null round-trips both directions (wire <-> zod)", () => {
    const schema = wireSchema("planner");
    const strictNulls = {
      workUnits: [workUnit()],
      affectedAreas: [],
      reviewDimensions: [],
      validationRequirements: [],
      outOfScopeImprovements: [],
      filesNeededOutsideScope: [],
      formalizationNeed: null,
      formalizationReason: null,
      formalizationEvidenceRefs: [],
    };
    // wire -> zod: strict wire payload with explicit nulls passes zod.
    expect(wireValid(schema, strictNulls)).toBe(true);
    expect(validateAgentOutput("planner", strictNulls).ok).toBe(true);
    // zod -> wire: legacy omitted-keys payload passes zod (wire needs nulls).
    expect(validateAgentOutput("planner", { workUnits: [workUnit()] }).ok).toBe(true);
    // enum values still enforced on both layers.
    const bad = { ...strictNulls, formalizationNeed: "BOGUS" };
    expect(wireValid(schema, bad)).toBe(false);
    expect(validateAgentOutput("planner", bad).ok).toBe(false);
  });

  it("spec BLOCKED bare null-artifacts round-trips both directions", () => {
    const schema = wireSchema("spec-authoring");
    const base = {
      change: "change-test-1",
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [],
      validationReady: false,
    };
    const blockedBare = { ...base, status: "BLOCKED", artifacts: { proposal: null, design: null, tasks: null, specs: [] } };
    // wire passes AND zod passes (previously wire-pass/zod-fail).
    expect(wireValid(schema, blockedBare)).toBe(true);
    expect(validateAgentOutput("spec-authoring", blockedBare).ok).toBe(true);
    // omitted-keys legacy shape still passes zod (no narrowing).
    const blockedOmitted = { ...base, status: "BLOCKED", artifacts: { specs: [] }, validationReady: false };
    expect(validateAgentOutput("spec-authoring", blockedOmitted).ok).toBe(true);
    // READY with nulls still rejected on both layers.
    const readyNull = { ...base, status: "READY", artifacts: { proposal: null, design: null, tasks: null, specs: [] }, validationReady: true };
    expect(wireValid(schema, readyNull)).toBe(false);
    expect(validateAgentOutput("spec-authoring", readyNull).ok).toBe(false);
  });

  it("finding exceptionType null round-trips both directions", () => {
    const schema = wireSchema("reviewer");
    const withNull = { verdict: "PASS", findings: [wireFinding("medium")], finalizationSafety: "SAFE", confidence: null, followUp: [] };
    expect(wireValid(schema, withNull)).toBe(true);
    expect(validateAgentOutput("reviewer", { verdict: "PASS", findings: [zodFinding("medium")], finalizationSafety: "SAFE", followUp: [] }).ok).toBe(true);
    // finding with explicit null exceptionType passes zod too.
    expect(validateAgentOutput("reviewer", { verdict: "FAIL", findings: [{ ...zodFinding(), exceptionType: null }], finalizationSafety: "BLOCKED", followUp: [] }).ok).toBe(true);
  });

  it("Paseo strict projection is root-anyOf-free yet Zod receipt still rejects gate violations", () => {
    // R4 (P1): Paseo submission paths reach OpenAI strict:true via
    // --output-schema, so they submit outputStrictChannelSchema (root anyOf
    // dropped). The deterministic Zod validator remains authoritative on
    // receipt via existing repair turns — a gate-violating payload passes the
    // projection wire but fails Zod.
    const projected = outputStrictChannelSchema("reviewer") as Record<string, unknown>;
    expect(projected).toBeDefined();
    expect(projected).not.toHaveProperty("anyOf");
    // Gate-violating payload: FAIL with zero findings.
    const violating = { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", confidence: null, followUp: [] };
    expect(wireValid(projected, violating)).toBe(true);
    expect(validateAgentOutput("reviewer", { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] }).ok).toBe(false);
    // Full gated schema still rejects the same payload on the wire (MCP +
    // provenance digest keep the full schema — justified, untouched).
    expect(wireValid(wireSchema("reviewer"), violating)).toBe(false);
  });
});

describe("P2 null-to-undefined preprocess (planner formalization + finding exceptionType)", () => {
  it("infer types stay string|undefined (no null widening)", () => {
    const planner = plannerOutputSchema.parse({ workUnits: [workUnit()] });
    const need: string | undefined = planner.formalizationNeed;
    const reason: string | undefined = planner.formalizationReason;
    expect(need).toBeUndefined();
    expect(reason).toBeUndefined();
    const parsed = findingSchema.parse({ ...zodFinding(), exceptionType: null });
    const ex: string | undefined = parsed.exceptionType;
    expect(ex).toBeUndefined();
    // @ts-expect-error null must not be assignable after preprocess normalization
    const mustFail: null = planner.formalizationNeed;
    expect(mustFail).toBeUndefined();
  });

  it("runtime round-trips: null, omitted, and valued all validate", () => {
    const base = { workUnits: [workUnit()] };
    expect(plannerOutputSchema.safeParse({ ...base, formalizationNeed: null, formalizationReason: null }).success).toBe(true);
    expect(plannerOutputSchema.safeParse(base).success).toBe(true);
    expect(plannerOutputSchema.safeParse({ ...base, formalizationNeed: "RECOMMENDED", formalizationReason: "OTHER" }).success).toBe(true);
    expect(plannerOutputSchema.safeParse({ ...base, formalizationNeed: "BOGUS" }).success).toBe(false);
    const parsedNull = plannerOutputSchema.parse({ ...base, formalizationNeed: null });
    expect(parsedNull.formalizationNeed).toBeUndefined();
    expect(findingSchema.safeParse({ ...zodFinding(), exceptionType: null }).success).toBe(true);
    expect(findingSchema.safeParse(zodFinding()).success).toBe(true);
    expect(findingSchema.safeParse({ ...zodFinding(), exceptionType: "IMPLEMENTATION_DEFECT" }).success).toBe(true);
    expect(findingSchema.safeParse({ ...zodFinding(), exceptionType: "BOGUS" }).success).toBe(false);
  });
});
