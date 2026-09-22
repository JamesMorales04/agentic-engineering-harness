import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ materializeManagedPaseoAgent: vi.fn(), launchManagedPaseoAgent: vi.fn(), continueManagedPaseoAgent: vi.fn(), runDirectWorkerProcess: vi.fn(), runExecutable: vi.fn(), runShell: vi.fn(), prepareOpenCodeSession: vi.fn(), prepareCodexThread: vi.fn() }));
vi.mock("../src/paseo/runtime.js", () => ({
  materializeManagedPaseoAgent: runtime.materializeManagedPaseoAgent,
  launchManagedPaseoAgent: runtime.launchManagedPaseoAgent,
  continueManagedPaseoAgent: runtime.continueManagedPaseoAgent,
  stopManagedPaseoAgent: vi.fn()
}));
vi.mock("../src/workers/directProcess.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/workers/directProcess.js")>(), runDirectWorkerProcess: runtime.runDirectWorkerProcess }));
vi.mock("../src/workers/runtimeSessions.js", () => ({ prepareOpenCodeSession: runtime.prepareOpenCodeSession, prepareCodexThread: runtime.prepareCodexThread }));
vi.mock("../src/utils/process.js", () => ({ runExecutable: runtime.runExecutable, runShell: runtime.runShell, commandExists: vi.fn().mockResolvedValue(true) }));

import { outputJsonSchema } from "../src/agents/outputContracts.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { compileExecutionBinding, compileSkillManifest, type ExecutionBindingV2, type SkillManifestScopeV1, type SkillManifestV1 } from "../src/architecture/executionIdentity.js";
import { applySkillTrustGate, knowledgePack, type KnowledgeGapV1 } from "../src/knowledge/index.js";
import { loadOperation, registerOperationAgent, saveOperation } from "../src/operations/state.js";
import { createPromptManifest } from "../src/context/runtimeV2.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";
import { executeAgentPrompt, prepareAgentExecutionBinding } from "../src/workers/agentPrompt.js";
import { structuredResultProvenanceForAgent } from "../src/workers/resultGateway.js";

const roots: string[] = [];
const originalEnv = {
  AEH_OPERATION_ID: process.env.AEH_OPERATION_ID,
  AEH_OPERATION_KIND: process.env.AEH_OPERATION_KIND,
  AEH_CONTROL_ROOT: process.env.AEH_CONTROL_ROOT
};

beforeEach(() => {
  runtime.materializeManagedPaseoAgent.mockResolvedValue({ id: "paseo-provider-session-test", exitCode: 0, stdout: "", stderr: "", transport: "sdk", status: "idle" });
  runtime.continueManagedPaseoAgent.mockResolvedValue({ id: "paseo-provider-session-test", exitCode: 0, stdout: JSON.stringify({ verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }), stderr: "", transport: "sdk", status: "idle" });
  runtime.runExecutable.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
  runtime.runShell.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
  runtime.prepareOpenCodeSession.mockResolvedValue("opencode-session-test");
  runtime.prepareCodexThread.mockResolvedValue("codex-thread-test");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  runtime.launchManagedPaseoAgent.mockReset();
  runtime.materializeManagedPaseoAgent.mockReset();
  runtime.continueManagedPaseoAgent.mockReset();
  runtime.runDirectWorkerProcess.mockReset();
  runtime.runExecutable.mockReset();
  runtime.runShell.mockReset();
  runtime.prepareOpenCodeSession.mockReset();
  runtime.prepareCodexThread.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("public Paseo launch result provenance", () => {
  it("binds the actual public structured-result launch to the complete v2 execution identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-agent-result-provenance-"));
    roots.push(root);
    const operationId = "RUN-RESULT-LAUNCH";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_CONTROL_ROOT = root;
    const now = new Date().toISOString();
    await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: "TASK-LAUNCH" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
    await registerOperationAgent(root, operationId, { id: "participant:security-reviewer", logicalAgent: "security-reviewer", role: "Reviewer", phase: "review" });
    const operation = await loadOperation(root, operationId);
    const candidate = operation.candidateRevision!;
    const selection: AgentExecutionSelection = {
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
    };
    const config: HarnessProjectConfig = { version: 1, project: { name: "result-provenance-test" }, orchestration: { provider: "paseo" } };
    const contract: TaskContract = { version: 1, task: { id: "TASK-LAUNCH", title: "Review result provenance" }, routing: { route: "DIRECT", assurance: "STANDARD", intent: "audit" }, scope: { allowed: ["src/**"] } };
    const participantId = "participant:security-reviewer";
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId }, ["Check the source claim exactly.", "Record the evidence digest."], "security-review");
    selection.permissions.read = "allow";
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const wrongParticipantAuthority = await prepareExecutionAuthority(root, selection, { participantId: "participant:other-reviewer", phase: "review", required: true });
    if (!wrongParticipantAuthority) throw new Error("test requires a second controller-issued participant authority");
    runtime.materializeManagedPaseoAgent.mockImplementation(async (_root: string, options: { labels: Record<string, string>; prompt?: string; mcpServers?: Record<string, unknown>; toolPolicy?: { preapproved: Array<{ kind: string; server: string; tool: string }> } }) => {
      expect(options.labels["aeh.result.provenance"]).toBeUndefined();
      expect(options.prompt).toBeUndefined();
      expect(options.labels["aeh.execution.binding.phase"]).toBe("PENDING_SESSION");
      expect(options.labels["aeh.result.channel"]).toBeTruthy();
      expect(options.mcpServers?.["aeh-result"]).toBeTruthy();
      expect(options.toolPolicy?.preapproved).toContainEqual({ kind: "mcp", server: "aeh-result", tool: "aeh_submit_result" });
      return { id: "paseo-actual-provider-agent", exitCode: 0, stdout: "", stderr: "", transport: "sdk", status: "idle" };
    });
    runtime.continueManagedPaseoAgent.mockImplementation(async (_root: string, agentId: string, prompt: string, _timeout: number, _deps: unknown, _schema: unknown, labels: Record<string, string>) => {
      expect(agentId).toBe("paseo-actual-provider-agent");
      expect(prompt).toContain("Check the source claim exactly.\nRecord the evidence digest.");
      expect(labels["aeh.execution.binding.phase"]).toBe("BOUND");
      expect(JSON.parse(labels["aeh.execution.binding"]!).runtime.sessionId).toBe(agentId);
      expect(JSON.parse(labels["aeh.result.provenance"]!).runtime.sessionId).toBe(agentId);
      const provenance = await structuredResultProvenanceForAgent(root, agentId);
      expect(provenance).toMatchObject({ status: "BOUND", runtime: { sessionId: agentId }, executionBinding: { runtime: { sessionId: agentId } } });
      return { id: agentId, exitCode: 0, stdout: JSON.stringify({ verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }), stderr: "", transport: "sdk", status: "idle" };
    });

    const result = await executeAgentPrompt(root, config, contract, selection, "Review the candidate and report a typed result.", {
      outputContract: "reviewer",
      phase: "review",
      participantId,
      skillManifest,
      capabilityAuthority,
    });

    expect(result?.id).toBe("paseo-actual-provider-agent");
    expect(runtime.materializeManagedPaseoAgent).toHaveBeenCalledBefore(runtime.continueManagedPaseoAgent);
    const provenance = await structuredResultProvenanceForAgent(root, "paseo-actual-provider-agent") as unknown as Record<string, unknown>;
    expect(provenance).toEqual(expect.objectContaining({
      status: "BOUND",
      projectId: candidate.projectId,
      operationId,
      operationRevision: expect.any(Number),
      participantId,
      participantGeneration: expect.any(String),
      logicalAgent: "security-reviewer",
      role: "Reviewer",
      taskId: "TASK-LAUNCH",
      candidate: expect.objectContaining({ identityDigest: candidate.identityDigest }),
      controllerEpoch: 0,
      runtime: expect.objectContaining({ provider: "openai", model: "test-model", runtimeId: "codex", sessionId: expect.any(String) }),
      outputContract: "reviewer",
      outputSchemaDigest: sha256Canonical(outputJsonSchema("reviewer")),
      executionBlueprintDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      resolvedOperationPolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      unsupported: []
    }));
    expect(provenance.executionBinding).toEqual(expect.objectContaining({
      version: 2,
      operationId,
      operationExecutionRevision: 1,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: 0,
      participantId,
      participantGeneration: expect.any(String),
      contextManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputContract: "reviewer"
    }));
    expect(operation.revision).toBeLessThan(provenance.operationRevision as number);
    await expect(executeAgentPrompt(root, config, contract, selection, "Review the candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest, capabilityAuthority: wrongParticipantAuthority
    })).rejects.toThrow("SKILL_MANIFEST_ASSIGNMENT_MISMATCH");
  });

  it.each(["direct", "podman"] as const)("propagates the same full binding through the %s production launch envelope", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-RESULT-${transport.toUpperCase()}`, transport);
    const structured = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
    runtime.runDirectWorkerProcess.mockResolvedValue({ exitCode: 0, stdout: runtimeSessionOutput("codex-thread-test", structured), stderr: "" });
    runtime.runExecutable.mockImplementation(async (command: string) => command === "podman"
      ? { exitCode: 0, stdout: runtimeSessionOutput("opencode-session-test", structured), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" });

    const result = await executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer",
      phase: "review",
      participantId,
      capabilityAuthority: { version: 1, operationId, participantId, projectId: candidate.projectId, candidateRevision: candidate, candidateDigest: candidate.identityDigest, controllerEpoch: 0, leases: [] }
    });
    const binding = result.executionBinding as unknown as Record<string, unknown>;
    expect(binding).toEqual(expect.objectContaining({ version: 2, operationId, participantId, candidateDigest: candidate.identityDigest, contextManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), promptManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    if (transport === "direct") {
      const env = runtime.runDirectWorkerProcess.mock.calls[0]?.[3]?.environment as Record<string, string>;
      expect(JSON.parse(env.AEH_EXECUTION_BINDING!)).toEqual(binding);
      expect(runtime.prepareCodexThread).toHaveBeenCalledOnce();
      const prepared = runtime.prepareCodexThread.mock.calls[0]?.[0] as { model: string; home: { directory: string } };
      const launch = runtime.runDirectWorkerProcess.mock.calls[0]?.[3] as { homeDirectory?: string; environment?: Record<string, string> };
      expect(prepared.model).toBe(selection.modelName);
      expect(launch.environment?.CODEX_HOME).toBe(prepared.home.directory);
      expect(launch.homeDirectory).toBe(prepared.home.directory);
    } else {
      const args = runtime.runExecutable.mock.calls.find((call) => call[0] === "podman")?.[1] as string[];
      expect(args.some((arg) => arg === `AEH_EXECUTION_BINDING=${JSON.stringify(binding)}`)).toBe(true);
      expect(runtime.prepareOpenCodeSession).toHaveBeenCalledOnce();
      const prepared = runtime.prepareOpenCodeSession.mock.calls[0]?.[0] as { home: { directory: string } };
      expect(args).toContain(`${prepared.home.directory}:/home/aeh:rw`);
    }
  });

  it("materializes and reuses the actual OpenCode direct session before binding", async () => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture("RUN-OPENCODE-DIRECT-SESSION", "direct");
    selection.runtimeName = "opencode";
    selection.runtimeAdapter = "opencode";
    selection.modelId = "openai/gpt-test";
    runtime.prepareOpenCodeSession.mockResolvedValue("opencode-provider-session");
    runtime.runDirectWorkerProcess.mockResolvedValue({ exitCode: 0, stdout: runtimeSessionOutput("opencode-provider-session", { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }), stderr: "" });

    const result = await executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId,
      capabilityAuthority: { version: 1, operationId, participantId, projectId: candidate.projectId, candidateRevision: candidate, candidateDigest: candidate.identityDigest, controllerEpoch: 0, leases: [] }
    });

    expect(runtime.prepareOpenCodeSession).toHaveBeenCalledOnce();
    const args = runtime.runDirectWorkerProcess.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("opencode-provider-session");
    expect(result.id).toBe("opencode-provider-session");
    expect(result.executionBinding?.runtime.sessionId).toBe("opencode-provider-session");
  });

  it.each(["direct", "podman", "paseo"] as const)("rejects a missing or different actual session returned by %s", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-SESSION-MISMATCH-${transport.toUpperCase()}`, transport);
    const structured = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
    if (transport === "direct") runtime.runDirectWorkerProcess.mockResolvedValue({ exitCode: 0, stdout: runtimeSessionOutput("different-codex-thread", structured), stderr: "" });
    if (transport === "podman") runtime.runExecutable.mockImplementation(async (command: string) => command === "podman"
      ? { exitCode: 0, stdout: runtimeSessionOutput("different-opencode-session", structured), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" });
    if (transport === "paseo") runtime.continueManagedPaseoAgent.mockResolvedValue({ id: "different-paseo-agent", exitCode: 0, stdout: JSON.stringify(structured), stderr: "", transport: "sdk", status: "idle" });
    const authority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!authority) throw new Error("test requires current participant authority");

    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId,
      capabilityAuthority: { ...authority, candidateRevision: candidate, candidateDigest: candidate.identityDigest }
    })).rejects.toThrow("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH");
  });

  it("fails closed before first prompt when Paseo cannot materialize a provider session id", async () => {
    const { root, selection, config, contract, participantId } = await launchFixture("RUN-PASEO-SESSION-ID-MISSING", "paseo");
    runtime.materializeManagedPaseoAgent.mockResolvedValue({ id: undefined, exitCode: 0, stdout: "", stderr: "", transport: "sdk", status: "idle" });
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", { outputContract: "reviewer", phase: "review", participantId }))
      .rejects.toThrow("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED");
    expect(runtime.continueManagedPaseoAgent).not.toHaveBeenCalled();
    expect(runtime.launchManagedPaseoAgent).not.toHaveBeenCalled();
  });

  it.each(["direct", "podman", "paseo"] as const)("rejects replayed and altered identity across the %s production launch boundary", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-REJECT-${transport.toUpperCase()}`, transport);
    const authority = { version: 1 as const, operationId, participantId, projectId: candidate.projectId, candidateRevision: candidate, candidateDigest: candidate.identityDigest, controllerEpoch: 0, leases: [] };
    const prepared = await import("../src/workers/agentPrompt.js").then(({ prepareAgentExecutionBinding }) => prepareAgentExecutionBinding(
      root, config, contract, selection, "Review this exact candidate.", { participantId, phase: "review", capabilityAuthority: authority, executionSessionId: "fixture-runtime-session" }
    ));
    const { version: _version, digest: _digest, ...base } = prepared.binding;
    const cases = [
      { name: "candidate", change: { candidateRevision: prepared.binding.candidateRevision + 1, candidateDigest: "d".repeat(64) } },
      { name: "operation execution revision", change: { operationExecutionRevision: prepared.binding.operationExecutionRevision + 1 } },
      { name: "generation", change: { participantGeneration: "generation:replay" } },
      { name: "epoch", change: { controllerEpoch: prepared.binding.controllerEpoch + 1 } },
      { name: "policy", change: { operationPolicyDigest: "e".repeat(64) } },
      { name: "blueprint", change: { executionBlueprintDigest: "f".repeat(64) } },
      { name: "role policy", change: { roleInvocationPolicyDigest: "a".repeat(64) } },
      { name: "skill", change: { skillManifestDigest: "b".repeat(64) } },
      { name: "context", change: { contextManifestDigest: "c".repeat(64) } },
      { name: "prompt", change: { promptManifestDigest: "d".repeat(64) } },
      { name: "output contract", change: { outputContract: "implementer" } },
      { name: "runtime", change: { runtime: { ...prepared.binding.runtime, modelId: "other-model" } } },
      { name: "session", change: { runtime: { ...prepared.binding.runtime, sessionId: "other-session" } } },
      { name: "lease", change: { leaseIdentities: ["lease:other"] } }
    ];
    for (const item of cases) {
      const executionBinding = compileExecutionBinding({ ...base, ...item.change } as typeof base);
      await expect(executeAgentPrompt(root, config, contract, selection, "Review this exact candidate.", {
        outputContract: "reviewer", phase: "review", participantId, capabilityAuthority: authority, preparedPrompt: prepared.prompt, contextManifest: prepared.contextManifest,
        contextManifestDigest: prepared.binding.contextManifestDigest, promptManifestDigest: prepared.binding.promptManifestDigest,
        executionBinding, executionBlueprint: prepared.executionBlueprint, roleInvocationPolicy: prepared.roleInvocationPolicy, skillManifest: prepared.skillManifest,
        ...(transport === "paseo" ? { materializedPaseoSession: { id: prepared.binding.runtime.sessionId, provider: "openai", exitCode: 0, stdout: "", stderr: "" } } : {})
      }), `${transport} must reject altered ${item.name} identity`).rejects.toThrow(/EXECUTION_(?:BINDING_(?:STALE|MISMATCH|RUNTIME_MISMATCH|RUNTIME_SESSION_MISMATCH)|BLUEPRINT_INVALID)|ROLE_INVOCATION_POLICY_VIOLATION/);
    }
    if (transport === "paseo") expect(runtime.continueManagedPaseoAgent).not.toHaveBeenCalled();
  });

  it("does not project accepted ephemeral procedures without current participant authority", async () => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture("RUN-SKILL-WITHOUT-AUTHORITY", "direct");
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_OPERATION_KIND;
    delete process.env.AEH_CONTROL_ROOT;
    selection.permissions.read = "allow";
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId }, ["Only assigned participant."], "review");
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", { outputContract: "reviewer", participantId, skillManifest }))
      .rejects.toThrow("SKILL_MANIFEST_AUTHORITY_REQUIRED");
  });
});

describe("accepted ephemeral procedure transport projection", () => {
  it.each(["direct", "podman", "paseo"] as const)("delivers the exact accepted procedure bytes to the assigned authorized %s participant and binds the manifest digest", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-SKILL-PROJECT-${transport.toUpperCase()}`, transport);
    selection.permissions.read = "allow";
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId });
    const expectedProjection = procedureProjection(skillManifest);
    expect(skillManifest.entries[0]?.procedure).toEqual(ephemeralProcedure);
    expect(skillManifest.entries[0]?.procedureDigest).toBe(sha256Canonical(ephemeralProcedure));
    expect(skillManifest.entries[0]?.sourcePackDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(skillManifest.entries[0]?.trustDecisionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(skillManifest.entries[0]?.provenance.kind).toBe("accepted-knowledge");
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const structured = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
    runtime.runDirectWorkerProcess.mockResolvedValue({ exitCode: 0, stdout: runtimeSessionOutput("codex-thread-test", structured), stderr: "" });
    runtime.runExecutable.mockImplementation(async (command: string) => command === "podman"
      ? { exitCode: 0, stdout: runtimeSessionOutput("opencode-session-test", structured), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" });
    runtime.continueManagedPaseoAgent.mockImplementation(async (_root: string, agentId: string) => ({ id: agentId, exitCode: 0, stdout: JSON.stringify(structured), stderr: "", transport: "sdk", status: "idle" }));

    const result = await executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest, capabilityAuthority
    });

    const executionBinding = result.executionBinding as ExecutionBindingV2;
    expect(executionBinding.skillManifestDigest).toBe(skillManifest.digest);
    expect(executionBinding.participantId).toBe(participantId);
    expect(executionBinding.operationId).toBe(operationId);
    expect(executionBinding.candidateDigest).toBe(candidate.identityDigest);
    if (transport === "paseo") {
      const materializeOptions = runtime.materializeManagedPaseoAgent.mock.calls[0]?.[1] as { labels: Record<string, string>; prompt?: string };
      const continueOptions = runtime.continueManagedPaseoAgent.mock.calls[0];
      expect(materializeOptions.prompt).toBeUndefined();
      expect(continueOptions?.[1]).toBe(executionBinding.runtime.sessionId);
      expect(continueOptions?.[2]).toContain(expectedProjection);
      for (const step of ephemeralProcedure) expect(continueOptions?.[2]).toContain(step);
      expect(materializeOptions.labels["aeh.skill.manifest.digest"]).toBe(skillManifest.digest);
      const provenance = await structuredResultProvenanceForAgent(root, executionBinding.runtime.sessionId) as unknown as { skillManifestDigest?: string; executionBinding?: { skillManifestDigest?: string } };
      expect(provenance.skillManifestDigest).toBe(skillManifest.digest);
      expect(provenance.executionBinding?.skillManifestDigest).toBe(skillManifest.digest);
    } else if (transport === "direct") {
      const call = runtime.runDirectWorkerProcess.mock.calls[0]!;
      const args = call[1] as string[];
      expect(args.at(-1)).toContain(expectedProjection);
      const environment = call[3]?.environment as Record<string, string>;
      expect(environment.AEH_SKILL_MANIFEST_DIGEST).toBe(skillManifest.digest);
      expect((JSON.parse(environment.AEH_EXECUTION_BINDING!) as { skillManifestDigest?: string }).skillManifestDigest).toBe(skillManifest.digest);
    } else {
      const args = runtime.runExecutable.mock.calls.find((call) => call[0] === "podman")?.[1] as string[];
      expect(args.at(-1)).toContain(expectedProjection);
      expect(args).toContain(`AEH_SKILL_MANIFEST_DIGEST=${skillManifest.digest}`);
      const bindingArg = args.find((arg) => arg.startsWith("AEH_EXECUTION_BINDING="))!;
      expect((JSON.parse(bindingArg.slice("AEH_EXECUTION_BINDING=".length)) as { skillManifestDigest?: string }).skillManifestDigest).toBe(skillManifest.digest);
    }
  });

  it.each(["direct", "podman", "paseo"] as const)("rejects an ephemeral manifest assigned to another participant before any %s launch", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-SKILL-UNASSIGNED-${transport.toUpperCase()}`, transport);
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const foreignManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId: "participant:unassigned-reviewer" });
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest: foreignManifest, capabilityAuthority
    })).rejects.toThrow("SKILL_MANIFEST_ASSIGNMENT_MISMATCH");
    expectNoTransportLaunch();
  });

  it.each(["direct", "podman", "paseo"] as const)("rejects accepted ephemeral projection without current controller authority before any %s launch", async (transport) => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture(`RUN-SKILL-NO-AUTHORITY-${transport.toUpperCase()}`, transport);
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_OPERATION_KIND;
    delete process.env.AEH_CONTROL_ROOT;
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId });
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest
    })).rejects.toThrow("SKILL_MANIFEST_AUTHORITY_REQUIRED");
    expectNoTransportLaunch();
  });

  it("propagates a prepared ephemeral projection verbatim to the assigned participant", async () => {
    const { root, operationId, candidate, selection, config, contract, participantId } = await launchFixture("RUN-SKILL-PREPARED", "direct");
    selection.permissions.read = "allow";
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId });
    const prepared = await prepareAgentExecutionBinding(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest, executionSessionId: "fixture-runtime-session"
    });
    expect(prepared.prompt).toContain(procedureProjection(skillManifest));
    expect(prepared.binding.skillManifestDigest).toBe(skillManifest.digest);
    const structured = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
    runtime.runDirectWorkerProcess.mockResolvedValue({ exitCode: 0, stdout: runtimeSessionOutput("fixture-runtime-session", structured), stderr: "" });

    const result = await executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer",
      phase: "review",
      participantId,
      capabilityAuthority: prepared.authority,
      preparedPrompt: prepared.prompt,
      contextManifest: prepared.contextManifest,
      contextManifestDigest: prepared.binding.contextManifestDigest,
      promptManifestDigest: prepared.binding.promptManifestDigest,
      executionBinding: prepared.binding,
      directWorkerHome: { directory: await createTestHome() },
      executionBlueprint: prepared.executionBlueprint,
      roleInvocationPolicy: prepared.roleInvocationPolicy,
      skillManifest: prepared.skillManifest
    });

    expect(result.exitCode).toBe(0);
    const args = runtime.runDirectWorkerProcess.mock.calls[0]?.[1] as string[];
    expect(args.at(-1)).toBe(prepared.prompt);
    const environment = runtime.runDirectWorkerProcess.mock.calls[0]?.[3]?.environment as Record<string, string>;
    expect(environment.AEH_SKILL_MANIFEST_DIGEST).toBe(skillManifest.digest);
    expect((JSON.parse(environment.AEH_EXECUTION_BINDING!) as { skillManifestDigest?: string }).skillManifestDigest).toBe(skillManifest.digest);
  });

  it("rejects a prepared prompt whose exact ephemeral procedure bytes were dropped before any launch", async () => {
    const { root, selection, config, contract, participantId, operationId, candidate } = await launchFixture("RUN-SKILL-PREPARED-DROPPED", "direct");
    selection.permissions.read = "allow";
    const skillManifest = acceptedEphemeralManifest({ operationId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, participantId });
    const prepared = await prepareAgentExecutionBinding(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest, executionSessionId: "fixture-runtime-session"
    });
    const strippedPrompt = prepared.prompt.replace(ephemeralProcedure[0]!, "[procedure omitted]");
    expect(strippedPrompt).not.toBe(prepared.prompt);
    const { version: _version, digest: _digest, ...bindingBody } = prepared.binding;
    const strippedBinding = compileExecutionBinding({
      ...bindingBody,
      promptManifestDigest: createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: strippedPrompt, role: selection.role, source: "agent-prompt-projection" }] }).digest
    });
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer",
      phase: "review",
      participantId,
      capabilityAuthority: prepared.authority,
      preparedPrompt: strippedPrompt,
      contextManifest: prepared.contextManifest,
      contextManifestDigest: prepared.binding.contextManifestDigest,
      promptManifestDigest: strippedBinding.promptManifestDigest,
      executionBinding: strippedBinding,
      directWorkerHome: { directory: await createTestHome() },
      executionBlueprint: prepared.executionBlueprint,
      roleInvocationPolicy: prepared.roleInvocationPolicy,
      skillManifest: prepared.skillManifest
    })).rejects.toThrow("SKILL_MANIFEST_PROJECTION_MISMATCH");
    expectNoTransportLaunch();
  });

  it("rejects an ID-only ephemeral manifest before any launch", async () => {
    const { root, selection, config, contract, participantId } = await launchFixture("RUN-SKILL-ID-ONLY", "direct");
    selection.permissions.read = "allow";
    const capabilityAuthority = await prepareExecutionAuthority(root, selection, { participantId, phase: "review", required: true });
    if (!capabilityAuthority) throw new Error("test requires controller-issued participant authority");
    const body = { version: 1 as const, participantId, entries: [{ skillId: "ephemeral:review", competency: "security-review", kind: "ephemeral" as const, procedure: [] as string[], procedureDigest: sha256Canonical([]) }] };
    const idOnlyManifest = { ...body, digest: sha256Canonical(body) } as unknown as SkillManifestV1;
    await expect(executeAgentPrompt(root, config, contract, selection, "Review this candidate.", {
      outputContract: "reviewer", phase: "review", participantId, skillManifest: idOnlyManifest, capabilityAuthority
    })).rejects.toThrow("SKILL_MANIFEST_INVALID");
    expectNoTransportLaunch();
  });
});

const ephemeralProcedure = [
  "Inspect the frozen compiler output exactly as accepted.",
  "Record the accepted evidence digest before any edit."
];

function acceptedEphemeralManifest(identity: { operationId: string; candidateRevision: number; candidateDigest: string; participantId: string }, procedure = ephemeralProcedure, competency = "security-review"): SkillManifestV1 {
  const sourceUri = "https://example.test/official/skill-evidence";
  const cacheKey = `skill-test:${identity.operationId}:${identity.participantId}`;
  const pack = knowledgePack({
    cacheKey,
    topic: competency,
    claims: procedure.map((statement, index) => ({ id: `claim-${index}`, statement, competency, confidence: "high" as const })),
    sources: [{ uri: sourceUri, kind: "official", version: "1" }],
    retrievedAt: "2026-09-23T00:00:00.000Z"
  });
  const gap: KnowledgeGapV1 = { version: 1, cacheKey, missingCompetencies: [competency], mode: "DOCS_ONLY", librarianRequired: true, reason: "accepted skill evidence test", status: "MISSING" };
  const accepted = applySkillTrustGate({
    version: 1,
    id: "ephemeral:review",
    competency,
    procedure: [...procedure],
    sourcePackDigest: pack.packDigest,
    procedureEvidence: procedure.map((_step, stepIndex) => ({ stepIndex, claimIds: [`claim-${stepIndex}`], sourceUris: [sourceUri] }))
  }, pack, gap)!;
  return compileSkillManifest({
    scope: { operationId: identity.operationId, operationExecutionRevision: 1, candidateRevision: identity.candidateRevision, candidateDigest: identity.candidateDigest, controllerEpoch: 0, participantId: identity.participantId, workUnitIds: [`invocation:${identity.participantId}`], competencies: [competency] },
    skills: [{ id: accepted.id, kind: "ephemeral", competencies: [{ id: accepted.competency }], proceduralSteps: accepted.procedure, sourcePackDigest: accepted.sourcePackDigest, trustDecisionDigest: accepted.trustDecision.decisionDigest, groundedProcedure: accepted.groundedProcedure }]
  });
}

function procedureProjection(manifest: SkillManifestV1): string {
  return manifest.entries.map((entry) => `Skill ${entry.skillId} (${entry.competency})\n${entry.procedure.join("\n")}`).join("\n\n");
}

function expectNoTransportLaunch(): void {
  expect(runtime.runDirectWorkerProcess).not.toHaveBeenCalled();
  expect(runtime.launchManagedPaseoAgent).not.toHaveBeenCalled();
  expect(runtime.runExecutable.mock.calls.filter((call) => call[0] === "podman")).toHaveLength(0);
}

async function launchFixture(operationId: string, transport: "direct" | "podman" | "paseo") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-agent-result-transport-"));
  roots.push(root);
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_CONTROL_ROOT = root;
  const now = new Date().toISOString();
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: "TASK-TRANSPORT" }, createdAt: now, updatedAt: now, operationExecutionRevision: 1 } as never);
  const participantId = `participant:${transport}-reviewer`;
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: `${transport}-reviewer`, role: "Reviewer", phase: "review" });
  const operation = await loadOperation(root, operationId);
  const selection: AgentExecutionSelection = {
    logicalAgent: `${transport}-reviewer`, role: "Reviewer", domains: [], runtimeName: transport === "direct" ? "codex" : "opencode", runtimeAdapter: transport === "direct" ? "codex" : "opencode", paseoProvider: "codex", modelAlias: "test-model", modelId: "test-model", modelName: "test-model", modelProvider: "openai", transport, skills: [], mcps: [], permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" }, outputContract: "reviewer", args: [], runtimeCapabilities: { structuredOutput: true, sessions: true, mcp: true, stdioMcp: true, localMcp: true }
  };
  const config: HarnessProjectConfig = { version: 1, project: { name: "result-transport-test" }, orchestration: { provider: transport }, ...(transport === "podman" ? { security: { sandbox: { image: "test/worker:latest" } } } : {}) };
  const contract: TaskContract = { version: 1, task: { id: "TASK-TRANSPORT", title: "Review launch binding" }, routing: { route: "DIRECT", assurance: "STANDARD", intent: "audit" }, scope: { allowed: ["src/**"] } };
  return { root, operationId, candidate: operation.candidateRevision!, selection, config, contract, participantId };
}

async function createTestHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-test-runtime-home-"));
  roots.push(home);
  return home;
}

function runtimeSessionOutput(sessionId: string, payload: unknown): string {
  return `${JSON.stringify({ type: "session.created", session_id: sessionId })}\nAEH_RESULT_JSON=${JSON.stringify(payload)}`;
}
