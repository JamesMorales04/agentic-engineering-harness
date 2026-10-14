import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileExecutionBlueprint } from "../src/architecture/participantPlan.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  contractValidationRequirementsV1,
  dropUnresolvablePlanValidationRequirementsV1,
  mergeContractValidationRequirementsV1,
  resolveValidationRequirements
} from "../src/architecture/validationRequirements.js";
import {
  contractValidationSourcesForContractV1,
  mergedPlanContractValidationRequirementsV1,
  partitionMergedValidationRequirementsV1
} from "../src/core/contract.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import { recordEvent } from "../src/telemetry/events.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

/**
 * FAM-REACH: contract-derived validation requirements must reach the wave
 * execution blueprint (not just the downstream oracle), while genuinely
 * unresolvable PLAN-only requirements keep the advisory-drop path with its
 * durable event — and CONTRACT-derived ones are never dropped silently.
 */

const config = {
  version: 1,
  project: { name: "fixture" },
  validation: {
    baseRef: "main",
    commands: [{ id: "unit", command: "npm test -- --run", required: true }],
    validators: [{ id: "v-bdd", adapter: "bdd", command: "npm run bdd" }]
  }
} as unknown as HarnessProjectConfig;

const contract = {
  requirements: [
    { id: "R-1", description: "unit-covered behavior", validators: ["command.unit"] },
    { id: "R-2", description: "bdd-covered behavior", validators: ["v-bdd"] }
  ],
  scope: { allowed: ["src/**"] },
  verification: undefined
} as const;

function graph() {
  return createWorkGraph({
    taskId: "task-reach",
    objective: "Reach the blueprint with contract validation",
    route: "DELEGATED",
    assurance: "STANDARD",
    requirementRefs: ["R-1", "R-2"],
    acceptanceRefs: [],
    units: [
      { version: 1, id: "u1", objective: "Implement unit-covered behavior", scope: ["src/a.ts"], dependencies: [], requirementRefs: ["R-1"], acceptanceRefs: [], competencies: ["typescript"], riskTags: [], changeKinds: ["source", "test"], risk: "low", status: "PENDING" },
      { version: 1, id: "u2", objective: "Implement bdd-covered behavior", scope: ["src/b.ts"], dependencies: [], requirementRefs: ["R-2"], acceptanceRefs: [], competencies: ["typescript"], riskTags: [], changeKinds: ["source", "test"], risk: "low", status: "PENDING" }
    ]
  });
}

describe("contract validation reachability (FAM-REACH)", () => {
  it("compiles one normative requirement per configured check id (shared sources)", () => {
    const derived = contractValidationRequirementsV1(contractValidationSourcesForContractV1(contract as never, config));
    expect(derived.map((item) => item.id).sort()).toEqual(["command.unit", "v-bdd"]);
    expect(derived.find((item) => item.id === "command.unit")).toMatchObject({
      kind: "command",
      requirementRefs: ["R-1"],
      acceptanceRefs: ["R-1"]
    });
    // The merged helper is the single semantic both the blueprint path and
    // the downstream oracle path consume.
    const merged = mergedPlanContractValidationRequirementsV1([], contract as never, config);
    expect(merged.map((item) => item.id).sort()).toEqual(["command.unit", "v-bdd"]);
  });

  it("fails closed on an incompatible same-id plan declaration (no silent drop)", () => {
    const conflicting = [{
      version: 1 as const,
      id: "command.unit",
      property: "plan claims a different kind for the configured command",
      kind: "bdd" as const,
      scope: ["src/**"],
      evidenceNeeded: ["bdd evidence"],
      requirementRefs: ["R-1"],
      acceptanceRefs: ["R-1"]
    }];
    expect(() => mergeContractValidationRequirementsV1(conflicting, contractValidationRequirementsV1(contractValidationSourcesForContractV1(contract as never, config))))
      .toThrow("VALIDATION_REQUIREMENT_ID_CONFLICT");
  });

  it("carries the contract-derived requirements into the blueprint and resolves them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-reach-"));
    try {
      const merged = mergedPlanContractValidationRequirementsV1([], contract as never, config);
      const resolution = await resolveValidationRequirements({ root, requirements: merged, config, contract: contract as never });
      expect(resolution.blocked).toEqual([]);
      expect(new Set(resolution.actions.map((action) => action.requirementId))).toEqual(new Set(["command.unit", "v-bdd"]));

      const workGraph = graph();
      const candidate = createCandidateRevisionV1({ operationId: "operation:task-reach", candidateId: "candidate:task-reach:r1", taskId: workGraph.taskId, revision: 1, sourceDigest: "a".repeat(64), projectId: "project:fixture" });
      const resolvedOperationPolicy = compileResolvedOperationPolicy({ projectId: "project:fixture", operationId: candidate.operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: 1, intent: "reachability fixture", route: workGraph.route, minimumAssurance: workGraph.assurance, policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
      const blueprint = compileExecutionBlueprint({
        graph: workGraph,
        candidate,
        controllerEpoch: 1,
        operationExecutionRevision: 1,
        resolvedOperationPolicy,
        executionCatalog: compileExecutionCatalog({ runtimes: {}, models: {} }),
        validationRequirements: merged,
        validationResolution: resolution
      });
      // The blueprint carries the downstream oracle inputs: a contract
      // `command.<id>` / validator-id requirement appears in the blueprint
      // with its resolution intact.
      expect(blueprint.validationRequirements.map((item) => item.id).sort()).toEqual(["command.unit", "v-bdd"]);
      expect(new Set(blueprint.validationResolution.actions.map((action) => action.requirementId))).toEqual(new Set(["command.unit", "v-bdd"]));
      expect(blueprint.validationResolution.blocked).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drops only genuinely unresolvable PLAN requirements and never CONTRACT-derived ones", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-reach-drop-"));
    try {
      const advisory = {
        version: 1 as const,
        id: "advisory-visual",
        property: "plan-only visual intent no approved check resolves",
        kind: "visual-test" as const,
        scope: ["src/**"],
        evidenceNeeded: ["visual evidence"],
        requirementRefs: ["R-1"],
        acceptanceRefs: []
      };
      const contractDerived = contractValidationRequirementsV1(contractValidationSourcesForContractV1(contract as never, config));
      const merged = mergeContractValidationRequirementsV1([advisory], contractDerived);
      const resolution = await resolveValidationRequirements({ root, requirements: merged, config, contract: contract as never });
      expect(resolution.blocked.map((item) => item.requirementId)).toEqual(["advisory-visual"]);

      const partition = partitionMergedValidationRequirementsV1(merged, contractDerived, resolution);
      expect(partition.dropped.map((item) => item.id)).toEqual(["advisory-visual"]);
      expect(partition.kept.map((item) => item.id).sort()).toEqual(["command.unit", "v-bdd"]);

      // The advisory drop keeps its durable event: the record persists under
      // the canonical event name with the owning task (telemetry hygiene
      // redacts the object payloads; the exact dropped ids travel in the
      // partition the caller passes to recordEvent, asserted above).
      await recordEvent(root, config, "harness.plan.validation-requirements-dropped", {
        taskId: "task-reach",
        dropped: partition.dropped.map((requirement) => ({ id: requirement.id, kind: requirement.kind })),
        reasons: resolution.blocked
      });
      const events = (await fs.readFile(path.join(root, ".harness", "telemetry", "events.ndjson"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const dropped = events.filter((event) => event.name === "harness.plan.validation-requirements-dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0].attributes.taskId).toBe("task-reach");

      // A blocked CONTRACT-derived requirement fails closed instead of
      // dropping: it is a frozen-gate inconsistency, not advisory intent.
      const blockedContractResolution = { ...resolution, blocked: [{ requirementId: "command.unit", reason: "no approved check resolves it" }] };
      expect(() => partitionMergedValidationRequirementsV1(merged, contractDerived, blockedContractResolution))
        .toThrow("VALIDATION_REQUIREMENT_BLOCKED");
      // The legacy plan-only drop helper is unchanged for plan-only sets.
      const planOnly = dropUnresolvablePlanValidationRequirementsV1([advisory], resolution);
      expect(planOnly.dropped.map((item) => item.id)).toEqual(["advisory-visual"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
