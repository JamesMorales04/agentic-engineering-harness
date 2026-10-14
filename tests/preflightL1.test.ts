import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  checkAdapterCoverage,
  checkLaneCommandBinding,
  checkMcpFailClosed,
  checkMcpRefsConfigured,
  checkPermissionCeiling,
  checkSkillRefsResolve,
  checkSkillRoleFit,
  checkSpecializationsClosed,
  checkSkillRootsExist,
  checkWireParity,
  evaluateAll,
  parseRolesProfiles,
  parseSkillSeed,
} from "../scripts/preflightL1.mjs";

// Mechanism classification: DETERMINISTIC. Every fixture below is an
// in-memory literal; assertions compare exact check ids and evidence.
// No network, no model calls, no filesystem writes (except read-only
// parser lock-in tests against the checkout's own source).

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

const COMPLIANT_CONTRACTS_SOURCE = `
import { z } from "zod";
// PLANNER_EMPTY_RESULT EXPLORER_EMPTY_RESULT SPEC_MANAGER_INCOMPLETE_RESULT
// REVIEWER_FAIL_WITHOUT_FINDING REVIEWER_UNSAFE_PASS SUPERVISOR_UNSAFE_SAFE
const jsonSchemas = {
  planner: { workUnits: { type: "array", minItems: 1 } },
  explorer: { relevantFiles: { type: "array" }, anyOf: [{ required: ["findings"] }] },
  "spec-authoring": { artifacts: { type: "object", required: ["specs", "proposal", "tasks"] } },
  reviewer: { verdict: { type: "string" }, anyOf: [{ required: ["findings"] }] },
  supervisor: { finalizationSafety: { type: "string" }, allOf: [{ required: ["unresolved"] }] },
};
`;

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

function compliantFixture(): any {
  return {
    agents: compliantAgents(),
    skillRoots: ["skills"],
    routing: [{ id: "r1", select: { role: "Reviewer", specializations: ["cross-cutting"] } }],
    roles: compliantRoles(),
    skillSeed: compliantSeed(),
    permissionsSource: COMPLIANT_PERMISSIONS_SOURCE,
    contractsSource: COMPLIANT_CONTRACTS_SOURCE,
    laneSource: COMPLIANT_LANE_SOURCE,
    callSites: COMPLIANT_CALL_SITES,
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
  it("PASSES every check on a crafted compliant fixture", () => {
    const checks = evaluateAll(compliantFixture());
    expect(checks).toHaveLength(10);
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
    const bare = `
const jsonSchemas = {
  planner: { workUnits: { type: "array", items: {} } },
  explorer: { relevantFiles: { type: "array" } },
  "spec-authoring": { artifacts: { type: "object", required: ["specs"] } },
  reviewer: { verdict: { type: "string" } },
  supervisor: { finalizationSafety: { type: "string" } },
};
// PLANNER_EMPTY_RESULT EXPLORER_EMPTY_RESULT SPEC_MANAGER_INCOMPLETE_RESULT
// REVIEWER_FAIL_WITHOUT_FINDING REVIEWER_UNSAFE_PASS SUPERVISOR_UNSAFE_SAFE
`;
    const check = checkWireParity(bare);
    expect(check.id).toBe("L1-E-WIRE-PARITY");
    expect(check.status).toBe("FAIL");
    expect(check.evidence.missing.sort()).toEqual([
      "explorer-nonvacuous",
      "planner-nonvacuous",
      "reviewer-coherence",
      "spec-ready-artifacts",
      "supervisor-coherence",
    ]);
    expect(checkWireParity(COMPLIANT_CONTRACTS_SOURCE).status).toBe("PASS");
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

  it("locks the real-tree parsers to the verified campaign evidence", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const { roles } = parseRolesProfiles(fs.readFileSync(path.join(repoRoot, "src/participants/roles.ts"), "utf8"));
    expect(roles["Operation Supervisor"].authority.canExecute).toBe(true);
    expect(roles["Operation Supervisor"].toolPack.required.concat(roles["Operation Supervisor"].toolPack.optional)).not.toContain(
      "command-execute",
    );
    expect(roles["Reviewer"].specializations).not.toContain("high-assurance");
    const { seed } = parseSkillSeed(fs.readFileSync(path.join(repoRoot, "src/participants/skills.ts"), "utf8"));
    expect(seed["acceptance-traceability"].roles).toEqual(["Spec Manager"]);
    expect(seed["operation-coordination"].roles).toEqual(["Operation Supervisor"]);
  });
});
