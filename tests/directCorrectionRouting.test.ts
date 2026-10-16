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
  prepareAuthority: vi.fn(async () => ({ participantId: "participant:correction-test" })),
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
  ensureOperationSupervisor: vi.fn(async (_root: unknown, _config: unknown, _contract: unknown, selection: unknown) => selection ? { operationId: "CORRECTION-ROUTING", generation: 1, agentId: "supervisor:test", materialized: true, selection } : undefined),
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
vi.mock("../src/security/executionLease.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/security/executionLease.js")>();
  return {
    ...orig,
    prepareExecutionAuthority: mocks.prepareAuthority,
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
  mocks.setupToolchain.mockClear();
  mocks.resolveBlocker.mockReset();
  mocks.prepareAuthority.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const ESCAPING_FILE = "tests/new-declared.test.ts";

function initialSession(): WorkerSession {
  // Attempt 1 implements the file but never declares it: the ChangeSet
  // escapes scope and the single correction turn is offered.
  const stdout = `AEH_RESULT_JSON=${JSON.stringify({
    filesChanged: [ESCAPING_FILE],
    behaviorImplemented: ["wrote the new test file"],
    decisions: [],
    assumptions: [],
    risks: [],
    validationCommands: [],
    followUp: [],
  })}`;
  return session("Implementer", "participant:initial", stdout);
}

function correctionSession(): WorkerSession {
  // Textbook declare-first correction: no changes, exact declarations.
  const stdout = `AEH_RESULT_JSON=${JSON.stringify({
    filesChanged: [],
    behaviorImplemented: [],
    decisions: [],
    assumptions: [],
    risks: [],
    validationCommands: [],
    followUp: ["request lead-approved scope amendment, then retry"],
    filesNeededOutsideScope: [{ path: ESCAPING_FILE, reason: "new test file required by acceptance" }],
  })}`;
  return session("Implementer", "participant:correction", stdout);
}

function blockedResolution() {
  return async () => {
    const { repairScopeBlockerValidationCheck } = await import("../src/candidates/repairScope.js");
    return {
      status: "BLOCKED" as const,
      blocker: mocks.resolveBlocker.mock.calls[0][0].blocker,
      check: repairScopeBlockerValidationCheck(mocks.resolveBlocker.mock.calls[0][0].blocker),
    };
  };
}

function amendedResolution() {
  return async (input: { contract: TaskContract }) => ({
    status: "AMENDED" as const,
    contract: {
      ...input.contract,
      scope: { ...(input.contract.scope ?? {}), allowed: [...(input.contract.scope?.allowed ?? []), ESCAPING_FILE] },
    } as TaskContract,
    amendment: {
      exemptedPaths: [ESCAPING_FILE],
      decisionId: "decision:00000000-0000-4000-8000-000000000000",
      requestId: "request:correction-amended",
      decidedActor: "human:test",
    },
  });
}

describe("DIRECT escape-correction declaration routing (behavioral)", () => {
  it("correction DECLINED stays terminal: no validation, no Repairer, attempts 0", async () => {
    const { root, task, config } = await setup("CORRECTION-DECLINED-1");
    // Attempt 1 writes the escaping file into its isolated root.
    mocks.start.mockImplementation(async (isolatedRoot: string) => {
      await fs.mkdir(path.join(isolatedRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(isolatedRoot, ESCAPING_FILE), "export const x = 1;\n");
      return initialSession();
    });
    // Correction declares (no changes); any later agent prompt is a Repairer
    // turn and must never run while BLOCKED.
    mocks.executeAgentPrompt.mockImplementationOnce(async () => correctionSession());
    mocks.executeAgentPrompt.mockImplementation(async () => {
      throw new Error("REPAIR_TURN_RAN_WHILE_BLOCKED: Repairer executed while correction resolution is BLOCKED");
    });
    mocks.resolveBlocker.mockImplementation(blockedResolution());

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    expect(mocks.resolveBlocker).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("FAIL");
    expect(result.attempts).toBe(0);
    expect(result.report.checks).toContainEqual(expect.objectContaining({ id: "repair.scope-blocker", status: "FAIL" }));
    expect(result.report.checks.find((c) => c.id === "repair.scope-blocker")?.message).toContain(ESCAPING_FILE);
    // Suspend boundary: exactly one agent turn (the correction), no
    // validation workspace prep, no Repairer turn.
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.setupToolchain).not.toHaveBeenCalled();
  });

  it("correction AMENDED proceeds to validation with the exemption (no blocker check)", async () => {
    const { root, task, config } = await setup("CORRECTION-AMENDED-1");
    mocks.start.mockImplementation(async (isolatedRoot: string) => {
      await fs.mkdir(path.join(isolatedRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(isolatedRoot, ESCAPING_FILE), "export const x = 1;\n");
      return initialSession();
    });
    mocks.executeAgentPrompt.mockImplementationOnce(async () => correctionSession());
    mocks.executeAgentPrompt.mockImplementation(async (_root: string, _cfg: unknown, _contract: unknown, sel: { role: string; logicalAgent: string }, _prompt: string, opts: { participantId?: string }) => {
      return session(sel.logicalAgent, opts.participantId);
    });
    mocks.resolveBlocker.mockImplementation(amendedResolution());

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    expect(mocks.resolveBlocker).toHaveBeenCalledTimes(1);
    // AMENDED proceeds to validation (workspace prep ran) — unlike BLOCKED.
    expect(mocks.setupToolchain).toHaveBeenCalled();
    // The run did NOT take the BLOCKED early-return: no blocker check.
    expect(result.report.checks.find((c) => c.id === "repair.scope-blocker")).toBeUndefined();
  });

  it("correction re-escape with covering declarations amends and re-assembles (carve-out applies the patch)", async () => {    const { root, task, config } = await setup("CORRECTION-REESCAPE-1");
    mocks.start.mockImplementation(async (isolatedRoot: string) => {
      await fs.mkdir(path.join(isolatedRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(isolatedRoot, ESCAPING_FILE), "export const x = 1;\n");
      return initialSession();
    });
    // The correction rewrites the file (mechanical diff escapes again) while
    // its result envelope declares exactly that file (filesChanged empty):
    // covered re-escape routes to amendment instead of the original kill.
    mocks.executeAgentPrompt.mockImplementationOnce(async (correctionRoot: string) => {
      await fs.mkdir(path.join(correctionRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(correctionRoot, ESCAPING_FILE), "export const x = 1;\n");
      return correctionSession();
    });
    mocks.executeAgentPrompt.mockImplementation(async (_root: string, _cfg: unknown, _contract: unknown, sel: { role: string; logicalAgent: string }, _prompt: string, opts: { participantId?: string }) => {
      return session(sel.logicalAgent, opts.participantId);
    });
    mocks.resolveBlocker.mockImplementation(amendedResolution());

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    expect(mocks.resolveBlocker).toHaveBeenCalledTimes(1);
    // Re-assembly succeeded against the amended scope: validation runs and
    // the amended file is in the delivered change set.
    expect(mocks.setupToolchain).toHaveBeenCalled();
    expect(result.report.checks.find((c) => c.id === "repair.scope-blocker")).toBeUndefined();
    expect(result.report.changedFiles.join(",")).toContain(ESCAPING_FILE);
  });

  it("correction touching an UNDECLARED extra path stays terminal (no laundering, no routing)", async () => {
    const UNDECLARED_FILE = "tests/undeclared-extra.test.ts";
    const { root, task, config } = await setup("CORRECTION-UNDECLARED-1");
    mocks.start.mockImplementation(async (isolatedRoot: string) => {
      await fs.mkdir(path.join(isolatedRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(isolatedRoot, ESCAPING_FILE), "export const x = 1;\n");
      return initialSession();
    });
    // The correction declares file A but its patch also touches file B,
    // which it did not declare: partial coverage must not route or
    // authorize anything — the original escape kill stands terminal.
    mocks.executeAgentPrompt.mockImplementationOnce(async (correctionRoot: string) => {
      await fs.mkdir(path.join(correctionRoot, "tests"), { recursive: true });
      await fs.writeFile(path.join(correctionRoot, ESCAPING_FILE), "export const x = 1;\n");
      await fs.writeFile(path.join(correctionRoot, UNDECLARED_FILE), "export const y = 2;\n");
      return correctionSession();
    });
    mocks.executeAgentPrompt.mockImplementation(async () => {
      throw new Error("REPAIR_TURN_RAN_AFTER_UNDECLARED_ESCAPE: no turn may run after an undeclared re-escape");
    });
    mocks.resolveBlocker.mockImplementation(async () => {
      throw new Error("RESOLVER_CALLED_FOR_UNDECLARED_ESCAPE: undeclared escapes must never reach the amendment channel");
    });

    let failure: unknown;
    try {
      await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });
    } catch (error) {
      failure = error;
    }
    expect(String((failure as Error)?.message ?? failure)).toMatch(/ChangeSet escaped its assigned scope/);
    // Terminal kill names the FIRST escape per the single-correction
    // convention (second escape rethrows the original); the guarantee
    // pinned here is that the undeclared extra path is never routed
    // (resolver silent), never validated, and no turn runs after.
    expect(mocks.resolveBlocker).not.toHaveBeenCalled();
    expect(mocks.setupToolchain).not.toHaveBeenCalled();
    // Exactly one agent turn (the correction); nothing runs after.
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
  });
});

async function setup(operationId: string): Promise<{ root: string; task: TaskContract; config: HarnessProjectConfig }> {
  const root = await createProject();
  const task = taskContract();
  const config = projectConfig();
  await writeProjectInputs(root, task);
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });

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
    intent: "correction routing",
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
  return { root, task, config };
}

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-correction-routing-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }, null, 2));
  return root;
}

function taskContract(): TaskContract {
  return {
    version: 1,
    task: { id: "CORRECTION-TASK", title: "Correction routing" },
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
    project: { name: "correction-routing-test" },
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
      reviewer: { role: "Reviewer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "deny", review: "allow" } },
      "operation-supervisor": { role: "Operation Supervisor", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "deny", delegate: "allow" } },
      repairer: { role: "Repairer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "allow", shell: "allow", delegate: "deny" }, outputContract: "implementer" },
    },
    routing: [{ id: "default", when: { intent: "implement" }, select: { role: "Implementer" }, review: [{ role: "Reviewer" }] }]
  };
  await fs.writeFile(path.join(root, config.agents!.configPath!), JSON.stringify(agents, null, 2));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
