import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  legacyRepair: vi.fn(),
  executeAgentPrompt: vi.fn()
}));

vi.mock("../src/workers/factory.js", () => ({
  createWorkerExecutor: () => ({
    name: "test-worker",
    doctor: async () => ({ ok: true, message: "test worker" }),
    start: mocks.start,
    repair: mocks.legacyRepair
  })
}));

vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/operations/supervisor.js", () => ({
  ensureOperationSupervisor: vi.fn(async (_root, _config, _contract, selection) => selection ? { operationId: "RUN-REPAIR-PUBLIC", generation: 1, agentId: "supervisor:test", materialized: true, selection } : undefined),
  maybeRotateOperationSupervisor: vi.fn(async () => undefined),
  settleDrainingSupervisorGenerations: vi.fn(async () => undefined),
  consolidateWithOperationSupervisor: vi.fn(async (_root, _config, _contract, _selection, input) => ({
    output: { summary: "test consolidation", consolidatedFindings: input.findings, sourceFindingIds: input.findings.map((finding: { id: string }) => finding.id), conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" },
    artifact: "test-consolidation.json",
    session: session("operation-supervisor", "participant:supervisor")
  }))
}));

import YAML from "yaml";
import { runTask } from "../src/core/run.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { loadOperation, saveOperation } from "../src/operations/state.js";
import { runShell } from "../src/utils/process.js";
import { semanticPayload, semanticTestAssessor, semanticTestService } from "./semanticAssessmentSupport.js";
import { semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { bindResolvedOperationPolicy, currentControllerEpoch } from "../src/operations/state.js";
import { sha256Canonical } from "../src/core/digest.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  mocks.start.mockReset();
  mocks.legacyRepair.mockReset();
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("public runTask Repairer candidate lifecycle", () => {
  it("repairs validation failures through an isolated Repairer ChangeSet and validates the new revision", async () => {
    const root = await createProject();
    const task = taskContract();
    const config = projectConfig();
    await writeProjectInputs(root, task);
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });

    const operationId = "RUN-REPAIR-PUBLIC";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: candidate.projectId ?? config.project.name,
      operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(operation),
      intent: "repair a validation failure",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" },
      policyDigests: { validation: sha256Canonical(task.verification ?? {}), review: sha256Canonical({ independentReviewRequired: false }) },
      validationPolicy: task.verification ?? {},
      reviewPolicy: { minimumAssurance: "STANDARD", independentReviewRequired: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: { mode: "disabled" },
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    }));
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;

    mocks.start.mockResolvedValue(session("implementer", "participant:initial"));
    mocks.executeAgentPrompt.mockImplementation(async (agentRoot: string, _config: HarnessProjectConfig, _contract: TaskContract, selection: { role: string; logicalAgent: string }, _prompt: string, options: { participantId?: string }) => {
      if (selection.role === "Repairer") {
        await fs.writeFile(path.join(agentRoot, "src", "value.ts"), "export const value = 2;\n");
        return session(selection.logicalAgent, options.participantId);
      }
      if (selection.role === "Reviewer") return { ...session(selection.logicalAgent, options.participantId), stdout: `AEH_RESULT_JSON=${JSON.stringify({ verdict: "PASS", findings: [], finalizationSafety: "SAFE" })}` };
      throw new Error(`Unexpected prompt role ${selection.role}.`);
    });

    const result = await runTask(root, config, task, { semanticRuntime: testSemanticRuntime() });

    expect(result.status).toBe("PASS");
    expect(result.report.candidate?.revision).toBe(2);
    expect(result.report.candidate?.sourceDigest).toBe(await computeWorktreeDigest(root));
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.executeAgentPrompt.mock.calls[0]?.[3]).toMatchObject({ role: "Repairer", logicalAgent: "repairer" });
    expect(mocks.executeAgentPrompt.mock.calls[1]?.[3]).toMatchObject({ role: "Reviewer", logicalAgent: "reviewer" });
    expect(mocks.executeAgentPrompt.mock.calls[1]?.[4]).toContain("behavior.correctness");
    expect(result.candidateAssurance?.compilation).toMatchObject({ status: "READY", candidate: { revision: 2 }, reviewAssignments: [expect.objectContaining({ reviewerIdentity: "reviewer", dimensions: ["behavior.correctness"] })] });
    expect(result.candidateAssurance?.validationChecks.every((check) => check.status === "PASS")).toBe(true);
    expect(mocks.legacyRepair).not.toHaveBeenCalled();
  });

  it("fails closed when candidate repair has no compiled Repairer authority", async () => {
    const root = await createProject();
    const task = taskContract();
    const config = projectConfig(false);
    await writeProjectInputs(root, task, false);
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
    const operationId = "RUN-REPAIR-NO-AUTHORITY";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;
    mocks.start.mockResolvedValue(session("implementer", "participant:initial"));

    await expect(runTask(root, config, task, { semanticRuntime: testSemanticRuntime() })).rejects.toThrow("REPAIR_AUTHORITY_REQUIRED");
    expect(mocks.legacyRepair).not.toHaveBeenCalled();
  });
});

function session(logicalAgent: string, participantId?: string): WorkerSession {
  return { provider: "test", logicalAgent, participantId, exitCode: 0, stdout: "", stderr: "" };
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-run-repair-") );
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.readFileSync('src/value.ts','utf8').includes('value = 2') ? 0 : 1);\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }, null, 2));
  return root;
}

function taskContract(): TaskContract {
  return {
    version: 1,
    task: { id: "REPAIR-TASK", title: "Repair a validation failure" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", profile: "test", route: "DIRECT", assurance: "STANDARD" },
    repair: { maxAttempts: 1 },
    verification: { commands: [{ id: "candidate-check", command: "node check.mjs" }] }
  };
}

function projectConfig(includeRepairer = true): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "run-repair-test" },
    agents: { configPath: ".harness/agents.source.jsonc", activeProfile: "test", required: true },
    sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    orchestration: { worker: { maxRepairAttempts: 1 } },
    controlPlane: { required: false },
    telemetry: { enabled: false }
  } as HarnessProjectConfig;
}

async function writeProjectInputs(root: string, contract: TaskContract, includeRepairer = true): Promise<void> {
  await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "contracts", `${contract.task.id}.yaml`), YAML.stringify(contract));
  const config = projectConfig(includeRepairer);
  const agents = JSON.parse(JSON.stringify({
    version: 1,
    activeProfile: "test",
    profiles: { test: {} },
    runtimes: { test: { adapter: "codex", capabilities: {} } },
    models: { test: { runtime: "test", provider: "test", model: "fake" } },
    agents: {
      implementer: { role: "Implementer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "allow", shell: "allow", delegate: "deny" } },
      reviewer: { role: "Reviewer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "allow", review: "allow" } },
      "operation-supervisor": { role: "Operation Supervisor", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "deny", shell: "allow", delegate: "allow" } },
      ...(includeRepairer ? { repairer: { role: "Repairer", execution: { model: "@test", transport: "direct" }, permissions: { read: "allow", write: "allow", shell: "allow", delegate: "deny" }, outputContract: "implementer" } } : {})
    },
    routing: [{ id: "default", when: { intent: "implement" }, select: { role: "Implementer" }, review: [{ role: "Reviewer" }] }]
  }));
  await fs.writeFile(path.join(root, config.agents!.configPath!), JSON.stringify(agents, null, 2));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
