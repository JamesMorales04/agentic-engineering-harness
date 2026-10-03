import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/core/init.js";
import { createIntentDecision } from "../src/audit/intentDecision.js";
import { DETERMINISTIC_RUNTIME_ENV } from "../src/paseo/deterministicRuntime.js";
import { executeOperation, startDetachedOperation } from "../src/operations/controller.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";
import {
  persistOpenSpecAuthoringContentV1,
  validateOpenSpecAuthoringContentCanonicalityV1,
  validateOpenSpecSpecDeltaCanonicalityV1,
  type OpenSpecSpecDeltaV1
} from "../src/spec/openspec.js";

const environmentKeys = [
  "AEH_CONTROL_ROOT",
  "AEH_OPERATION_ID",
  "AEH_OPERATION_KIND",
  "AEH_OPERATION_STATE_REDIRECT",
  "AEH_OPERATION_WORKSPACE_ID",
  "AEH_CONTROLLER_EPOCH",
  "AEH_CONTROLLER_TOKEN",
  DETERMINISTIC_RUNTIME_ENV
] as const;

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const key of environmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const canonicalDelta: OpenSpecSpecDeltaV1 = {
  capability: "greeting-extension",
  content: [
    "## ADDED Requirements",
    "",
    "### Requirement: Farewell export",
    "The greeting module SHALL export a FAREWELL constant with value \"bye\".",
    "",
    "#### Scenario: FAREWELL is exported",
    "",
    "- **WHEN** the greeting module is imported",
    "- **THEN** the FAREWELL export equals \"bye\"",
    ""
  ].join("\n")
};

function expectNotCanonical(run: () => void, artifactFragment: string): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toContain("SPEC_MANAGER_CONTENT_NOT_CANONICAL");
  expect(String((error as Error).message)).toContain(artifactFragment);
}

describe("Spec Manager READY content canonicality gate (AEH-V2-0115)", () => {
  it("accepts a canonical delta with capability, requirement and scenario", () => {
    expect(() => validateOpenSpecAuthoringContentCanonicalityV1("change-1", { specs: [canonicalDelta] })).not.toThrow();
  });

  it("rejects the Round-11 flat requirement document before any persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-spec-canonicality-flat-"));
    roots.push(root);
    const flat = {
      capability: "greeting-extension",
      content: "### Requirement: Farewell export\n\nThe greeting module SHALL export FAREWELL.\n\n#### Scenario: FAREWELL is exported\n\n- **WHEN** imported\n- **THEN** FAREWELL exists\n"
    };
    expectNotCanonical(() => validateOpenSpecSpecDeltaCanonicalityV1("change-1", 0, flat), "artifacts.specs[0]");
    await expect(persistOpenSpecAuthoringContentV1(root, "change-1", { proposal: "# Proposal", tasks: "- [ ] work", specs: [flat] })).rejects.toThrow("SPEC_MANAGER_CONTENT_NOT_CANONICAL");
    await expect(fs.access(path.join(root, "openspec", "changes", "change-1"))).rejects.toThrow();
  });

  it("rejects a requirement without a scenario and an empty spec list", () => {
    expectNotCanonical(
      () => validateOpenSpecSpecDeltaCanonicalityV1("change-1", 0, { capability: "greeting", content: "## ADDED Requirements\n\n### Requirement: No scenario\nBody only.\n" }),
      "artifacts.specs[0]"
    );
    expectNotCanonical(() => validateOpenSpecAuthoringContentCanonicalityV1("change-1", { specs: [] }), "at least one");
    expectNotCanonical(() => validateOpenSpecAuthoringContentCanonicalityV1("change-1", { specs: [{ capability: "Greeting", content: canonicalDelta.content }] }), "artifacts.specs[0]");
    expectNotCanonical(() => validateOpenSpecAuthoringContentCanonicalityV1("change-1", { specs: [canonicalDelta, canonicalDelta] }), "artifacts.specs[1]");
  });

  it("rejects a structurally canonical requirement without SHALL/MUST (AEH-V2-0111)", () => {
    const nonNormative = {
      capability: "greeting-extension",
      content: "## ADDED Requirements\n\n### Requirement: Farewell export\nThe greeting module exports a FAREWELL constant with value \"bye\".\n\n#### Scenario: FAREWELL is exported\n\n- **WHEN** the greeting module is imported\n- **THEN** the FAREWELL export equals \"bye\"\n"
    };
    expectNotCanonical(() => validateOpenSpecSpecDeltaCanonicalityV1("change-1", 0, nonNormative), "SHALL or MUST");
    expectNotCanonical(() => validateOpenSpecAuthoringContentCanonicalityV1("change-1", { specs: [nonNormative] }), "artifacts.specs[0]");
  });

  it("accepts a normative keyword on the requirement title line", () => {
    const titleLine = { capability: "greeting-extension", content: "## ADDED Requirements\n\n### Requirement: The module SHALL export FAREWELL\n\n#### Scenario: FAREWELL is exported\n\n- **WHEN** imported\n- **THEN** FAREWELL exists\n" };
    expect(() => validateOpenSpecSpecDeltaCanonicalityV1("change-1", 0, titleLine)).not.toThrow();
  });

  it("rejects a scenario that is not inside a requirement block", () => {
    expectNotCanonical(
      () => validateOpenSpecSpecDeltaCanonicalityV1("change-1", 0, { capability: "greeting", content: "## ADDED Requirements\n\n#### Scenario: Orphan\n- **WHEN** nothing\n- **THEN** nothing\n" }),
      "artifacts.specs[0]"
    );
  });
});

function routePayload() {
  return {
    judgment: {
      type: "ROUTE",
      recommendedRoute: "FORMAL_SDD",
      scopeClarity: "HIGH",
      decompositionNeed: false,
      coordinationNeed: false,
      architectureUncertainty: false,
      productUncertainty: false,
      formalizationNeed: "REQUIRED",
      semanticRiskSignals: [],
      evidenceRefs: ["request"],
      unknowns: []
    },
    claims: [],
    assumptions: [],
    unknowns: [],
    recommendations: [],
    knowledgeGaps: []
  };
}

async function disposableGitProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-spec-canonicality-controller-"));
  roots.push(root);
  await initializeProject(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "aeh@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "AEH Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

async function writeScript(root: string, responses: Record<string, unknown[]>): Promise<void> {
  const file = path.join(root, ".harness", "fixtures", "deterministic-paseo-runtime.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ version: 1, responses }, null, 2)}\n`, "utf8");
}

async function waitForTerminal(root: string, operationId: string, timeoutMs: number): Promise<OperationRecordV2> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationRecordV2 | undefined;
  while (Date.now() < deadline) {
    last = await loadOperation(root, operationId);
    if (last && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for terminal operation; last=${last ? `${last.status}/${last.phase} error=${(last.error ?? "").slice(0, 400)}` : "unreadable"}`);
}

describe("SPEC_MANAGER_CONTENT_NOT_CANONICAL through the frozen controller path", () => {
  it("enters the formalization path after a Planner-driven escalation instead of skipping to implementation", async () => {
    previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";

    const root = await disposableGitProject();
    const taskId = "S13-ESCALATION-PATH";
    const changeName = "s13-escalation-path";
    await writeScript(root, {
      "semantic-assessment:ROUTE": [{
        judgment: {
          type: "ROUTE",
          recommendedRoute: "DELEGATED",
          scopeClarity: "MEDIUM",
          decompositionNeed: true,
          coordinationNeed: true,
          architectureUncertainty: false,
          productUncertainty: false,
          formalizationNeed: "NONE",
          semanticRiskSignals: [],
          evidenceRefs: ["request"],
          unknowns: []
        },
        claims: [],
        assumptions: [],
        unknowns: [],
        recommendations: [],
        knowledgeGaps: []
      }],
      supervisor: [{ summary: "Supervisor initialized.", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }],
      explorer: [{ summary: "Bounded fixture discovery.", relevantFiles: [], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] }],
      planner: [{
        workUnits: [{
          id: "WU-1",
          objective: "Apply the bounded fixture change.",
          scope: ["**"],
          dependencies: [],
          requirementRefs: ["AC-1"],
          acceptanceRefs: ["AC-1"],
          competencies: [],
          riskTags: [],
          changeKinds: ["source"],
          risk: "low",
          resourceClaims: []
        }],
        affectedAreas: [],
        reviewDimensions: [],
        validationRequirements: [],
        outOfScopeImprovements: [],
        formalizationNeed: "REQUIRED",
        formalizationReason: "OTHER",
        formalizationEvidenceRefs: ["openspec/config.yaml: behavior changes need a real delta spec"]
      }],
      "spec-authoring": [{
        change: changeName,
        status: "READY",
        artifacts: {
          proposal: "# Proposal\n\nAdd the bounded behavior.\n",
          tasks: "## Tasks\n\n- [ ] 1.1 Apply the bounded behavior.\n",
          specs: [{ capability: "greeting-extension", content: "### Requirement: Flat\n\n#### Scenario: Flat\n" }]
        },
        requirements: ["R1"],
        unresolvedDecisions: [],
        decisionRequests: [],
        validationReady: true
      }]
    });

    const operation = await startDetachedOperation(root, "change", {
      request: "Extend the fixture greeting module.",
      intentDecision: createIntentDecision("change", "Extend the fixture greeting module.", "explicit-cli"),
      taskId,
      files: ["src/greeting.mjs"],
      risk: "low"
    }, {
      nodeExecutable: process.execPath,
      entryFile: "aeh",
      spawnProcess: (() => ({ pid: 999_999, unref: () => undefined }) as never) as never
    });
    expect(operation.changePreflight?.triage.route).toBe("DELEGATED");

    const final = await executeOperation(root, operation.id, { startWatchdog: () => () => undefined });
    expect(final.intent?.route).toBe("FORMAL_SDD");
    expect(final.status).toBe("FAILED");
    expect(String(final.error ?? "")).toContain("SPEC_MANAGER_CONTENT_NOT_CANONICAL");
    expect(String(final.error ?? "")).not.toContain("EXECUTION_POLICY_STALE");
    expect((final.stages ?? {})["environment-preflight"]?.status).toBe("COMPLETED");
    expect((final.stages ?? {})["spec-authoring"]?.status).not.toBe("COMPLETED");
  }, 240_000);

  it("fails closed before persistence when the Spec Manager returns non-canonical READY content", async () => {
    previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";

    const root = await disposableGitProject();
    const taskId = "S13-SPEC-CANONICALITY";
    const changeName = "s13-spec-canonicality";
    await writeScript(root, {
      "semantic-assessment:ROUTE": [routePayload()],
      supervisor: [{ summary: "Supervisor initialized.", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }],
      explorer: [{ summary: "Bounded fixture discovery.", relevantFiles: [], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] }],
      planner: [{
        workUnits: [],
        affectedAreas: [],
        reviewDimensions: [],
        validationRequirements: [],
        outOfScopeImprovements: [],
        formalizationNeed: "REQUIRED",
        formalizationReason: "REQUIREMENT_CONTRADICTION"
      }],
      "spec-authoring": [{
        change: changeName,
        status: "READY",
        artifacts: {
          proposal: "# Proposal\n\nAdd the bounded behavior.\n",
          tasks: "## Tasks\n\n- [ ] 1.1 Apply the bounded behavior.\n",
          specs: [{
            capability: "greeting-extension",
            content: "### Requirement: Flat requirement\n\nThe module SHALL be extended.\n\n#### Scenario: Flat scenario\n\n- **WHEN** applied\n- **THEN** extended\n"
          }]
        },
        requirements: ["R1"],
        unresolvedDecisions: [],
        decisionRequests: [],
        validationReady: true
      }]
    });

    const operation = await startDetachedOperation(root, "change", {
      request: "Extend the fixture greeting module.",
      taskId,
      files: ["src/greeting.mjs"],
      risk: "low"
    }, {
      nodeExecutable: process.execPath,
      entryFile: "aeh",
      spawnProcess: (() => ({ pid: 999_999, unref: () => undefined }) as never) as never
    });
    expect(operation.changePreflight?.triage.route).toBe("FORMAL_SDD");

    const final = await executeOperation(root, operation.id, { startWatchdog: () => () => undefined });
    expect(final.status).toBe("FAILED");
    expect(String(final.error ?? "")).toContain("SPEC_MANAGER_CONTENT_NOT_CANONICAL");
    expect(String(final.error ?? "")).toContain("artifacts.specs[0]");
    await expect(fs.access(path.join(root, "openspec", "changes", changeName))).rejects.toThrow();
    expect((final.stages ?? {})["spec-compilation"]?.status).not.toBe("COMPLETED");
  }, 240_000);
});
