import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ materializeManagedPaseoAgent: vi.fn(), launchManagedPaseoAgent: vi.fn(), continueManagedPaseoAgent: vi.fn(), runDirectWorkerProcess: vi.fn(), runExecutable: vi.fn(), runShell: vi.fn(), prepareOpenCodeSession: vi.fn(), prepareCodexThread: vi.fn() }));
vi.mock("../src/paseo/runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/paseo/runtime.js")>(),
  materializeManagedPaseoAgent: runtime.materializeManagedPaseoAgent,
  launchManagedPaseoAgent: runtime.launchManagedPaseoAgent,
  continueManagedPaseoAgent: runtime.continueManagedPaseoAgent,
  stopManagedPaseoAgent: vi.fn()
}));
vi.mock("../src/workers/directProcess.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/workers/directProcess.js")>(), runDirectWorkerProcess: runtime.runDirectWorkerProcess }));
vi.mock("../src/workers/runtimeSessions.js", () => ({ prepareOpenCodeSession: runtime.prepareOpenCodeSession, prepareCodexThread: runtime.prepareCodexThread }));
vi.mock("../src/utils/process.js", () => ({ runExecutable: runtime.runExecutable, runShell: runtime.runShell, commandExists: vi.fn().mockResolvedValue(true) }));

import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { auditContract } from "../src/audit/run.js";
import { bindResolvedOperationPolicy, currentControllerEpoch, loadOperation, registerOperationAgent } from "../src/operations/state.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";
import { prepareAgentExecutionIdentity } from "../src/workers/agentPrompt.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const roots: string[] = [];
const originalEnv = {
  AEH_OPERATION_ID: process.env.AEH_OPERATION_ID,
  AEH_OPERATION_KIND: process.env.AEH_OPERATION_KIND,
  AEH_CONTROL_ROOT: process.env.AEH_CONTROL_ROOT
};

beforeEach(() => {
  runtime.runExecutable.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
  runtime.runShell.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  runtime.materializeManagedPaseoAgent.mockReset();
  runtime.launchManagedPaseoAgent.mockReset();
  runtime.continueManagedPaseoAgent.mockReset();
  runtime.runDirectWorkerProcess.mockReset();
  runtime.runExecutable.mockReset();
  runtime.runShell.mockReset();
  runtime.prepareOpenCodeSession.mockReset();
  runtime.prepareCodexThread.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function reviewerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "security-reviewer",
    role: "Reviewer",
    domains: [],
    runtimeName: "codex",
    runtimeAdapter: "codex",
    paseoProvider: "codex",
    modelAlias: "test-model",
    modelId: "test-model",
    modelName: "test-model",
    modelProvider: "openai",
    transport: "paseo",
    skills: [],
    mcps: [],
    permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
    outputContract: "reviewer",
    args: [],
    runtimeCapabilities: { structuredOutput: true, sessions: true, mcp: true, stdioMcp: true, localMcp: true }
  } as unknown as AgentExecutionSelection;
}

describe("audit file-less scope default (D3)", () => {
  it("defaults a file-less audit contract to full [\"**\"] scope", () => {
    expect(auditContract("AUDIT-1", { request: "review the whole repository" }, "HEAD").scope?.allowed).toEqual(["**"]);
  });

  it("defaults an explicitly empty files list to full [\"**\"] scope", () => {
    expect(auditContract("AUDIT-2", { request: "review the whole repository", files: [] }, "HEAD").scope?.allowed).toEqual(["**"]);
  });

  it("preserves explicit audit files", () => {
    expect(auditContract("AUDIT-3", { request: "review auth", files: ["src/auth.ts"] }, "HEAD").scope?.allowed).toEqual(["src/auth.ts"]);
  });

  it("compiles reviewer execution identity for the defaulted file-less contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-audit-scope-default-"));
    roots.push(root);
    const operationId = "AUDIT-SCOPE-DEFAULT";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = root;
    const now = new Date().toISOString();
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "audit", status: "RUNNING", phase: "supervision", root, payload: { request: "review the whole repository" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
    await registerOperationAgent(root, operationId, { id: "participant:security-reviewer", logicalAgent: "security-reviewer", role: "Reviewer", phase: "review" });
    let operation = await loadOperation(root, operationId);
    operation = await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: operation.candidateRevision!.projectId!, operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: operation.candidateRevision!.revision,
      candidateDigest: operation.candidateRevision!.identityDigest,
      controllerEpoch: currentControllerEpoch(operation), intent: "audit scope default test", route: "DELEGATED", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
      allowedExternalEffects: [], humanDecisionRequirements: []
    }));
    const participantId = "participant:security-reviewer";
    const selection = reviewerSelection();
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const config: HarnessProjectConfig = { version: 1, project: { name: "audit-scope-default-test" }, orchestration: { provider: "paseo" } };
    const contract = auditContract(operationId, { request: "review the whole repository" }, "HEAD");

    const identity = await prepareAgentExecutionIdentity(root, config, contract, selection, "Review the repository and report typed findings.", {
      outputContract: "reviewer",
      phase: "review",
      operationKind: "audit",
      participantId,
      capabilityAuthority
    });

    expect(identity.roleInvocationPolicy.scope).toEqual(["**"]);
  });

  it("still rejects an empty-scope contract at the deterministic gate (control)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-audit-scope-control-"));
    roots.push(root);
    const operationId = "AUDIT-SCOPE-CONTROL";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = root;
    const now = new Date().toISOString();
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "audit", status: "RUNNING", phase: "supervision", root, payload: { request: "review the whole repository" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
    await registerOperationAgent(root, operationId, { id: "participant:security-reviewer", logicalAgent: "security-reviewer", role: "Reviewer", phase: "review" });
    let operation = await loadOperation(root, operationId);
    operation = await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: operation.candidateRevision!.projectId!, operationId,
      operationExecutionRevision: operation.operationExecutionRevision!,
      candidateRevision: operation.candidateRevision!.revision,
      candidateDigest: operation.candidateRevision!.identityDigest,
      controllerEpoch: currentControllerEpoch(operation), intent: "audit scope control test", route: "DELEGATED", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
      allowedExternalEffects: [], humanDecisionRequirements: []
    }));
    const participantId = "participant:security-reviewer";
    const selection = reviewerSelection();
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const config: HarnessProjectConfig = { version: 1, project: { name: "audit-scope-control-test" }, orchestration: { provider: "paseo" } };
    const emptyScope: TaskContract = {
      ...auditContract(operationId, { request: "review the whole repository" }, "HEAD"),
      scope: { allowed: [] }
    };

    await expect(prepareAgentExecutionIdentity(root, config, emptyScope, selection, "Review the repository and report typed findings.", {
      outputContract: "reviewer",
      phase: "review",
      operationKind: "audit",
      participantId,
      capabilityAuthority
    })).rejects.toThrow("ROLE_INVOCATION_POLICY_INVALID");
  });
});
