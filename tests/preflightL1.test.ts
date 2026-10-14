import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  EXPLORER_KNOWN_EVIDENCE_ARRAYS,
  LANE_COMMAND_MISMATCH_MARKER,
  checkAdapterCoverage,
  checkDistBindsSource,
  checkLaneCommandBinding,
  checkLaneCommandBindingWithBehavioral,
  checkMcpFailClosed,
  checkMcpRefsConfigured,
  checkNonparticipantConstraints,
  checkPermissionCeiling,
  checkSkillRefsResolve,
  checkSkillRoleFit,
  checkSpecializationsClosed,
  checkSkillRootsExist,
  checkWireParity,
  evaluateAll,
  parseRolesProfiles,
  parseSkillSeed,
  parseVerifyCommandParam,
  probeLaneCommandBindingBehavioral,
  probeWireLiveness,
  resolveConsumerTopology,
} from "../scripts/preflightL1.mjs";

// Mechanism classification: DETERMINISTIC. Every fixture below is an
// in-memory literal; assertions compare exact check ids and evidence.
// No network, no model calls, no filesystem writes (except read-only
// parser lock-in tests against the checkout's own source). Behavioral
// probe tests inject fake verifier/digest helpers (pure doubles); the
// real-tree behavioral run is validated manually via
// `node scripts/preflightL1.mjs`, not asserted here.

function compliantRoles(): Record<string, any> {
  const tool = (required: string[], optional: string[] = []) => ({
    required,
    optional,
    forbidden: [],
    unresolved: [],
  });
  return {
    "Lead/Director": {
      role: "Lead/Director",
      authority: { canRead: true, canWrite: false, canExecute: false },
      toolPack: tool(["repository-read", "context-read", "task-coordination"], ["validation-read"]),
      maxCapabilities: ["read", "plan", "review", "supervise", "delegate"],
      specializations: ["cross-cutting"],
      delegationAllowed: true,
    },
    "Operation Supervisor": {
      role: "Operation Supervisor",
      authority: { canRead: true, canWrite: false, canExecute: true },
      toolPack: tool(
        ["repository-read", "context-read", "task-coordination"],
        ["validation-read", "command-execute"],
      ),
      maxCapabilities: ["read", "supervise", "validate", "delegate", "execute"],
      specializations: ["cross-cutting"],
      delegationAllowed: true,
    },
    Planner: {
      role: "Planner",
      authority: { canRead: true, canWrite: false, canExecute: false },
      toolPack: tool(["repository-read", "context-read", "task-coordination"], ["repository-map"]),
      maxCapabilities: ["read", "plan", "validate"],
      specializations: ["cross-cutting"],
      delegationAllowed: false,
    },
    Reviewer: {
      role: "Reviewer",
      authority: { canRead: true, canWrite: false, canExecute: false },
      toolPack: tool(["repository-read", "context-read"], ["validation-read"]),
      maxCapabilities: ["read", "review", "validate", "research"],
      specializations: ["cross-cutting", "typescript-node"],
      delegationAllowed: false,
    },
    "Spec Manager": {
      role: "Spec Manager",
      authority: { canRead: true, canWrite: false, canExecute: false },
      toolPack: tool(["repository-read", "context-read", "spec-authoring"], ["validation-read"]),
      maxCapabilities: ["read", "specify", "validate"],
      specializations: ["cross-cutting"],
      delegationAllowed: false,
    },
  };
}

function compliantAgents(): Record<string, any> {
  return {
    lead: {
      role: "Lead/Director",
      skills: ["human-exception-handling"],
      mcps: [],
      permissions: { read: "allow", write: "deny", shell: "deny", delegate: "allow" },
    },
    supervisor: {
      role: "Operation Supervisor",
      skills: ["operation-coordination"],
      mcps: ["context7"],
      permissions: { read: "allow", write: "deny", shell: "allow", delegate: "allow" },
    },
    planner: {
      role: "Planner",
      skills: ["work-decomposition"],
      permissions: { read: "allow", write: "deny", shell: "deny", delegate: "deny" },
    },
    reviewer: {
      role: "Reviewer",
      specializations: ["cross-cutting"],
      skills: ["independent-review"],
      permissions: { read: "allow", write: "deny", shell: "deny" },
    },
  };
}

function compliantSeed(): Record<string, any> {
  return {
    "human-exception-handling": { id: "human-exception-handling", roles: ["Lead/Director"] },
    "operation-coordination": { id: "operation-coordination", roles: ["Operation Supervisor"] },
    "work-decomposition": { id: "work-decomposition", roles: ["Planner"] },
    "independent-review": { id: "independent-review", roles: ["Reviewer"] },
    "acceptance-traceability": { id: "acceptance-traceability", roles: ["Spec Manager"] },
    "cross-cutting": { id: "cross-cutting", roles: null },
  };
}

const COMPLIANT_PERMISSIONS_SOURCE = `
export function buildOpenCodeRuntimeConfig(selection, config) {
  const tools = {};
  const configured = config?.mcp?.servers ?? {};
  for (const [name, server] of Object.entries(configured)) {
    const selected = selection.mcps.includes(name) && server.enabled !== false;
    tools[name + "_*"] = selected;
    if (selected) mcp[name] = toOpenCodeMcp(server);
  }
  // Deny-by-default: selections absent from config are never granted.
  for (const name of selection.mcps) {
    if (!configured[name]) throw new Error("UNCONFIGURED_MCP:" + name);
  }
  return { tools };
}
`;

// Object-graph fixtures (loaded-schema DATA, never source text). The
// compliant bundle satisfies every exact path+constraint binding; the
// violating bundles below each break exactly one binding class the old
// text-scan heuristics accepted.
function compliantSchemas(): Record<string, any> {
  return {
    planner: {
      type: "object",
      required: ["workUnits", "affectedAreas", "reviewDimensions", "validationRequirements", "outOfScopeImprovements"],
      properties: { workUnits: { type: "array", minItems: 1, items: { type: "object" } } },
    },
    explorer: {
      type: "object",
      properties: {
        summary: { type: "string" },
        relevantFiles: { type: "array", items: { type: "object" } },
        findings: { type: "array", items: { type: "object" } },
        moduleBoundaries: { type: "array", items: { type: "string" } },
        tests: { type: "array", items: { type: "string" } },
        dependencies: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
      },
      anyOf: EXPLORER_KNOWN_EVIDENCE_ARRAYS.map((field) => ({
        required: [field],
        properties: { [field]: { type: "array", minItems: 1 } },
      })),
    },
    "spec-authoring": {
      type: "object",
      required: ["change", "status", "artifacts", "requirements", "unresolvedDecisions", "decisionRequests", "validationReady"],
      properties: {
        status: { enum: ["READY", "BLOCKED"] },
        artifacts: {
          type: "object",
          required: ["specs", "proposal", "tasks"],
          properties: {
            proposal: { type: "string", minLength: 1 },
            tasks: { type: "string", minLength: 1 },
            specs: { type: "array" },
          },
        },
      },
    },
    reviewer: {
      type: "object",
      required: ["verdict", "findings", "finalizationSafety", "followUp"],
      properties: {
        verdict: { type: "string", enum: ["PASS", "FAIL", "PASS_WITH_WARNINGS"] },
        findings: { type: "array", items: { type: "object" } },
        finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] },
        followUp: { type: "array" },
      },
      anyOf: [{ required: ["verdict", "findings"], properties: { verdict: { const: "FAIL" }, findings: { type: "array", minItems: 1 } } }],
    },
    supervisor: {
      type: "object",
      required: ["summary", "consolidatedFindings", "sourceFindingIds", "conflicts", "missingEvidence", "unresolved", "finalizationSafety"],
      properties: {
        summary: { type: "string" },
        unresolved: { type: "array", items: { type: "string" } },
        missingEvidence: { type: "array", items: { type: "string" } },
        finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] },
      },
      anyOf: [
        {
          required: ["finalizationSafety", "unresolved", "missingEvidence"],
          properties: {
            finalizationSafety: { const: "SAFE" },
            unresolved: { type: "array", maxItems: 0 },
            missingEvidence: { type: "array", maxItems: 0 },
          },
        },
      ],
    },
  };
}

const COMPLIANT_LANE_SOURCE = `
export async function verifyProviderLaneEvidenceV1(root, config, evidence, expected, expectedCommand) {
  if (evidence.commandDigest !== sha256(expectedCommand)) throw new Error("STALE_COMMAND");
  if (evidence.candidate.revision !== expected.revision) throw new Error("STALE");
  return { ok: true };
}
`;

const COMPLIANT_CALL_SITES = [
  {
    file: "src/core/run.ts:1",
    line: 1,
    snippet: "await verifyProviderLaneEvidenceV1({ root, command: action.command, candidate })",
  },
];

const COMPLIANT_CATALOG_SOURCE = `
export const validationCapabilityValues = [
  "unit-test",
  "command",
] as const;
`;

const COMPLIANT_REGISTRY_SOURCE = `
function capabilityForAdapter(adapter: string): string | undefined {
  if (adapter === "command") return "command";
  if (adapter === "test-execution") return "unit-test";
  return undefined;
}
function capabilityAdapter(capability: string): string | undefined {
  const mapping: Record<string, string> = {
    "unit-test": "test-execution",
    "command": "command",
  };
  return mapping[capability];
}
`;

// Deterministic test doubles for the behavioral probe (no build needed).
function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]));
  }
  return value;
}

const testDigestHelpers = {
  sha256Utf8: (text: string) => createHash("sha256").update(String(text), "utf8").digest("hex"),
  sha256Canonical: (value: unknown) =>
    createHash("sha256").update(JSON.stringify(sortKeysDeep(value)), "utf8").digest("hex"),
  providerLaneEvidenceDirectory: (root: string, _config: unknown, lane: string, candidate: any) =>
    path.join(
      root,
      ".harness/evidence",
      String(lane).toLowerCase(),
      `${candidate.candidateId}-r${candidate.revision}-${String(candidate.identityDigest).slice(0, 12)}`,
    ),
};

/** A verifier that CONSUMES its expected-digest parameter (canonical contract). */
async function consumingVerify(_root: string, _config: unknown, evidence: any, _expected: unknown, expectedDigest: unknown) {
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return { ok: false, blockers: [`${LANE_COMMAND_MISMATCH_MARKER}: expected executed-command digest is absent or malformed.`] };
  }
  if (evidence?.commandDigest !== expectedDigest) {
    return { ok: false, blockers: [`${LANE_COMMAND_MISMATCH_MARKER}: binds '${evidence?.commandDigest}' but executed '${expectedDigest}'.`] };
  }
  return { ok: true, blockers: [], evidence };
}

/** A verifier that IGNORES its expected-digest parameter (the current product gap). */
async function ignoringVerify(_root: string, _config: unknown, evidence: any) {
  return { ok: true, blockers: [], evidence };
}

function compliantFixture(): any {
  return {
    agents: compliantAgents(),
    skillRoots: ["skills"],
    routing: [{ id: "r1", select: { role: "Reviewer", specializations: ["cross-cutting"] } }],
    runtimes: {},
    models: {},
    roles: compliantRoles(),
    skillSeed: compliantSeed(),
    permissionsSource: COMPLIANT_PERMISSIONS_SOURCE,
    schemas: compliantSchemas(),
    wireLive: undefined,
    laneSource: COMPLIANT_LANE_SOURCE,
    callSites: COMPLIANT_CALL_SITES,
    laneBehavioral: { verifyFn: consumingVerify, helpers: testDigestHelpers, root: "/probe-root", config: {} },
    catalogSource: COMPLIANT_CATALOG_SOURCE,
    registrySource: COMPLIANT_REGISTRY_SOURCE,
    dirExists: () => true,
    fileExists: () => true,
    mcpConfigured: { context7: { enabled: true } },
  };
}

function checkById(checks: any[], id: string) {
  const found = checks.find((c) => c.id === id);
  expect(found, `check ${id} present`).toBeDefined();
  return found;
}

describe("preflight L1 gate", () => {
  it("PASSES every check on a crafted compliant fixture", async () => {
    const checks = await evaluateAll(compliantFixture());
    expect(checks).toHaveLength(11);
    for (const check of checks) {
      expect(check.status, `${check.id}: ${JSON.stringify(check.evidence)}`).toBe("PASS");
    }
  });

  it("(a) FAILS L1-A1-PERMISSION-CEILING when shell is granted above the toolPack ceiling", () => {
    const fx = compliantFixture();
    fx.roles["Operation Supervisor"].toolPack.optional = ["validation-read"]; // no command-execute
    const check = checkPermissionCeiling(fx.agents, fx.roles);
    expect(check.id).toBe("L1-A1-PERMISSION-CEILING");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.violations).toHaveLength(1);
    expect(check.evidence.violations[0]).toMatchObject({ agent: "supervisor", permission: "shell" });
  });

  it("(a) FAILS L1-A2-SKILL-ROLE-FIT when a planner takes a Spec-Manager seed skill", () => {
    const fx = compliantFixture();
    fx.agents.planner.skills = ["acceptance-traceability"];
    const check = checkSkillRoleFit(fx.agents, fx.skillSeed);
    expect(check.id).toBe("L1-A2-SKILL-ROLE-FIT");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.violations).toMatchObject([
      { agent: "planner", skill: "acceptance-traceability" },
    ]);
  });

  it("(b) FAILS L1-B-SPECIALIZATION-CLOSED on unknown agent and routing specializations", () => {
    const fx = compliantFixture();
    fx.agents.reviewer.specializations = ["high-assurance"];
    fx.routing = [{ id: "high-risk", review: [{ role: "Reviewer", specializations: ["high-assurance"] }] }];
    const check = checkSpecializationsClosed(fx.agents, fx.routing, fx.roles);
    expect(check.id).toBe("L1-B-SPECIALIZATION-CLOSED");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.violations).toHaveLength(2);
    expect(check.evidence.violations.map((v: any) => v.scope).sort()).toEqual(["agent", "routing"]);
  });

  it("(c) FAILS L1-C1/C2 when skill roots and SKILL.md references do not resolve", () => {
    const fx = compliantFixture();
    expect(checkSkillRootsExist(fx.skillRoots, () => false).status).toBe("FAIL");
    expect(checkSkillRootsExist(fx.skillRoots, () => false).id).toBe("L1-C1-SKILLROOT-EXISTS");
    const refs = checkSkillRefsResolve(fx.agents, fx.skillRoots, () => false);
    expect(refs.id).toBe("L1-C2-SKILL-REF-RESOLVES");
    expect(refs.status).toBe("FAIL");
    expect(refs.evidence.violations.length).toBeGreaterThan(0);
  });

  it("(d) FAILS L1-D1 on the unconfigured-MCP fail-open shape and L1-D2 on unconfigured refs", () => {
    const failOpen = `
for (const name of selection.mcps) {
  if (!configured[name]) tools[\`\${name}_*\`] = true;
}`;
    const d1 = checkMcpFailClosed(failOpen);
    expect(d1.id).toBe("L1-D1-MCP-FAIL-CLOSED");
    expect(d1.status).toBe("FAIL");
    expect(checkMcpFailClosed(COMPLIANT_PERMISSIONS_SOURCE).status).toBe("PASS");
    const fx = compliantFixture();
    fx.agents.supervisor.mcps = ["ghost-mcp"];
    const d2 = checkMcpRefsConfigured(fx.agents, fx.mcpConfigured);
    expect(d2.id).toBe("L1-D2-MCP-REF-CONFIGURED");
    expect(d2.status).toBe("FAIL");
    expect(d2.evidence.violations).toMatchObject([{ agent: "supervisor", mcp: "ghost-mcp" }]);
  });

  it("(e) FAILS L1-E-WIRE-PARITY listing each missing gate", () => {
    const bare = {
      planner: { type: "object", properties: { workUnits: { type: "array", items: {} } } },
      explorer: {
        type: "object",
        properties: {
          relevantFiles: { type: "array" },
          findings: { type: "array" },
          moduleBoundaries: { type: "array" },
          tests: { type: "array" },
          dependencies: { type: "array" },
          risks: { type: "array" },
          openQuestions: { type: "array" },
        },
      },
      "spec-authoring": {
        type: "object",
        properties: {
          artifacts: {
            type: "object",
            required: ["specs"],
            properties: { proposal: { type: "string" }, tasks: { type: "string" } },
          },
        },
      },
      reviewer: {
        type: "object",
        properties: {
          verdict: { enum: ["PASS", "FAIL"] },
          findings: { type: "array" },
          finalizationSafety: { enum: ["SAFE"] },
        },
      },
      supervisor: {
        type: "object",
        properties: {
          finalizationSafety: { enum: ["SAFE"] },
          unresolved: { type: "array" },
          missingEvidence: { type: "array" },
        },
      },
    };
    const check = checkWireParity(bare, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.distAvailable).toBe(true);
    expect(check.evidence.missing.sort()).toEqual([
      "explorer-nonvacuous",
      "planner-nonvacuous",
      "reviewer-coherence",
      "spec-ready-artifacts",
      "supervisor-coherence",
    ]);
    expect(checkWireParity(compliantSchemas(), undefined).status).toBe("PASS");
  });

  it("(f) FAILS L1-F-LANE-COMMAND-BINDING without a commandDigest comparison or command threading", () => {
    const bareLane = `
export async function verifyProviderLaneEvidenceV1(root, config, evidence, expected) {
  if (evidence.candidate.revision !== expected.revision) throw new Error("STALE");
  return { ok: true };
}`;
    const check = checkLaneCommandBinding(bareLane, [
      { file: "src/core/run.ts:1", line: 1, snippet: "await verifyProviderLaneEvidenceV1({ root, candidate })" },
    ]);
    expect(check.id).toBe("L1-F-LANE-COMMAND-BINDING");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.verifyComparesCommandDigest).toBe(false);
    expect(check.evidence.consumerCallSitesMissingCommand).toHaveLength(1);
  });

  it("(g) FAILS L1-G-ADAPTER-COVERAGE listing each unmapped catalog kind", () => {
    const catalog = `
export const validationCapabilityValues = [
  "unit-test",
  "architecture",
  "policy",
  "command",
] as const;
`;
    const registry = `
function capabilityForAdapter(adapter: string): string | undefined {
  if (adapter === "test-execution") return "unit-test";
  return undefined;
}
function capabilityAdapter(capability: string): string | undefined {
  const mapping: Record<string, string> = {
    "unit-test": "test-execution",
  };
  return mapping[capability];
}
`;
    const check = checkAdapterCoverage(catalog, registry);
    expect(check.id).toBe("L1-G-ADAPTER-COVERAGE");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.unmapped).toEqual(["architecture", "policy", "command"]);
  });

  it("HIGH-1 FAILS L1-A1 when review/validate are granted above maxCapabilities (old token-check would PASS)", () => {
    const fx = compliantFixture();
    // Planner fixture maxCapabilities ["read","plan","validate"]: no review.
    fx.agents.planner.permissions = { ...fx.agents.planner.permissions, review: "allow" };
    // Lead fixture maxCapabilities lack validate: ["read","plan","review","supervise","delegate"].
    fx.agents.lead.permissions = { ...fx.agents.lead.permissions, validate: "allow" };
    const check = checkPermissionCeiling(fx.agents, fx.roles);
    expect(check.id).toBe("L1-A1-PERMISSION-CEILING");
    expect(check.status).toBe("FAIL");
    const byPerm = Object.fromEntries(check.evidence.violations.map((v: any) => [`${v.agent}:${v.permission}`, v]));
    expect(byPerm["planner:review"]).toMatchObject({ agent: "planner", permission: "review", granted: "allow" });
    expect(byPerm["lead:validate"]).toMatchObject({ agent: "lead", permission: "validate", granted: "allow" });
    // ask is also a grant.
    const fx2 = compliantFixture();
    fx2.agents.planner.permissions = { ...fx2.agents.planner.permissions, review: "ask" };
    expect(checkPermissionCeiling(fx2.agents, fx2.roles).status).toBe("FAIL");
    // deny/absent is no grant.
    const fx3 = compliantFixture();
    fx3.agents.planner.permissions = { ...fx3.agents.planner.permissions, review: "deny" };
    expect(checkPermissionCeiling(fx3.agents, fx3.roles).status).toBe("PASS");
  });

  it("HIGH-2 FAILS L1-E on zero/absent-cardinality shapes the old token-checks would PASS", () => {
    const minZero = {
      planner: { type: "object", properties: { workUnits: { type: "array", minItems: 0, items: {} } } },
      explorer: {
        type: "object",
        properties: { relevantFiles: { type: "array", minItems: 0 } },
        anyOf: [{ required: ["findings"] }],
      },
      "spec-authoring": {
        type: "object",
        properties: {
          artifacts: {
            type: "object",
            required: ["specs", "proposal", "tasks"],
            properties: { proposal: { type: "string" }, tasks: { type: "string" } },
          },
        },
      },
      reviewer: {
        type: "object",
        properties: {
          verdict: { enum: ["PASS", "FAIL"] },
          findings: { type: "array" },
          finalizationSafety: { enum: ["SAFE"] },
        },
        anyOf: [{ required: ["findings"] }],
      },
      supervisor: {
        type: "object",
        properties: {
          finalizationSafety: { enum: ["SAFE"] },
          unresolved: { type: "array" },
          missingEvidence: { type: "array" },
        },
        allOf: [{ required: ["unresolved"] }],
      },
    };
    const check = checkWireParity(minZero, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    // Every gate must still be listed missing: 0/absent cardinality,
    // required-without-minLength, anyOf-without-same-branch-binding and
    // allOf-without-emptiness all FAIL the object-graph test.
    expect(check.evidence.missing.sort()).toEqual([
      "explorer-nonvacuous",
      "planner-nonvacuous",
      "reviewer-coherence",
      "spec-ready-artifacts",
      "supervisor-coherence",
    ]);
    // Old token shapes are present: planner minItems key exists (even 0),
    // explorer/reviewer anyOf present, spec required proposal+tasks present.
    expect("minItems" in (minZero.planner.properties as any).workUnits).toBe(true);
    expect("anyOf" in minZero.explorer).toBe(true);
  });

  it("HIGH-3 FAILS L1-F on unrelated-equality verifiers and snippet-proximity call sites the old check would PASS", () => {
    const unrelatedLane = `
export async function verifyProviderLaneEvidenceV1(root, config, evidence, expected, expectedCommand) {
  // commandDigest recorded below; expectedCommand is the verified command value.
  const digest = evidence.commandDigest;
  if (evidence.candidate.revision !== expected.revision) throw new Error("STALE");
  return { ok: true };
}`;
    // Old co-occurrence shape: commandDigest + expected + === all present.
    expect(unrelatedLane.includes("commandDigest")).toBe(true);
    expect(/expected/i.test(unrelatedLane)).toBe(true);
    expect(/(===|!==)/.test(unrelatedLane)).toBe(true);
    const unrelated = checkLaneCommandBinding(unrelatedLane, [
      { file: "src/core/run.ts:1", line: 1, snippet: "await verifyProviderLaneEvidenceV1({ root, command: action.command, candidate })" },
    ]);
    expect(unrelated.evidence.verifyComparesCommandDigest).toBe(false);
    expect(unrelated.status).toBe("FAIL");
    // Snippet proximity: `command:` appears outside the call's own parens.
    const nearbySnippet = [
      "await requireProviderLaneEvidenceForActionV1({",
      "  root: input.root,",
      "  candidate: input.report.candidate!,",
      "})",
      "const config = { command: action.command };",
    ].join("\n");
    expect(/\bcommand\s*:/.test(nearbySnippet)).toBe(true);
    const proximity = checkLaneCommandBinding(COMPLIANT_LANE_SOURCE, [
      { file: "src/core/run.ts:9", line: 9, snippet: nearbySnippet },
    ]);
    expect(proximity.status).toBe("FAIL");
    expect(proximity.evidence.consumerCallSitesMissingCommand).toHaveLength(1);
    // The compliant same-expression + in-parens binding still passes.
    expect(parseVerifyCommandParam(COMPLIANT_LANE_SOURCE).param).toBe("expectedCommand");
    expect(checkLaneCommandBinding(COMPLIANT_LANE_SOURCE, COMPLIANT_CALL_SITES).status).toBe("PASS");
  });

  it("MEDIUM PASSES L1-A3 for the all-deny assessor and skips it in L1-A1/L1-B", async () => {
    const assessor = {
      role: "Semantic Assessor",
      skills: [],
      mcps: [],
      permissions: {
        read: "deny",
        write: "deny",
        shell: "deny",
        network: "deny",
        delegate: "deny",
        review: "deny",
        validate: "deny",
        gitWrite: "deny",
      },
    };
    const fx = compliantFixture();
    (fx.agents as any)["semantic-assessor"] = assessor;
    expect(checkPermissionCeiling(fx.agents, fx.roles).status).toBe("PASS");
    expect(checkSpecializationsClosed(fx.agents, fx.routing, fx.roles).status).toBe("PASS");
    const nonparticipant = checkNonparticipantConstraints(fx.agents);
    expect(nonparticipant.id).toBe("L1-A3-NONPARTICIPANT");
    expect(nonparticipant.status).toBe("PASS");
    expect((await evaluateAll(fx)).find((c) => c.id === "L1-A3-NONPARTICIPANT")?.status).toBe("PASS");
    // Violating assessors fail the dedicated check: opened permission, skill, MCP, args.
    const bad = compliantFixture();
    (bad.agents as any)["semantic-assessor"] = {
      ...assessor,
      skills: ["operation-coordination"],
      mcps: ["context7"],
      args: ["--debug"],
      permissions: { ...assessor.permissions, read: "allow" },
    };
    const badCheck = checkNonparticipantConstraints(bad.agents);
    expect(badCheck.status).toBe("FAIL");
    expect(badCheck.evidence.violations.length).toBeGreaterThanOrEqual(4);
    // But the violating assessor is still not reported as unknown-profile under A1.
    expect(
      checkPermissionCeiling(bad.agents, bad.roles).evidence.violations.some((v: any) => v.reason.includes("unknown role")),
    ).toBe(false);
  });

  it("locks the real-tree parsers to the verified campaign evidence", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const { roles } = parseRolesProfiles(fs.readFileSync(path.join(repoRoot, "src/participants/roles.ts"), "utf8"));
    // Post preset-ceiling coherence (origin/main): Operation Supervisor lost
    // command execution (canExecute false, command-execute forbidden).
    expect(roles["Operation Supervisor"].authority.canExecute).toBe(false);
    expect(roles["Operation Supervisor"].toolPack.required.concat(roles["Operation Supervisor"].toolPack.optional)).not.toContain(
      "command-execute",
    );
    // Post preset-ceiling coherence: high-assurance is a canonical Reviewer
    // specialization (held by high-assurance-reviewer), not an unknown one.
    expect(roles["Reviewer"].specializations).toContain("high-assurance");
    const { seed } = parseSkillSeed(fs.readFileSync(path.join(repoRoot, "src/participants/skills.ts"), "utf8"));
    expect(seed["acceptance-traceability"].roles).toEqual(["Spec Manager", "Reviewer"]);
    expect(seed["operation-coordination"].roles).toEqual(["Operation Supervisor"]);
  });

  it("HIGH-E FAILS L1-E when minItems/minLength lack a type (old helpers passed untyped constraints)", () => {
    // Old fieldHasMinItemsGE1 passed ANY `workUnits:` object with minItems>=1,
    // even `{ minItems: 1 }` with no type:array. The object graph requires the
    // exact path to carry the exact typed constraint.
    const untyped = compliantSchemas();
    (untyped.planner.properties as any).workUnits = { minItems: 1, items: { type: "object" } };
    const plannerCheck = checkWireParity(untyped, undefined);
    expect(plannerCheck.status).toBe("FAIL");
    expect(plannerCheck.evidence.missing).toEqual(["planner-nonvacuous"]);
    const untypedSpec = compliantSchemas();
    (untypedSpec["spec-authoring"].properties as any).artifacts = {
      type: "object",
      required: ["specs", "proposal", "tasks"],
      properties: { proposal: { minLength: 1 }, tasks: { minLength: 1 } },
    };
    const specCheck = checkWireParity(untypedSpec, undefined);
    expect(specCheck.status).toBe("FAIL");
    expect(specCheck.evidence.missing).toEqual(["spec-ready-artifacts"]);
  });

  it("HIGH-E FAILS L1-E on unrelated explorer disjunctions (old fallback passed any anyOf+minItems)", () => {
    // Old explorer fallback passed when the block merely contained anyOf,
    // minItems>=1 anywhere, and an evidence field name anywhere. An anyOf
    // over unrelated paths with the cardinality bound elsewhere is a vacuous
    // escape hatch: payloads take the unrelated branch with all evidence
    // arrays empty.
    const unrelated = compliantSchemas();
    (unrelated.explorer as any).anyOf = [
      { properties: { summary: { type: "string", minLength: 1 } } },
      { properties: { notes: { type: "string" } } },
    ];
    (unrelated.explorer.properties as any).extra = { type: "array", minItems: 1 };
    const check = checkWireParity(unrelated, undefined);
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["explorer-nonvacuous"]);
  });

  it("HIGH-E FAILS L1-E on uncoupled reviewer/supervisor co-occurrence (old tests passed spread tokens)", () => {
    // Old reviewer/supervisor tests passed when anyOf/allOf/oneOf/if, the
    // FAIL/SAFE literal, the findings/emptiness constraint and the safety
    // field merely co-occurred anywhere. The object graph requires the SAME
    // branch object to bind them.
    const spread = compliantSchemas();
    (spread.reviewer as any).anyOf = [
      { properties: { verdict: { enum: ["FAIL"] } } },
      { properties: { findings: { type: "array", minItems: 1 } } },
    ];
    const reviewerCheck = checkWireParity(spread, undefined);
    expect(reviewerCheck.status).toBe("FAIL");
    expect(reviewerCheck.evidence.missing).toContain("reviewer-coherence");
    const spreadSup = compliantSchemas();
    (spreadSup.supervisor as any).anyOf = [
      { properties: { finalizationSafety: { const: "SAFE" }, other: { type: "array", maxItems: 0 } } },
      { properties: { unresolved: { type: "array" }, missingEvidence: { type: "array" } } },
    ];
    const supervisorCheck = checkWireParity(spreadSup, undefined);
    expect(supervisorCheck.status).toBe("FAIL");
    expect(supervisorCheck.evidence.missing).toContain("supervisor-coherence");
  });

  it("HIGH-E reports stale (never failed) gates whose zod validator accepts the violating payload", () => {
    const alwaysOk = () => ({ ok: true, issues: [] });
    const live = probeWireLiveness(alwaysOk);
    expect(Object.values(live).every((value) => value === false)).toBe(true);
    const bare = {
      planner: { type: "object", properties: {} },
      explorer: { type: "object", properties: {} },
      "spec-authoring": { type: "object", properties: {} },
      reviewer: { type: "object", properties: {} },
      supervisor: { type: "object", properties: {} },
    };
    const check = checkWireParity(bare, live);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("PASS");
    expect(check.evidence.missing).toEqual([]);
    expect(check.evidence.stale.sort()).toEqual([
      "explorer-nonvacuous",
      "planner-nonvacuous",
      "reviewer-coherence",
      "spec-ready-artifacts",
      "supervisor-coherence",
    ]);
  });

  it("HIGH-E FAILS L1-E closed with distAvailable:false when the schema objects are unavailable", () => {
    const check = checkWireParity(undefined, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.distAvailable).toBe(false);
    expect(check.evidence.missing.sort()).toEqual([
      "explorer-nonvacuous",
      "planner-nonvacuous",
      "reviewer-coherence",
      "spec-ready-artifacts",
      "supervisor-coherence",
    ]);
  });

  it("HIGH-F behavioral probe PASSES a consuming verifier and FAILS an ignoring one on the same evidence", async () => {
    const consuming = await probeLaneCommandBindingBehavioral(consumingVerify, testDigestHelpers, "/probe-root", {});
    expect(consuming.mode).toBe("behavioral");
    expect(consuming.passed).toBe(true);
    expect(consuming.cases.matchingDigestOk).toBe(true);
    expect(consuming.cases.differentDigestMismatch).toBe(true);
    expect(consuming.cases.missingMalformedFailClosed).toBe(true);
    const ignoring = await probeLaneCommandBindingBehavioral(ignoringVerify, testDigestHelpers, "/probe-root", {});
    expect(ignoring.passed).toBe(false);
    // The ignoring verifier returns ok for the mismatched and missing cases:
    // consumption is disproven, not merely unscanned.
    expect(ignoring.cases.matchingDigestOk).toBe(true);
    expect(ignoring.cases.differentDigestMismatch).toBe(false);
    expect(ignoring.cases.missingMalformedFailClosed).toBe(false);
    expect((ignoring.cases.caseB as any).ok).toBe(true);
  });

  it("HIGH-F rejects good-looking sources behaviorally when the verifier ignores its parameter", async () => {
    // The compliant-looking source passes the structural fallback, but the
    // behavioral probe with an ignoring verifier fails: the OLD heuristics
    // passed this shape while the product gap (no consumption) remained.
    expect(checkLaneCommandBinding(COMPLIANT_LANE_SOURCE, COMPLIANT_CALL_SITES).status).toBe("PASS");
    const behavioral = await checkLaneCommandBindingWithBehavioral({
      laneSource: COMPLIANT_LANE_SOURCE,
      callSites: COMPLIANT_CALL_SITES,
      behavioral: { verifyFn: ignoringVerify, helpers: testDigestHelpers, root: "/probe-root", config: {} },
    });
    expect(behavioral.id).toBe("L1-F-LANE-COMMAND-BINDING");
    expect(behavioral.status).toBe("FAIL");
    expect(behavioral.evidence.mode).toBe("behavioral");
    expect(behavioral.evidence.probe.passed).toBe(false);
    // And the consuming verifier passes the same source end to end.
    const consuming = await checkLaneCommandBindingWithBehavioral({
      laneSource: COMPLIANT_LANE_SOURCE,
      callSites: COMPLIANT_CALL_SITES,
      behavioral: { verifyFn: consumingVerify, helpers: testDigestHelpers, root: "/probe-root", config: {} },
    });
    expect(consuming.status).toBe("PASS");
    expect(consuming.evidence.probe.passed).toBe(true);
  });

  it("HIGH-F rejects single-line compound comparisons structurally-passing but behaviorally-void", async () => {
    // `commandDigest` compared against an unrelated digest on the SAME line
    // as a separate expectedCommand comparison fools the statement splitter
    // (one ===/!== statement mentions both) without binding them together.
    const compoundLane = `
export async function verifyProviderLaneEvidenceV1(root, config, evidence, expected, expectedCommand) {
  if (evidence.commandDigest !== sha256(seed) && expectedCommand !== "") throw new Error("STALE");
  return { ok: true };
}`;
    const structural = checkLaneCommandBinding(compoundLane, COMPLIANT_CALL_SITES);
    expect(structural.evidence.verifyComparesCommandDigest).toBe(true);
    const behavioral = await checkLaneCommandBindingWithBehavioral({
      laneSource: compoundLane,
      callSites: COMPLIANT_CALL_SITES,
      behavioral: { verifyFn: ignoringVerify, helpers: testDigestHelpers, root: "/probe-root", config: {} },
    });
    expect(behavioral.status).toBe("FAIL");
    expect(behavioral.evidence.probe.passed).toBe(false);
  });

  it("MEDIUM-A3 FAILS on execution.nativeAgent selection (the configured value is statically checkable)", () => {
    const denyAll = {
      read: "deny",
      write: "deny",
      shell: "deny",
      network: "deny",
      delegate: "deny",
      review: "deny",
      validate: "deny",
      gitWrite: "deny",
    };
    const withExecNative = {
      "semantic-assessor": {
        role: "Semantic Assessor",
        skills: [],
        mcps: [],
        permissions: denyAll,
        execution: { model: "@structured-assessor", transport: "paseo", nativeAgent: "primary" },
      },
    };
    const execCheck = checkNonparticipantConstraints(withExecNative);
    expect(execCheck.status).toBe("FAIL");
    expect(execCheck.evidence.violations.some((v: any) => String(v.reason).includes("execution native agent"))).toBe(true);
    const withTopNative = {
      "semantic-assessor": {
        role: "Semantic Assessor",
        skills: [],
        mcps: [],
        permissions: denyAll,
        nativeAgent: "primary",
        execution: { model: "@structured-assessor", transport: "paseo" },
      },
    };
    const topCheck = checkNonparticipantConstraints(withTopNative);
    expect(topCheck.status).toBe("FAIL");
    expect(topCheck.evidence.violations.some((v: any) => String(v.reason).includes("top-level native agent"))).toBe(true);
  });

  it("MEDIUM-A3 FAILS on nonempty execution.args masked by empty top-level args", () => {
    const denyAll = {
      read: "deny",
      write: "deny",
      shell: "deny",
      network: "deny",
      delegate: "deny",
      review: "deny",
      validate: "deny",
      gitWrite: "deny",
    };
    const masked = {
      "semantic-assessor": {
        role: "Semantic Assessor",
        skills: [],
        mcps: [],
        permissions: denyAll,
        args: [],
        execution: { model: "@structured-assessor", transport: "paseo", args: ["--debug"] },
      },
    };
    // The old `agent.args ?? agent.execution?.args` shape resolves to the
    // empty top-level array and misses the execution args.
    const oldShape = (masked["semantic-assessor"] as any).args ?? (masked["semantic-assessor"] as any).execution?.args ?? [];
    expect(oldShape).toEqual([]);
    const check = checkNonparticipantConstraints(masked);
    expect(check.status).toBe("FAIL");
    expect(check.evidence.violations.some((v: any) => String(v.reason).includes("execution runtime arguments"))).toBe(true);
  });

  it("H1-PLANNER FAILS L1-E when the typed workUnits constraint is omittable (required omits it)", () => {
    // Old plannerWireHolds passed any properties.workUnits with type:array +
    // minItems>=1. A schema that omits workUnits from required lets a payload
    // drop the property while the zod gate rejects [] — vacuous wire parity.
    const schemas = compliantSchemas();
    (schemas.planner as any).required = ["affectedAreas"];
    const check = checkWireParity(schemas, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["planner-nonvacuous"]);
  });

  it("H1-EXPLORER FAILS L1-E when branches bind evidence arrays the payload may omit (required omits them)", () => {
    // Old explorerWireHolds passed branches carrying type:array+minItems>=1
    // without required-membership. A payload omitting the array takes the
    // branch while every evidence array stays empty.
    const schemas = compliantSchemas();
    (schemas.explorer as any).anyOf = EXPLORER_KNOWN_EVIDENCE_ARRAYS.map((field) => ({
      properties: { [field]: { type: "array", minItems: 1 } },
    }));
    const check = checkWireParity(schemas, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["explorer-nonvacuous"]);
  });

  it("H1-SPEC FAILS L1-E when the parent artifacts object is omittable (top required omits it)", () => {
    // Old specWireHolds passed an artifacts node carrying the
    // required+typed proposal/tasks pair even when a READY payload could omit
    // the parent artifacts object entirely.
    const schemas = compliantSchemas();
    (schemas["spec-authoring"] as any).required = ["change", "status"];
    const check = checkWireParity(schemas, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["spec-ready-artifacts"]);
  });

  it("H1-REVIEWER FAILS L1-E when a qualifying branch is paired with a vacuous {} alternative", () => {
    // Old reviewerWireHolds passed when ANY anyOf branch qualified. A FAIL
    // payload with empty findings takes the vacuous {} branch instead.
    const schemas = compliantSchemas();
    (schemas.reviewer as any).anyOf = [
      { required: ["verdict", "findings"], properties: { verdict: { const: "FAIL" }, findings: { type: "array", minItems: 1 } } },
      {},
    ];
    const check = checkWireParity(schemas, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["reviewer-coherence"]);
  });

  it("H1-SUPERVISOR FAILS L1-E when a qualifying branch is paired with a vacuous {} alternative", () => {
    // Old supervisorWireHolds passed when ANY anyOf branch qualified. A SAFE
    // payload with pending unresolved items takes the vacuous {} branch.
    const schemas = compliantSchemas();
    (schemas.supervisor as any).anyOf = [
      {
        required: ["finalizationSafety", "unresolved", "missingEvidence"],
        properties: {
          finalizationSafety: { const: "SAFE" },
          unresolved: { type: "array", maxItems: 0 },
          missingEvidence: { type: "array", maxItems: 0 },
        },
      },
      {},
    ];
    const check = checkWireParity(schemas, undefined);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing).toEqual(["supervisor-coherence"]);
  });

  it("H2 STALE_DIST refuses a dist snapshot bound to a different source tree", () => {
    const bound = checkDistBindsSource(
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), releaseId: "r", buildDigest: "b".repeat(64), dirty: false },
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), dirty: false },
    );
    expect(bound).toBeNull();
    const versionMismatch = checkDistBindsSource(
      { packageVersion: "0.25.6", gitSha: "a".repeat(40), dirty: false },
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), dirty: false },
    );
    expect(versionMismatch).toMatchObject({ reason: expect.stringContaining("packageVersion") });
    const shaMismatch = checkDistBindsSource(
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), dirty: false },
      { packageVersion: "0.25.8", gitSha: "c".repeat(40), dirty: false },
    );
    expect(shaMismatch).toMatchObject({ reason: expect.stringContaining("gitSha") });
    const dirtyBuild = checkDistBindsSource(
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), dirty: true },
      { packageVersion: "0.25.8", gitSha: "a".repeat(40), dirty: false },
    );
    expect(dirtyBuild).toMatchObject({ reason: expect.stringContaining("dirty") });
    // A stale snapshot fails E closed with the explicit STALE_DIST reason.
    const staleCheck = checkWireParity(undefined, undefined, { releaseId: "r", reason: "packageVersion dist=0.25.6 source=0.25.8" });
    expect(staleCheck.status).toBe("FAIL");
    expect(staleCheck.evidence.distAvailable).toBe(false);
    expect(staleCheck.evidence.staleDist.reason).toContain("packageVersion");
    expect(String(staleCheck.evidence.reason)).toContain("STALE_DIST");
  });

  it("M1-A2 accepts non-seed filesystem skills per the compiler registry split, failing only skills in neither registry", () => {
    // Compiler semantics (compiler.ts:74-78): seed skills are ceiling-checked,
    // non-seed OpenCode skills resolve via <skillRoot>/<id>/SKILL.md.
    const agents = { lead: { role: "Lead/Director", skills: ["engineering-workflow", "ghost-skill"] } };
    const seed = { "human-exception-handling": { id: "human-exception-handling", roles: ["Lead/Director"] } };
    const check = checkSkillRoleFit(agents, seed, ["skills"], (rel) => rel === "skills/engineering-workflow/SKILL.md");
    expect(check.id).toBe("L1-A2-SKILL-ROLE-FIT");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.violations).toMatchObject([{ agent: "lead", skill: "ghost-skill" }]);
    // Without a filesystem probe, non-seed skills fail closed as unknown.
    expect(checkSkillRoleFit(agents, seed).evidence.violations.map((v: any) => v.skill).sort()).toEqual([
      "engineering-workflow",
      "ghost-skill",
    ]);
  });
  it("M1 C1 tolerates a partially materialized skillRoot union (compiler semantics) and resolves the consumer overlay", () => {
    // The runtime compiler probes every root and fails only when NO root
    // resolves: a unioned topology with one materialized root passes.
    expect(checkSkillRootsExist(["skills", ".harness/skills"], (rel) => rel === "skills").status).toBe("PASS");
    expect(checkSkillRootsExist(["skills", ".harness/skills"], () => false).status).toBe("FAIL");
    expect(checkSkillRootsExist(["skills", ".harness/skills"], () => false).evidence.missing).toEqual(["skills", ".harness/skills"]);
    // Consumer-aware loader: the .harness overlay unions skills/ over the
    // preset roots instead of checking presets/agents/default.jsonc alone.
    const repoRoot = path.resolve(__dirname, "..");
    const { topology } = resolveConsumerTopology(repoRoot);
    expect(topology.skillRoots).toContain("skills");
    expect(topology.skillRoots).toContain(".harness/skills");
    expect(topology.agents?.["harness-reviewer"]).toBeDefined();
  });

  it("M2-A3 FAILS on runtime defaultArgs merged into selection.args (routing.ts:8)", () => {
    const denyAll = {
      read: "deny",
      write: "deny",
      shell: "deny",
      network: "deny",
      delegate: "deny",
      review: "deny",
      validate: "deny",
      gitWrite: "deny",
    };
    const runtimes = { codex: { name: "codex", adapter: "codex", defaultArgs: ["--sandbox"] } };
    const models = { "structured-assessor": { alias: "structured-assessor", runtime: "codex" } };
    const viaAlias = {
      "semantic-assessor": {
        role: "Semantic Assessor",
        skills: [],
        mcps: [],
        permissions: denyAll,
        args: [],
        execution: { model: "@structured-assessor", transport: "paseo" },
      },
    };
    const aliasCheck = checkNonparticipantConstraints(viaAlias, runtimes, models);
    expect(aliasCheck.status).toBe("FAIL");
    expect(aliasCheck.evidence.violations.some((v: any) => String(v.reason).includes("defaultArgs"))).toBe(true);
    // Direct execution.runtime resolution reports the same violation.
    const viaDirect = {
      "semantic-assessor": {
        role: "Semantic Assessor",
        skills: [],
        mcps: [],
        permissions: denyAll,
        execution: { model: "@structured-assessor", runtime: "codex", transport: "paseo" },
      },
    };
    expect(checkNonparticipantConstraints(viaDirect, runtimes, {}).status).toBe("FAIL");
    // A runtime without defaultArgs still passes.
    expect(checkNonparticipantConstraints(viaAlias, { codex: { name: "codex", adapter: "codex" } }, models).status).toBe("PASS");
  });

  it("M3 F FAILS closed without a bound dist snapshot (structural shape is advisory only)", async () => {
    // Even a compliant-looking source cannot pass without the behavioral
    // consumption proof: the text fallback is not the enforcement.
    const closed = await checkLaneCommandBindingWithBehavioral({
      laneSource: COMPLIANT_LANE_SOURCE,
      callSites: COMPLIANT_CALL_SITES,
    });
    expect(closed.id).toBe("L1-F-LANE-COMMAND-BINDING");
    expect(closed.status).toBe("FAIL");
    expect(closed.evidence.distAvailable).toBe(false);
    expect(closed.evidence.structuralAdvisory.verifyComparesCommandDigest).toBe(true);
    // evaluateAll without laneBehavioral fails F closed while other checks pass.
    const fx = compliantFixture();
    delete (fx as any).laneBehavioral;
    const checks = await evaluateAll(fx);
    const lane = checks.find((c) => c.id === "L1-F-LANE-COMMAND-BINDING");
    expect(lane?.status).toBe("FAIL");
    expect((lane?.evidence as any).distAvailable).toBe(false);
    const wire = checks.find((c) => c.id === "L1-E-WIRE-PARITY");
    expect(wire?.status).toBe("PASS");
  });
});
