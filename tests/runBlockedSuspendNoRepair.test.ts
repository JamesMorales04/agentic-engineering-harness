import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  executeAgentPrompt: vi.fn(),
  executePlannerWaves: vi.fn(),
  setupToolchain: vi.fn(async () => ({ profile: "test", generatedConfig: ".config/mise/conf.d/aeh.toml", lockFile: ".harness/toolchain.lock.json", stateFile: ".harness/toolchain.state.json", installed: [], containers: [], systemMissing: [], projectDependencyCommands: ["npm ci"] })),
  resolveBlocker: vi.fn(),
}));

vi.mock("../src/workers/factory.js", () => ({
  createWorkerExecutor: () => ({
    name: "test-worker",
    doctor: async () => ({ ok: true, message: "test worker" }),
    start: mocks.start,
    repair: vi.fn(),
  }),
}));
vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/agents/waveExecutor.js", () => ({ executePlannerWaves: mocks.executePlannerWaves }));
vi.mock("../src/toolchain/setup.js", () => ({ setupToolchain: mocks.setupToolchain, compileToolchain: vi.fn() }));
vi.mock("../src/operations/supervisor.js", () => ({
  ensureOperationSupervisor: vi.fn(async (_root: unknown, _config: unknown, _contract: unknown, selection: unknown) => selection ? { operationId: "BLOCKED-NO-REPAIR", generation: 1, agentId: "supervisor:test", materialized: true, selection } : undefined),
  maybeRotateOperationSupervisor: vi.fn(async () => undefined),
  settleDrainingSupervisorGenerations: vi.fn(async () => undefined),
  consolidateWithOperationSupervisor: vi.fn(async () => ({ output: { summary: "t", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }, artifact: "t.json", session: { provider: "test", logicalAgent: "operation-supervisor", exitCode: 0, stdout: "", stderr: "" } })),
}));
vi.mock("../src/candidates/repairScope.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/candidates/repairScope.js")>();
  return {
    ...orig,
    resolveRepairScopeBlockerViaProductChoice: mocks.resolveBlocker,
  };
});

import YAML from "yaml";
import { runTask } from "../src/core/run.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../src/core/types.js";
import { loadOperation } from "../src/operations/state.js";
import { runShell } from "../src/utils/process.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { semanticPayload, semanticTestAssessor, semanticTestService } from "./semanticAssessmentSupport.js";
import type { SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { bindResolvedOperationPolicy, currentControllerEpoch } from "../src/operations/state.js";
import { sha256Canonical } from "../src/core/digest.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  mocks.start.mockReset();
  mocks.executeAgentPrompt.mockReset();
  mocks.executePlannerWaves.mockReset();
  mocks.setupToolchain.mockClear();
  mocks.resolveBlocker.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("BLOCKED scope resolution must not enter validation/repair (suspend boundary)", () => {
  it("RED: BLOCKED implementer resolution returns terminal BLOCKED with zero repair turns (no validation, no Repairer)", async () => {
    const root = await createProject();
    const task = taskContract();
    const config = projectConfig();
    await writeProjectInputs(root, task);
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });

    const operationId = "BLOCKED-NO-REPAIR-1";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now } as never);
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: candidate.projectId ?? config.project.name,
      operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(operation),
      intent: "blocked must not repair",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2" },
      policyDigests: { validation: sha256Canonical(task.verification ?? {}) },
      validationPolicy: task.verification ?? {},
      reviewPolicy: { minimumAssurance: "STANDARD", independentReviewRequired: false, leadAcceptance: true, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: { mode: "disabled" },
      allowedExternalEffects: [],
      humanDecisionRequirements: [],
    }));
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;

    // Implementer declares an out-of-scope blocker (no changes).
    const blockerStdout = `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: [],
      behaviorImplemented: [],
      decisions: [],
      assumptions: [],
      risks: [],
      validationCommands: [],
      followUp: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    })}`;
    mocks.start.mockResolvedValue(session("implementer", "participant:initial", blockerStdout));

    // Simulate decline/timeout/expiry: resolver returns BLOCKED (fail closed, no grant).
    mocks.resolveBlocker.mockImplementation(async (input: { blocker: { digest: string; filesNeededOutsideScope: unknown[] } }) => {
      const blocker = input.blocker as unknown as Parameters<typeof import("../src/candidates/repairScope.js").repairScopeBlockerValidationCheck>[0];
      const { repairScopeBlockerValidationCheck } = await import("../src/candidates/repairScope.js");
      // Use the real deterministic check so the report cites the exact blocker.
      const check = repairScopeBlockerValidationCheck(blocker);
      return { status: "BLOCKED" as const, blocker: input.blocker, check };
    });

    // Repairer must never run while BLOCKED. If it does, fail loudly.
    mocks.executeAgentPrompt.mockImplementation(async () => {
      throw new Error("REPAIR_TURN_RAN_WHILE_BLOCKED: Repairer executed while scope resolution is BLOCKED");
    });

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    // Suspend boundary: BLOCKED is terminal, no retry, no repair turns.
    expect(result.status).toBe("FAIL");
    expect(result.attempts).toBe(0);
    expect(result.report.checks).toContainEqual(expect.objectContaining({ id: "repair.scope-blocker", status: "FAIL" }));
    expect(result.report.checks.find((c) => c.id === "repair.scope-blocker")?.message).toContain("package-lock.json");
    // No validation workspace prep and no Repairer turn while suspended/declined/expired.
    expect(mocks.setupToolchain).not.toHaveBeenCalled();
    expect(mocks.executeAgentPrompt).not.toHaveBeenCalled();
    expect(mocks.resolveBlocker).toHaveBeenCalledTimes(1);
  });

  it("GREEN guard: AMENDED (grant minted) still proceeds to validation/repair with the exemption", async () => {
    const root = await createProject();
    const task = taskContract();
    const config = projectConfig();
    await writeProjectInputs(root, task);
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });

    const operationId = "BLOCKED-AMENDED-PROCEEDS-1";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now } as never);
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: candidate.projectId ?? config.project.name,
      operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(operation),
      intent: "amended proceeds",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2" },
      policyDigests: { validation: sha256Canonical(task.verification ?? {}) },
      validationPolicy: task.verification ?? {},
      reviewPolicy: { minimumAssurance: "STANDARD", independentReviewRequired: false, leadAcceptance: true, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: { mode: "disabled" },
      allowedExternalEffects: [],
      humanDecisionRequirements: [],
    }));
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;

    const blockerStdout = `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: [],
      behaviorImplemented: [],
      decisions: [],
      assumptions: [],
      risks: [],
      validationCommands: [],
      followUp: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    })}`;
    mocks.start.mockResolvedValue(session("implementer", "participant:initial", blockerStdout));

    // Approved path: grant minted -> AMENDED with widened scope. Must proceed
    // to validation/repair WITH the exemption (today's behavior preserved).
    mocks.resolveBlocker.mockImplementation(async (input: { blocker: { digest: string }; contract: TaskContract }) => {
      const amendedContract: TaskContract = {
        ...input.contract,
        scope: { ...(input.contract.scope ?? {}), allowed: [...(input.contract.scope?.allowed ?? []), "package-lock.json"] },
      };
      return {
        status: "AMENDED" as const,
        contract: amendedContract,
        amendment: {
          exemptedPaths: ["package-lock.json"],
          decisionId: "decision:00000000-0000-4000-8000-000000000000",
          requestId: "request:amended-proceeds",
          decidedActor: "human:test",
        },
      };
    });
    // Validation runs; repair loop may run (assurance FAIL triggers Repairer).
    // Return a benign Repairer session so the run can complete without throwing.
    mocks.executeAgentPrompt.mockImplementation(async (_root: string, _cfg: unknown, _contract: unknown, sel: { role: string; logicalAgent: string }, _prompt: string, opts: { participantId?: string }) => {
      return session(sel.logicalAgent, opts.participantId);
    });

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    expect(mocks.resolveBlocker).toHaveBeenCalledTimes(1);
    // AMENDED proceeds to validation (workspace prep ran) — unlike BLOCKED.
    expect(mocks.setupToolchain).toHaveBeenCalled();
    // The участниками: at least the repair path was entered (Repairer turn ran
    // when the post-amendment report FAILs on assurance/acceptance). If the
    // post-amendment report PASSes, attempts may stay 0 but validation still ran.
    // Either way, the run did NOT take the BLOCKED early-return: no blocker check.
    expect(result.report.checks.find((c) => c.id === "repair.scope-blocker")).toBeUndefined();
  });
});

function session(logicalAgent: string, participantId?: string, stdout = ""): WorkerSession {
  return { provider: "test", logicalAgent, participantId, exitCode: 0, stdout, stderr: "" };
}

function testSemanticRuntime() {
  const service = semanticTestService({ payload: (request: SemanticAssessmentRequestV1) => {
    const payload = semanticPayload(request);
    if (request.assessmentType !== "CANDIDATE_IMPACT") return payload;
    return {
      ...payload,
      judgment: {
        type: "CANDIDATE_IMPACT" as const,
        changedFiles: request.compactEvidence.filter((item) => item.ref.startsWith("file:")).map((item) => item.ref.slice("file:".length)),
        changeKinds: ["source"],
        reviewDimensions: ["behavior.correctness"],
        requiresIndependentReview: true,
        evidenceRefs: request.evidenceRefs,
        unknowns: ["candidate impact beyond supplied evidence is unknown"]
      }
    };
  } });
  return { service, policyRevision: semanticCapabilityPolicyRevisionV1, assessor: semanticTestAssessor() };
}

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-blocked-norepair-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }, null, 2));
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  return root;
}

function taskContract(): TaskContract {
  return {
    version: 1,
    task: { id: "BLOCKED-TASK", title: "Blocked must not repair" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", profile: "test", route: "DIRECT", assurance: "STANDARD" },
    repair: { maxAttempts: 2 },
    verification: { commands: [{ id: "candidate-check", command: "node check.mjs" }] }
  };
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "blocked-norepair-test" },
    agents: { configPath: ".harness/agents.source.jsonc", activeProfile: "test", required: true },
    sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    orchestration: { worker: { maxRepairAttempts: 2 } },
    controlPlane: { required: false },
    telemetry: { enabled: false }
  } as HarnessProjectConfig;
}

async function writeProjectInputs(root: string, contract: TaskContract): Promise<void> {
  await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "contracts", `${contract.task.id}.yaml`), YAML.stringify(contract));
  const config = projectConfig();
  const agents = {
    version: 1,
    activeProfile: "test",
    profiles: { test: {} },
    runtimes: { test: { adapter: "codex", capabilities: {} } },
    models: { test: { runtime: "test", provider: "test", model: "fake" } },
    agents: {
      implementer: { role: "Implementer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "allow", shell: "allow", delegate: "deny" } },
      planner: { role: "Planner", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "deny", delegate: "deny" }, outputContract: "planner" },
      reviewer: { role: "Reviewer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "allow", review: "allow" } },
      "operation-supervisor": { role: "Operation Supervisor", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "allow", delegate: "allow" } },
      repairer: { role: "Repairer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "allow", shell: "allow", delegate: "deny" }, outputContract: "implementer" },
    },
    routing: [{ id: "default", when: { intent: "implement" }, select: { role: "Implementer" }, review: [{ role: "Reviewer" }] }]
  };
  await fs.writeFile(path.join(root, config.agents!.configPath!), JSON.stringify(agents, null, 2));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
