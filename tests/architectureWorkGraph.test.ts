import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkGraph, resourceClaimConflicts, resourceClaimOrderingViolations, validateWorkGraph, type ResourceClaimV1 } from "../src/architecture/workGraph.js";
import { compileExecutionBlueprint, compileParticipantPlan } from "../src/architecture/participantPlan.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { resolvePlannerKnowledge } from "../src/agents/waveExecutor.js";
import { planParallelism } from "../src/agents/parallelism.js";
import { InMemoryKnowledgeCacheV1, knowledgePack, resolveKnowledgeGate } from "../src/knowledge/index.js";
import { resolveValidationRequirements, type ValidationRequirementV1 } from "../src/architecture/validationRequirements.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";

function graph() {
  return createWorkGraph({
    taskId: "task-v2",
    objective: "Introduce a bounded canonical execution path",
    route: "DELEGATED",
    assurance: "ELEVATED",
    requirementRefs: ["req-1", "req-2"],
    acceptanceRefs: ["accept-1"],
    units: [
      { version: 1, id: "design", objective: "Define the boundary", scope: ["src/architecture/**"], dependencies: [], requirementRefs: ["req-1"], acceptanceRefs: [], competencies: ["architecture"], riskTags: ["public-contract"], changeKinds: ["source", "test"], risk: "high", status: "PENDING" },
      { version: 1, id: "implement", objective: "Implement the boundary", scope: ["src/architecture/**", "tests/**"], dependencies: ["design"], requirementRefs: ["req-2"], acceptanceRefs: ["accept-1"], competencies: ["typescript"], riskTags: [], changeKinds: ["source", "test"], risk: "medium", status: "PENDING" }
    ]
  });
}

const planIdentity = () => ({ operationId: "operation:task-v2", operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: "c".repeat(64), controllerEpoch: 0 });

const compileCriticalBlueprint = (validationRequirements: readonly ValidationRequirementV1[] = []) => {
  const workGraph = { ...graph(), assurance: "CRITICAL" as const };
  const candidate = createCandidateRevisionV1({ operationId: "operation:task-v2", candidateId: "candidate:task-v2:r4", taskId: workGraph.taskId, revision: 4, sourceDigest: "a".repeat(64) });
  const resolvedOperationPolicy = compileResolvedOperationPolicy({ projectId: candidate.projectId ?? "project:task-v2", operationId: candidate.operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: 1, intent: "compile test graph", route: workGraph.route, minimumAssurance: workGraph.assurance, policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
  return compileExecutionBlueprint({ graph: workGraph, candidate, controllerEpoch: 1, operationExecutionRevision: 1, resolvedOperationPolicy, executionCatalog: compileExecutionCatalog({ runtimes: {}, models: {} }), validationRequirements });
};

function assertDeeplyFrozen(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value), `${path} is not frozen`).toBe(true);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) assertDeeplyFrozen(nested, `${path}.${key}`);
}

describe("canonical WorkGraph and participant compiler", () => {
  it("rejects duplicate and uncovered work metadata", () => {
    expect(() => validateWorkGraph({ version: 1, taskId: "x", objective: "x", route: "DIRECT", assurance: "NONE", requirementRefs: ["missing"], acceptanceRefs: [], units: [] })).toThrow(/uncovered requirements/);
  });

  it("compiles capabilities without concrete agent names", () => {
    const plan = compileParticipantPlan({ graph: graph(), executionIdentity: planIdentity(), availableCompetencies: ["architecture", "typescript"] });
    expect(plan.assignments.map((entry) => entry.participantId)).toEqual(["participant:design", "participant:implement"]);
    expect(plan.assignments.every((entry) => !Object.hasOwn(entry, "agent"))).toBe(true);
    expect(plan.compilerDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("schedules dependencies into deterministic waves and adds critical gates", () => {
    const blueprint = compileCriticalBlueprint();
    expect(blueprint.waves).toEqual([["design"], ["implement"]]);
  expect(blueprint.deterministicGates).toContain("review-required");
  expect(blueprint.candidateRevision).toBe(4);
    expect(blueprint.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(blueprint.executionCatalog.roleProfiles.length).toBeGreaterThan(0);
  });

  it("returns a deeply immutable compiled blueprint", () => {
    const blueprint = compileCriticalBlueprint([
      { version: 1, id: "REQ-IMMUTABLE", property: "the compiled blueprint is immutable", kind: "unit-test", scope: ["src/**"], evidenceNeeded: ["focused immutability test"], requirementRefs: ["req-1"], acceptanceRefs: ["accept-1"] }
    ]);

    assertDeeplyFrozen(blueprint);

    expect(blueprint.waves).toEqual([["design"], ["implement"]]);
    expect(blueprint.deterministicGates).toContain("review-required");
    expect(blueprint.validationRequirements.map((requirement) => requirement.id)).toEqual(["REQ-IMMUTABLE"]);
    expect(blueprint.candidate.revision).toBe(4);

    expect(() => { blueprint.waves[0]!.push("mutated"); }).toThrow(TypeError);
    expect(() => { blueprint.waves.push(["mutated"]); }).toThrow(TypeError);
    expect(() => { blueprint.deterministicGates.push("mutated"); }).toThrow(TypeError);
    expect(() => { blueprint.validationRequirements.push(blueprint.validationRequirements[0]!); }).toThrow(TypeError);
    expect(() => { blueprint.validationRequirements[0]!.scope.push("mutated/**"); }).toThrow(TypeError);
    expect(() => { blueprint.candidate.revision = 99; }).toThrow(TypeError);
    expect(() => { blueprint.plan.assignments[0]!.budget.maxTokens = 1; }).toThrow(TypeError);
    expect(() => { blueprint.executionCatalog.roleProfiles.pop(); }).toThrow(TypeError);

    expect(blueprint.waves).toEqual([["design"], ["implement"]]);
    expect(blueprint.deterministicGates).toContain("review-required");
    expect(blueprint.validationRequirements.map((requirement) => requirement.id)).toEqual(["REQ-IMMUTABLE"]);
    expect(blueprint.candidate.revision).toBe(4);
  });

  it("fails closed when candidate or controller identity is omitted", () => {
    const catalog = compileExecutionCatalog({ runtimes: {}, models: {} });
    expect(() => compileExecutionBlueprint({ graph: graph(), executionCatalog: catalog, controllerEpoch: 1 } as never)).toThrow("CandidateRevision");
    const candidate = createCandidateRevisionV1({ operationId: "operation:task-v2", candidateId: "candidate:task-v2:r1", taskId: "task-v2", revision: 1, sourceDigest: "b".repeat(64) });
    expect(() => compileExecutionBlueprint({ graph: graph(), candidate, executionCatalog: catalog, controllerEpoch: undefined as never })).toThrow("controller epoch");
  });

  it("bundles compatible dependency-linked units but preserves independent fan-out", () => {
    const bundled = createWorkGraph({ ...graph(), units: [
      { ...graph().units[0]!, competencies: ["typescript"] },
      { ...graph().units[1]!, competencies: ["typescript"] }
    ] });
    const plan = compileParticipantPlan({ graph: bundled, executionIdentity: planIdentity(), availableCompetencies: ["typescript"] });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]?.workUnitIds).toEqual(["design", "implement"]);
    expect(plan.assignments[0]?.skillManifest.scope.workUnitIds).toEqual(["design", "implement"]);

    const independent = createWorkGraph({ ...bundled, units: [
      { ...bundled.units[0]!, id: "one", dependencies: [] },
      { ...bundled.units[1]!, id: "two", dependencies: [] }
    ] });
    expect(compileParticipantPlan({ graph: independent, executionIdentity: planIdentity(), availableCompetencies: ["typescript"] }).assignments).toHaveLength(2);
  });

  it("rejects unknown competencies and participant fan-out beyond budget", () => {
    expect(() => compileParticipantPlan({ graph: createWorkGraph({ ...graph(), requirementRefs: ["req-1"], acceptanceRefs: [], units: [{ ...graph().units[0]!, competencies: ["unknown-competency"], requirementRefs: ["req-1"], acceptanceRefs: [] }] }), executionIdentity: planIdentity() })).toThrow(/missing competencies/);
    expect(() => compileParticipantPlan({ graph: graph(), executionIdentity: planIdentity(), availableCompetencies: ["architecture", "typescript"], maxParticipants: 1 })).toThrow(/BUDGET_EXCEEDED/);
  });

  it("accepts an unknown competency only through a validated operation-local knowledge candidate", async () => {
    const competency = "unknown.library";
    const cache = new InMemoryKnowledgeCacheV1();
    const resolution = await resolveKnowledgeGate({
      requiredCompetencies: [competency],
      knownCompetencies: [],
      cache,
      lookup: async (gap) => knowledgePack({
        cacheKey: gap.cacheKey,
        topic: competency,
        claims: [{ id: "claim-1", statement: "Use the operation-local library adapter.", competency, confidence: "high" }],
        sources: [{ uri: "https://example.test/official", kind: "official", version: "1" }],
        retrievedAt: "2026-09-22T00:00:00.000Z"
      })
    });
    const plan = compileParticipantPlan({ graph: createWorkGraph({ ...graph(), requirementRefs: ["req-1"], acceptanceRefs: [], units: [{ ...graph().units[0]!, competencies: [competency], requirementRefs: ["req-1"], acceptanceRefs: [] }] }), executionIdentity: planIdentity(), knowledgeResolution: resolution });
    expect(plan.assignments[0]?.skills).toContain("ephemeral:unknown.library");
    expect(plan.assignments[0]?.toolPack.forbidden).toContain("agent-spawn-by-name");
  });

  it("rejects an operation-local candidate whose provenance is not bound to the validated pack", async () => {
    const competency = "unknown.library";
    const resolution = await resolveKnowledgeGate({
      requiredCompetencies: [competency],
      knownCompetencies: [],
      lookup: async (gap) => knowledgePack({
        cacheKey: gap.cacheKey,
        topic: competency,
        claims: [{ id: "claim-1", statement: "Use the operation-local library adapter.", competency, confidence: "high" }],
        sources: [{ uri: "https://example.test/official", kind: "official", version: "1" }],
        retrievedAt: "2026-09-22T00:00:00.000Z"
      })
    });
    expect(() => compileParticipantPlan({
      graph: createWorkGraph({ ...graph(), requirementRefs: ["req-1"], acceptanceRefs: [], units: [{ ...graph().units[0]!, competencies: [competency], requirementRefs: ["req-1"], acceptanceRefs: [] }] }),
      executionIdentity: planIdentity(),
      knowledgeResolution: { ...resolution, acceptedSkill: { ...resolution.acceptedSkill!, sourcePackDigest: "f".repeat(64) } }
    })).toThrow(/not bound to the deterministic trust-gate result/);
  });

  it("runs unknown planner competencies through KnowledgeGate and blocks without trusted lookup", async () => {
    const plan = { workUnits: [{ id: "unknown", objective: "Use the unknown library", scope: ["src/**"], dependencies: [], requirementRefs: [], acceptanceRefs: [], competencies: ["unknown.library"], riskTags: [], changeKinds: ["source" as const], risk: "medium" as const }], affectedAreas: [], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] };
    const resolution = await resolvePlannerKnowledge(plan, {
      root: ".",
      config: {} as never,
      contract: {} as never,
      knowledgeLookup: async (gap) => knowledgePack({ cacheKey: gap.cacheKey, topic: "unknown.library", claims: [{ id: "claim-1", statement: "Use the operation-local library adapter.", competency: "unknown.library", confidence: "high" }], sources: [{ uri: "https://example.test/official", kind: "official" }], retrievedAt: "2026-09-22T00:00:00.000Z" })
    });
    expect(resolution[0]?.acceptedSkill).toMatchObject({ id: "ephemeral:unknown.library", trustDecision: { status: "ACCEPTED" } });
    await expect(resolvePlannerKnowledge(plan, { root: ".", config: {} as never, contract: {} as never })).rejects.toMatchObject({ code: "KNOWLEDGE_GAP_BLOCKED" });
  });

  it("resolves validation need separately from execution commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-validation-resolution-"));
    try {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }));
      const result = await resolveValidationRequirements({ root, requirements: [{ version: 1, id: "REQ-TEST", property: "unit behavior is demonstrated", kind: "unit-test", scope: ["src/**"], evidenceNeeded: ["passing test report"], requirementRefs: ["REQ-1"], acceptanceRefs: ["AC-1"] }] });
      expect(result.blocked).toEqual([]);
      expect(result.actions[0]).toMatchObject({ source: "project-script", selector: "test", command: "npm test" });
      expect(result.actions[0]).not.toHaveProperty("property");
      const blocked = await resolveValidationRequirements({ root, requirements: [{ version: 1, id: "REQ-BROWSER", property: "browser behavior", kind: "browser-test", scope: ["ui/**"], evidenceNeeded: ["browser trace"], requirementRefs: [], acceptanceRefs: [] }] });
      expect(blocked.blocked[0]?.requirementId).toBe("REQ-BROWSER");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe("WorkUnit logical resource claims", () => {
  const claim = (resource: string, mode: ResourceClaimV1["mode"], order?: number): ResourceClaimV1 => ({ version: 1, resource, mode, ...(order === undefined ? {} : { order }) });
  const unitWithClaims = (claims: ResourceClaimV1[]) => {
    const base = graph();
    return createWorkGraph({ ...base, units: [{ ...base.units[0]!, resourceClaims: claims }, base.units[1]!] });
  };
  const task = (id: string, scope: string, resourceClaims: ResourceClaimV1[]) => ({ id, objective: `objective ${id}`, scope: [scope], dependencies: [] as string[], requirementRefs: [], acceptanceRefs: [], competencies: ["typescript"], riskTags: [], changeKinds: ["source"], risk: "medium", resourceClaims });

  it("rejects duplicate resource claims and ORDERED_SEQUENCE without an order", () => {
    expect(() => unitWithClaims([claim("db-schema", "SHARED_READ"), claim("db-schema", "EXCLUSIVE_WRITE")])).toThrow(/WORK_GRAPH_INVALID: 'design' declares duplicate resource claim 'db-schema'/);
    expect(() => unitWithClaims([claim("db-schema", "SHARED_READ"), claim("db-schema", "SHARED_READ")])).toThrow(/WORK_GRAPH_INVALID/);
    expect(() => unitWithClaims([claim("migrations", "ORDERED_SEQUENCE")])).toThrow(/WORK_GRAPH_INVALID: 'design' declares ORDERED_SEQUENCE for 'migrations' without a non-negative integer order/);
  });

  it("classifies resource claim conflicts with stable identifiers", () => {
    expect(resourceClaimConflicts([claim("db-schema", "EXCLUSIVE_WRITE")], [claim("db-schema", "EXCLUSIVE_WRITE")])).toEqual(["resource:db-schema:exclusive-exclusive"]);
    expect(resourceClaimConflicts([claim("api-contract", "EXCLUSIVE_WRITE")], [claim("api-contract", "SHARED_READ")])).toEqual(["resource:api-contract:write-read"]);
    expect(resourceClaimConflicts([claim("api-contract", "SHARED_READ")], [claim("api-contract", "EXCLUSIVE_WRITE")])).toEqual(["resource:api-contract:write-read"]);
    expect(resourceClaimConflicts([claim("migrations", "ORDERED_SEQUENCE", 0)], [claim("migrations", "SHARED_READ")])).toEqual(["resource:migrations:ordered-sequence"]);
    expect(resourceClaimConflicts([claim("migrations", "ORDERED_SEQUENCE", 0)], [claim("migrations", "ORDERED_SEQUENCE", 1)])).toEqual(["resource:migrations:ordered-sequence"]);
    expect(resourceClaimConflicts([claim("api-contract", "SHARED_READ")], [claim("api-contract", "SHARED_READ")])).toEqual([]);
    expect(resourceClaimConflicts([claim("api-contract", "SHARED_READ")], [claim("other-resource", "EXCLUSIVE_WRITE")])).toEqual([]);
  });

  it("detects duplicate ordered-sequence positions without imposing cross-resource order", () => {
    expect(resourceClaimOrderingViolations([
      { id: "a", resourceClaims: [claim("migrations", "ORDERED_SEQUENCE", 0)] },
      { id: "b", resourceClaims: [claim("migrations", "ORDERED_SEQUENCE", 0)] }
    ])).toEqual(["resource:migrations:duplicate-order:0"]);
    expect(resourceClaimOrderingViolations([
      { id: "a", resourceClaims: [claim("migrations", "ORDERED_SEQUENCE", 0)] },
      { id: "b", resourceClaims: [claim("migrations", "ORDERED_SEQUENCE", 1)] },
      { id: "c", resourceClaims: [claim("releases", "ORDERED_SEQUENCE", 0)] }
    ])).toEqual([]);
  });

  it("serializes exclusive writes and co-schedules shared reads on the same logical resource", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-resource-claims-"));
    try {
      const exclusive = await planParallelism(root, {} as never, "T", [
        task("A", "src/a.ts", [claim("db-schema", "EXCLUSIVE_WRITE")]),
        task("B", "src/b.ts", [claim("db-schema", "EXCLUSIVE_WRITE")])
      ]);
      expect(exclusive.waves).toEqual([["A"], ["B"]]);
      expect(exclusive.conflicts[0]?.reasons).toContain("resource-claim:resource:db-schema:exclusive-exclusive");
      const shared = await planParallelism(root, {} as never, "T", [
        task("A", "src/a.ts", [claim("api-contract", "SHARED_READ")]),
        task("B", "src/b.ts", [claim("api-contract", "SHARED_READ")])
      ]);
      expect(shared.waves).toEqual([["A", "B"]]);
      expect(shared.conflicts).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("orders same-resource ORDERED_SEQUENCE claims into strictly later waves", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-resource-claims-order-"));
    try {
      const plan = await planParallelism(root, {} as never, "T", [
        task("B", "src/b.ts", [claim("migrations", "ORDERED_SEQUENCE", 1)]),
        task("A", "src/a.ts", [claim("migrations", "ORDERED_SEQUENCE", 0)])
      ]);
      expect(plan.waves).toEqual([["A"], ["B"]]);
      await expect(planParallelism(root, {} as never, "T", [
        task("A", "src/a.ts", [claim("migrations", "ORDERED_SEQUENCE", 0)]),
        task("B", "src/b.ts", [claim("migrations", "ORDERED_SEQUENCE", 0)])
      ])).rejects.toThrow(/Cannot schedule delegation plan: resource:migrations:duplicate-order:0/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
