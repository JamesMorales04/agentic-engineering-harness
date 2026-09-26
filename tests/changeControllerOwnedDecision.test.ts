import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordControlCenterDecision } from "../src/control-center/decision.js";
import { initializeProject } from "../src/core/init.js";
import { DETERMINISTIC_RUNTIME_ENV } from "../src/paseo/deterministicRuntime.js";
import { cancelOperation, executeOperation, startDetachedOperation } from "../src/operations/controller.js";
import { loadOperation, requestOperationPause, requestOperationResume, type OperationRecordV2 } from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { openSpecChangeName } from "../src/spec/openspec.js";

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

function explorerPayload() {
  return {
    summary: "Bounded fixture discovery.",
    relevantFiles: [{ path: "src/fixture.ts", symbols: [], reason: "fixture scope" }],
    findings: [],
    moduleBoundaries: [],
    tests: [],
    dependencies: [],
    risks: [],
    openQuestions: []
  };
}

function plannerPayload() {
  return {
    workUnits: [{
      id: "unit-1",
      objective: "Apply the bounded fixture change.",
      scope: ["src/fixture.ts"],
      dependencies: [],
      requirementRefs: [],
      acceptanceRefs: [],
      competencies: [],
      riskTags: [],
      changeKinds: ["source"],
      risk: "low",
      resourceClaims: []
    }],
    affectedAreas: ["src/fixture.ts"],
    reviewDimensions: [],
    validationRequirements: [],
    outOfScopeImprovements: []
  };
}

function blockedSpec(changeName: string, choiceId: string) {
  return {
    change: changeName,
    status: "BLOCKED",
    artifacts: { specs: [] },
    requirements: [],
    unresolvedDecisions: [`${choiceId} is unresolved`],
    decisionRequests: [{
      issue: `Which bounded behavior should '${choiceId}' select?`,
      whatTried: ["Compared both bounded interpretations against the frozen request."],
      whyUnresolvable: "Both interpretations satisfy the request and only a human product authority may choose.",
      choices: [{
        choiceId,
        label: `Behavior ${choiceId}`,
        description: `Select bounded behavior ${choiceId}.`,
        consequences: [`Records ${choiceId} in the requirement set.`]
      }],
      workThatCanContinue: ["Read-only discovery can continue."]
    }],
    validationReady: false
  };
}

async function disposableGitProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-controller-decision-"));
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

async function seedOpenSpecChange(root: string, changeName: string): Promise<void> {
  const changeDir = path.join(root, "openspec", "changes", changeName);
  await fs.mkdir(path.join(changeDir, "specs", "fixture"), { recursive: true });
  await fs.writeFile(path.join(changeDir, "proposal.md"), "# Proposal\n\nFixture proposal.\n", "utf8");
  await fs.writeFile(path.join(changeDir, "tasks.md"), "## Tasks\n\n- [ ] 1.1 Apply the bounded fixture change.\n", "utf8");
  await fs.writeFile(path.join(changeDir, "specs", "fixture", "spec.md"), "## ADDED Requirements\n\n### Requirement: Fixture behavior\nThe fixture SHALL expose bounded behavior.\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "openspec fixture"], { cwd: root });
}

async function writeScript(root: string, responses: Record<string, unknown[]>): Promise<void> {
  const file = path.join(root, ".harness", "fixtures", "deterministic-paseo-runtime.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ version: 1, responses }, null, 2)}\n`, "utf8");
}

async function waitForRecord(read: () => Promise<OperationRecordV2 | undefined>, timeoutMs: number, label: string): Promise<OperationRecordV2> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationRecordV2 | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}; last=${last ? `${last.status}/${last.phase} error=${(last.error ?? "").slice(0, 400)}` : "unreadable"}`);
}

describe("controller-owned product-choice lifecycle with the scripted provider boundary", () => {
  it("reaches HUMAN_REQUIRED through the real controller, then pauses, resumes, and cancels", async () => {
    previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";

    const root = await disposableGitProject();
    const taskId = "S9-CONTROLLER-DECISION";
    const changeName = openSpecChangeName(taskId);
    await seedOpenSpecChange(root, changeName);
    await writeScript(root, {
      "semantic-assessment:ROUTE": [routePayload()],
      supervisor: [{ summary: "Supervisor initialized.", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }],
      explorer: [explorerPayload()],
      planner: [plannerPayload()],
      "spec-authoring": [blockedSpec(changeName, "choice-a"), blockedSpec(changeName, "choice-b")]
    });

    const operation = await startDetachedOperation(root, "change", {
      request: "Add a bounded fixture behavior.",
      taskId,
      files: ["src/fixture.ts"],
      risk: "low"
    }, {
      nodeExecutable: process.execPath,
      entryFile: "aeh",
      spawnProcess: (() => ({ pid: 999_999, unref: () => undefined }) as never) as never
    });
    expect(operation.changePreflight?.triage.route).toBe("FORMAL_SDD");

    const execution = executeOperation(root, operation.id, { startWatchdog: () => () => undefined });
    const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));

    const first = await waitForRecord(async () => {
      const record = await loadOperation(root, operation.id);
      return record.phase === "HUMAN_REQUIRED" && record.decisionRequest ? record : undefined;
    }, 90_000, "the controller-owned first product-choice suspension");
    expect(first.decisionRequest!.choices.map((choice) => choice.choiceId)).toEqual(["choice-a"]);
    expect(first.continuation?.state).toBe("WAITING");

    const accepted = await recordControlCenterDecision(root, ledger, {
      operationId: operation.id,
      requestId: first.decisionRequest!.requestId,
      choiceId: "choice-a"
    }, "human:control-center:test");
    expect(accepted.accepted).toBe(true);

    const second = await waitForRecord(async () => {
      const record = await loadOperation(root, operation.id);
      return record.phase === "HUMAN_REQUIRED" && record.decisionRequest && record.decisionRequest.requestId !== first.decisionRequest!.requestId ? record : undefined;
    }, 90_000, "the controller-owned second product-choice suspension").catch(async (error) => {
      const diagnostic = await loadOperation(root, operation.id);
      const events = await fs.readFile(path.join(root, ".harness", "operations", operation.id, "events.ndjson"), "utf8").catch(() => "");
      throw new Error(`${error instanceof Error ? error.message : String(error)} | durable=${diagnostic.status}/${diagnostic.phase} continuation=${diagnostic.continuation?.state ?? "none"} decisionRequest=${diagnostic.decisionRequest ? "present" : "absent"} error=${(diagnostic.error ?? "").slice(0, 600)} | events=${events.trim().split("\n").slice(-4).join(" || ")}`);
    });
    expect(second.decisionRequest!.choices.map((choice) => choice.choiceId)).toEqual(["choice-b"]);

    await requestOperationPause(root, operation.id, "human:control-center:test");
    const paused = await waitForRecord(async () => {
      const record = await loadOperation(root, operation.id);
      return record.phase === "PAUSED" ? record : undefined;
    }, 60_000, "the controller-owned PAUSED suspension");
    expect(paused.pause?.resumePhase).toBe("HUMAN_REQUIRED");
    expect(paused.pause?.drainReceipt).toMatchObject({ activeParticipantIds: [], activeProviderLeaseIds: [] });
    expect(paused.decisionRequest?.requestId).toBe(second.decisionRequest!.requestId);
    expect(paused.continuation?.state).toBe("WAITING");

    await expect(requestOperationResume(root, operation.id, "human:control-center:test")).resolves.toBeDefined();
    const resumed = await waitForRecord(async () => {
      const record = await loadOperation(root, operation.id);
      return record.phase === "HUMAN_REQUIRED" && !record.pause ? record : undefined;
    }, 60_000, "the controller-owned resume back to HUMAN_REQUIRED");
    expect(resumed.decisionRequest?.requestId).toBe(second.decisionRequest!.requestId);
    await expect(requestOperationResume(root, operation.id, "human:control-center:test")).rejects.toThrow(/only a PAUSED operation can be resumed/);

    const cancelled = await cancelOperation(root, operation.id, { humanActorId: "human:control-center:test" });
    expect(cancelled.status).toBe("CANCELLED");
    const final = await execution;
    expect(final.status).toBe("CANCELLED");
    const durable = await loadOperation(root, operation.id);
    expect(durable.status).toBe("CANCELLED");
    expect(durable.pause).toBeUndefined();
    expect(durable.decisionRequest).toBeUndefined();
    expect(durable.continuation).toBeUndefined();
  }, 240_000);
});
