import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/core/init.js";
import { DETERMINISTIC_RUNTIME_ENV } from "../src/paseo/deterministicRuntime.js";
import { executeOperation, startDetachedOperation } from "../src/operations/controller.js";


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

function routePayload() {
  return {
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
  };
}

function explorerPayload() {
  return {
    summary: "Bounded fixture discovery.",
    relevantFiles: [{ path: "src/greeting.mjs", symbols: [], reason: "fixture scope" }],
    findings: [],
    moduleBoundaries: [],
    tests: [],
    dependencies: [],
    risks: [],
    openQuestions: []
  };
}

async function disposableGitProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-traceability-"));
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

describe("DELEGATED planning derives from the sealed TaskContract (AEH-V2-0110)", () => {
  it("seals the routed contract before planning and the planner references its frozen requirement ids", async () => {
    previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";

    const root = await disposableGitProject();
    const taskId = "S13-PLAN-TRACEABILITY";
    await writeScript(root, {
      "semantic-assessment:ROUTE": [routePayload()],
      supervisor: [{ summary: "Supervisor initialized.", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }],
      explorer: [explorerPayload()],
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
        affectedAreas: ["src/greeting.mjs"],
        reviewDimensions: [],
        validationRequirements: [],
        outOfScopeImprovements: [],
        formalizationNeed: "NONE"
      }]
    });

    const operation = await startDetachedOperation(root, "change", {
      request: "Extend the fixture greeting module.",
      taskId,
      files: ["src/greeting.mjs"],
      acceptance: ["node scripts/validate.mjs passes with the FAREWELL export available"],
      risk: "low"
    }, {
      nodeExecutable: process.execPath,
      entryFile: "aeh",
      spawnProcess: (() => ({ pid: 999_999, unref: () => undefined }) as never) as never
    });
    expect(operation.changePreflight?.triage.route).toBe("DELEGATED");

    const final = await executeOperation(root, operation.id, { startWatchdog: () => () => undefined });
    const stages = final.stages ?? {};
    expect(stages["contract-authoring"]?.status).toBe("COMPLETED");
    expect(stages["planning"]?.status).toBe("COMPLETED");
    expect(Date.parse(stages["planning"]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(stages["contract-authoring"]!.finishedAt!));

    const contract = YAML.parse(await fs.readFile(path.join(root, ".harness", "contracts", `${taskId}.yaml`), "utf8")) as { requirements: Array<{ id: string }> };
    expect(contract.requirements.map((requirement) => requirement.id)).toEqual(["AC-1"]);

    const planner = Object.values(final.participants ?? {}).find((participant) => participant.role === "Planner" && participant.resultArtifact);
    expect(planner?.resultArtifact).toBeDefined();
    const artifact = JSON.parse(await fs.readFile(path.join(root, planner!.resultArtifact!), "utf8")) as { payload: { payload?: { workUnits: Array<{ requirementRefs: string[]; acceptanceRefs: string[] }> }; workUnits?: Array<{ requirementRefs: string[]; acceptanceRefs: string[] }> } };
    const plan = artifact.payload.payload ?? artifact.payload;
    expect(plan.workUnits).toBeDefined();
    expect(plan.workUnits!.flatMap((unit) => [...unit.requirementRefs, ...unit.acceptanceRefs])).toEqual(expect.arrayContaining(["AC-1"]));
  }, 240_000);
});
