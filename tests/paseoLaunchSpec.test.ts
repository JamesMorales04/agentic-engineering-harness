import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compilePaseoAgentLaunchSpec } from "../src/paseo/launchSpec.js";
import { saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileParticipantScratchLease } from "../src/architecture/executionIdentity.js";
import { operationResourceId } from "../src/runtime/operationResources.js";
import type { CapabilityLeaseV1 } from "../src/security/authorityV2.js";

const original = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  workspace: process.env.AEH_OPERATION_WORKSPACE_ID,
  control: process.env.AEH_CONTROL_ROOT
};
afterEach(() => {
  restore("AEH_OPERATION_ID", original.id);
  restore("AEH_OPERATION_KIND", original.kind);
  restore("AEH_OPERATION_WORKSPACE_ID", original.workspace);
  restore("AEH_CONTROL_ROOT", original.control);
});

describe("Paseo launch spec", () => {
  it("keeps the coordinator context-isolated while projecting Serena to a semantic worker", async () => {
    const config = {
      version: 1,
      project: { name: "context-launch" },
      context: { semanticRetrieval: { provider: "serena", required: true } },
      orchestration: { provider: "paseo", worker: {} }
    } as never;
    const contract = { version: 1, task: { id: "AUDIT-CAP", title: "capability" }, routing: { intent: "audit" } } as never;
    const base = { paseoProvider: "codex", runtimeAdapter: "codex", runtimeName: "codex", modelName: "gpt-test", modelId: "gpt-test", runtimeCapabilities: {}, skills: [], mcps: [], permissions: { read: "allow", write: "deny" } } as never;
    const supervisor = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection: { ...base, logicalAgent: "operation-supervisor", role: "Operation Supervisor" }, phase: "supervision", supervisorAgent: true });
    const worker = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection: { ...base, logicalAgent: "explorer", role: "Explorer" }, phase: "review" });
    expect(supervisor.mcpServers).toBeUndefined();
    expect(worker.mcpServers?.serena).toEqual(expect.objectContaining({ type: "stdio", command: process.execPath, args: expect.arrayContaining(["provider", "serena-proxy"]) }));
    expect(worker.mcpServers?.serena?.env).toMatchObject({ AEH_SERENA_ACCESS: "read", AEH_SERENA_ROOT: "/repo" });
  });

  it("uses operation-local workspace, bounded identity and Codex thinking variant", async () => {
    const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-launch-operation-"));
    process.env.AEH_OPERATION_ID = "AUDIT-1";
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-op";
    process.env.AEH_CONTROL_ROOT = operationRoot;
    const now = new Date().toISOString();
    await saveOperation(operationRoot, {
      version: 2, id: "AUDIT-1", kind: "audit", status: "RUNNING", phase: "review", root: operationRoot,
      workspaceRoot: operationRoot, payload: { request: "audit" }, revision: 1, operationExecutionRevision: 1,
      createdAt: now, updatedAt: now, lastProgressAt: now,
      intent: { request: "audit", classification: "AUDIT", priority: 50 },
      supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    } as never);
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: {
        provider: "paseo",
        worker: { titlePrefix: "aeh" }, operations: { liveness: { providerTurnDeadlineMs: 90_000 } }
      },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "AUDIT-1", title: "audit" },
      routing: { intent: "audit" }
    } as never;
    const selection = {
      logicalAgent: "architecture-reviewer",
      role: "reviewer",
      paseoProvider: "codex",
      runtimeAdapter: "codex",
      modelName: "gpt-test",
      modelId: "openai/gpt-test",
      variant: "max",
      runtimeCapabilities: { variantSelection: true },
      profile: "balanced"
    } as never;

    try {
      const spec = await compilePaseoAgentLaunchSpec(operationRoot, config, contract, {
        selection,
        phase: "review"
      });
      expect(spec).toEqual(
        expect.objectContaining({
          provider: "codex",
          model: "gpt-test",
          thinkingOptionId: "max",
          workspaceId: "workspace-op",
          operationId: "AUDIT-1",
          operationKind: "audit",
          phase: "review",
          timeoutSeconds: 90
        })
      );
      expect(spec.modeId).toBeUndefined();
      expect(spec.env).toEqual(expect.objectContaining({
        AEH_MANAGED_AGENT: "1",
        AEH_LOGICAL_AGENT: "architecture-reviewer",
        AEH_AGENT_ROLE: "reviewer",
        AEH_INTERACTIVE_LEAD: "0",
        AEH_ORCHESTRATION_ALLOWED: "0",
        AEH_PARENT_OPERATION_ID: "AUDIT-1",
        AEH_PARENT_OPERATION_KIND: "audit",
        AEH_AGENT_PHASE: "review"
      }));
      expect(spec.labels).toEqual(
        expect.objectContaining({
          "aeh.project": "demo",
          "aeh.task": "AUDIT-1",
          "aeh.role": "architecture-reviewer",
          "aeh.operation": "AUDIT-1",
          "aeh.operation.kind": "audit",
          "aeh.operation.phase": "review",
          "aeh.workspace.kind": "orchestration"
        })
      );
    } finally {
      await fs.rm(operationRoot, { recursive: true, force: true });
    }
  });

  it("does not claim the operation workspace when the durable operation cannot be loaded", async () => {
    const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-launch-unloadable-"));
    try {
      process.env.AEH_OPERATION_ID = "AUDIT-MISSING";
      process.env.AEH_OPERATION_KIND = "audit";
      process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-op";
      process.env.AEH_CONTROL_ROOT = operationRoot;
      const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} }, delivery: { paseo: { enabled: false } } } as never;
      const contract = { version: 1, task: { id: "AUDIT-MISSING", title: "audit" }, routing: { intent: "audit" } } as never;
      const selection = { logicalAgent: "architecture-reviewer", role: "reviewer", paseoProvider: "codex", runtimeAdapter: "codex", modelName: "gpt-test", modelId: "openai/gpt-test", runtimeCapabilities: {}, skills: [], mcps: [], permissions: { read: "allow", write: "deny" } } as never;
      const spec = await compilePaseoAgentLaunchSpec(operationRoot, config, contract, { selection, phase: "review" });
      expect(spec.workspaceId).toBeUndefined();
      expect(spec.labels).not.toHaveProperty("aeh.workspace.id");
      expect(spec.labels).not.toHaveProperty("aeh.workspace.kind");
    } finally {
      await fs.rm(operationRoot, { recursive: true, force: true });
    }
  });

  it("compiles an AEH-managed OpenCode primary into session env without exposing it as a Paseo mode", async () => {
    process.env.AEH_OPERATION_ID = "AUDIT-2";
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-op";
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: {
        provider: "paseo",
        worker: { titlePrefix: "aeh" }, operations: { liveness: { providerTurnDeadlineMs: 120_000 } }
      },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "AUDIT-2", title: "audit" },
      routing: { intent: "audit" }
    } as never;
    const selection = {
      logicalAgent: "code-quality-reviewer",
      role: "reviewer",
      description: "Review maintainability.",
      paseoProvider: "opencode",
      runtimeAdapter: "opencode",
      runtimeName: "opencode",
      modelName: "MiMo-V2.6-Flash",
      modelId: "opencode-go/MiMo-V2.6-Flash",
      profile: "balanced",
      variant: "high",
      skills: [],
      mcps: [],
      permissions: { read: "allow", write: "deny", shell: "allow", network: "deny" }
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection,
      phase: "review"
    });
    const inline = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as {
      default_agent: string;
      agent: Record<string, Record<string, unknown>>;
    };

    expect(spec).toEqual(
      expect.objectContaining({
        provider: "opencode",
        model: "opencode-go/MiMo-V2.6-Flash",
        nativeAgentId: "aeh-code-quality-reviewer",
        thinkingOptionId: "high"
      })
    );
    expect(spec.modeId).toBeUndefined();
    expect(spec.modeSource).toBeUndefined();
    expect(spec.env).toEqual(expect.objectContaining({
      AEH_LOGICAL_AGENT: "code-quality-reviewer",
      AEH_AGENT_ROLE: "reviewer",
      AEH_INTERACTIVE_LEAD: "0",
      AEH_ORCHESTRATION_ALLOWED: "0",
      AEH_PARENT_OPERATION_ID: "AUDIT-2",
      AEH_AGENT_PHASE: "review"
    }));
    expect(inline.default_agent).toBe("aeh-code-quality-reviewer");
    expect(inline.agent["aeh-code-quality-reviewer"]).toEqual(
      expect.objectContaining({
        mode: "primary",
        model: "opencode-go/MiMo-V2.6-Flash"
      })
    );
    expect(spec.labels).toEqual(
      expect.objectContaining({
        "aeh.native-agent": "aeh-code-quality-reviewer",
        "aeh.native-agent.source": "aeh-managed"
      })
    );
  });

  it("preserves an explicitly configured OpenCode nativeAgent as the Paseo mode while retaining bounded identity", async () => {
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: { provider: "paseo", worker: {} },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "TASK-1", title: "task" },
      routing: { intent: "implement" }
    } as never;
    const selection = {
      logicalAgent: "backend-implementer",
      role: "implementer",
      paseoProvider: "opencode",
      runtimeAdapter: "opencode",
      runtimeName: "opencode",
      modelName: "MiMo-V2.6-Flash",
      modelId: "opencode-go/MiMo-V2.6-Flash",
      nativeAgent: "company-backend-agent",
      skills: [],
      mcps: [],
      permissions: { read: "allow", write: "allow", shell: "allow" }
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection
    });
    const inline = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
    expect(spec.modeId).toBe("company-backend-agent");
    expect(spec.modeSource).toBe("explicit");
    expect(spec.nativeAgentId).toBe("company-backend-agent");
    expect(spec.env).toEqual(expect.objectContaining({
      AEH_MANAGED_AGENT: "1",
      AEH_LOGICAL_AGENT: "backend-implementer",
      AEH_AGENT_ROLE: "implementer",
      AEH_INTERACTIVE_LEAD: "0",
      AEH_ORCHESTRATION_ALLOWED: "0"
    }));
    expect(inline).not.toHaveProperty("agent");
    expect(inline).not.toHaveProperty("default_agent");
  });

  it("never binds an isolated candidate-mutation launch to the operation workspace", async () => {
    const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-launch-workspace-"));
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-launch-isolated-"));
    try {
      const now = new Date().toISOString();
      await saveOperation(operationRoot, {
        version: 2, id: "CHANGE-LAUNCH-1", kind: "change", status: "RUNNING", phase: "implementation", root: operationRoot,
        workspaceRoot: operationRoot, payload: { request: "isolated launch" }, revision: 1, operationExecutionRevision: 1,
        createdAt: now, updatedAt: now, lastProgressAt: now,
        intent: { request: "isolated launch", classification: "CHANGE", priority: 50 },
        supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
        progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
        notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
      } as never);
      process.env.AEH_OPERATION_ID = "CHANGE-LAUNCH-1";
      process.env.AEH_OPERATION_KIND = "change";
      process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-operation";
      process.env.AEH_CONTROL_ROOT = operationRoot;
      const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} }, delivery: { paseo: { enabled: false } } } as never;
      const contract = { version: 1, task: { id: "CHANGE-LAUNCH-1", title: "isolated launch" }, routing: { intent: "change" } } as never;
      const selection = { logicalAgent: "implementer", role: "Implementer", paseoProvider: "opencode", runtimeAdapter: "opencode", runtimeName: "opencode", modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [], permissions: { read: "allow", write: "allow" } } as never;

      const inWorkspace = await compilePaseoAgentLaunchSpec(operationRoot, config, contract, { selection, phase: "implementation", parentAgentId: "supervisor-agent" });
      expect(inWorkspace.workspaceId).toBe("workspace-operation");
      expect(inWorkspace.cwd).toBe(operationRoot);

      const isolated = await compilePaseoAgentLaunchSpec(isolatedRoot, config, contract, { selection, phase: "implementation", parentAgentId: "supervisor-agent" });
      expect(isolated.workspaceId).toBeUndefined();
      expect(isolated.cwd).toBe(isolatedRoot);
      expect(isolated.labels).not.toHaveProperty("aeh.workspace.id");
      // AEH semantic parentage is retained as correlation, while both normal and isolated
      // operation participants are independent top-level Paseo agents.
      expect(inWorkspace.parentAgentId).toBe("supervisor-agent");
      expect(inWorkspace.labels["aeh.parent-agent"]).toBe("supervisor-agent");
      expect(inWorkspace).not.toHaveProperty("paseoParentAgentId");
      expect(isolated.parentAgentId).toBe("supervisor-agent");
      expect(isolated.labels["aeh.parent-agent"]).toBe("supervisor-agent");
      expect(isolated).not.toHaveProperty("paseoParentAgentId");
    } finally {
      delete process.env.AEH_OPERATION_ID;
      delete process.env.AEH_OPERATION_KIND;
      delete process.env.AEH_OPERATION_WORKSPACE_ID;
      delete process.env.AEH_CONTROL_ROOT;
      await fs.rm(operationRoot, { recursive: true, force: true });
      await fs.rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("auto-accepts provider prompts only for a fully projected permission set (AEH-V2-0110)", async () => {
    const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
    const contract = { version: 1, task: { id: "CHANGE-PERMISSION-1", title: "permission projection" }, routing: { intent: "change" } } as never;
    const base = { logicalAgent: "implementer", role: "Implementer", paseoProvider: "opencode", runtimeAdapter: "opencode", runtimeName: "opencode", modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [] } as never;
    const projected = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection: { ...base, permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" } }, phase: "implementation" });
    expect(projected.featureValues).toEqual({ auto_accept: true });
    const asks = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection: { ...base, permissions: { read: "allow", write: "ask" } }, phase: "implementation" });
    expect(asks.featureValues).toBeUndefined();
    const empty = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection: { ...base, permissions: {} }, phase: "implementation" });
    expect(empty.featureValues).toBeUndefined();
  });

  it("projects the frozen launch root as an allowed external directory for a mutating OpenCode participant (AEH-V2-0116)", async () => {
    const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
    const contract = { version: 1, task: { id: "CHANGE-EXTERNAL-1", title: "external directory projection" }, routing: { intent: "change" } } as never;
    const selection = { logicalAgent: "implementer", role: "Implementer", paseoProvider: "opencode", runtimeAdapter: "opencode", runtimeName: "opencode", modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" } } as never;
    const isolatedRoot = "/tmp/aeh-task-root";
    const spec = await compilePaseoAgentLaunchSpec(isolatedRoot, config, contract, { selection, phase: "implementation" });
    const runtimeConfig = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown> };
    expect(runtimeConfig.permission.external_directory).toEqual({
      [isolatedRoot]: "allow",
      [`${isolatedRoot}/*`]: "allow",
      [`${isolatedRoot}/**`]: "allow"
    });
    const readOnly = await compilePaseoAgentLaunchSpec(isolatedRoot, config, contract, { selection: { ...selection, role: "Reviewer", permissions: { read: "allow", write: "deny", shell: "deny", gitWrite: "deny", network: "deny" } }, phase: "review" });
    const readOnlyConfig = JSON.parse(readOnly.env!.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown> };
    expect(readOnlyConfig.permission.external_directory).toEqual({
      [isolatedRoot]: "allow",
      [`${isolatedRoot}/*`]: "allow",
      [`${isolatedRoot}/**`]: "allow"
    });
  });

  it("grants only read-only participants the control root as an external directory (AEH-V2-0119)", async () => {
    const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
    const contract = { version: 1, task: { id: "CHANGE-CONTROL-ROOT-1", title: "control root projection" }, routing: { intent: "change" } } as never;
    const selectionBase = { paseoProvider: "opencode", runtimeAdapter: "opencode", runtimeName: "opencode", modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [] };
    const isolatedRoot = "/tmp/aeh-task-root";
    const controlRoot = "/tmp/aeh-control-root";
    process.env.AEH_CONTROL_ROOT = controlRoot;
    try {
      const reviewerSelection = { ...selectionBase, logicalAgent: "reviewer", role: "Reviewer", permissions: { read: "allow", write: "deny", shell: "deny", gitWrite: "deny", network: "deny" } } as never;
      const reviewer = await compilePaseoAgentLaunchSpec(isolatedRoot, config, contract, { selection: reviewerSelection, phase: "review" });
      const reviewerConfig = JSON.parse(reviewer.env!.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown> };
      expect(reviewerConfig.permission.external_directory).toEqual({
        [isolatedRoot]: "allow",
        [`${isolatedRoot}/*`]: "allow",
        [`${isolatedRoot}/**`]: "allow",
        [controlRoot]: "allow",
        [`${controlRoot}/*`]: "allow",
        [`${controlRoot}/**`]: "allow"
      });
      const implementerSelection = { ...selectionBase, logicalAgent: "implementer", role: "Implementer", permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" } } as never;
      const implementer = await compilePaseoAgentLaunchSpec(isolatedRoot, config, contract, { selection: implementerSelection, phase: "implementation" });
      const implementerConfig = JSON.parse(implementer.env!.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown> };
      expect(implementerConfig.permission.external_directory).toEqual({
        [isolatedRoot]: "allow",
        [`${isolatedRoot}/*`]: "allow",
        [`${isolatedRoot}/**`]: "allow"
      });
    } finally {
      delete process.env.AEH_CONTROL_ROOT;
    }
  });

  it("projects the compiled ceiling to the Codex sandbox so participant turns never stop on an approval prompt (AEH-V2-0116)", async () => {
    const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
    const contract = { version: 1, task: { id: "CHANGE-CODEX-1", title: "codex sandbox projection" }, routing: { intent: "change" } } as never;
    const base = { logicalAgent: "repairer", role: "Repairer", paseoProvider: "codex", runtimeAdapter: "codex", runtimeName: "codex", modelName: "gpt-test", modelId: "gpt-test", runtimeCapabilities: {}, skills: [], mcps: [] } as never;
    const mutating = await compilePaseoAgentLaunchSpec("/tmp/aeh-task-root", config, contract, { selection: { ...base, permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" } }, phase: "diagnosis" });
    expect(mutating.providerOptions).toEqual({
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { writable_roots: ["/tmp/aeh-task-root"], network_access: false, exclude_slash_tmp: true }
    });
    const readOnly = await compilePaseoAgentLaunchSpec("/tmp/aeh-task-root", config, contract, { selection: { ...base, role: "Reviewer", permissions: { read: "allow", write: "deny", shell: "deny", gitWrite: "deny", network: "deny" } }, phase: "review" });
    expect(readOnly.providerOptions).toEqual({ approval_policy: "never", sandbox_mode: "read-only" });
  });

  it("projects only the participant-owned scratch path and redirects provider temp variables", async () => {
    const operationId = "CHANGE-SCRATCH-LAUNCH";
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "change";
    const participantId = "participant:home-content";
    const contract = { version: 1, task: { id: operationId, title: "scratch launch" }, routing: { intent: "change" } } as never;
    const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
    const selection = { logicalAgent: "implementer", role: "Implementer", paseoProvider: "opencode", runtimeAdapter: "opencode", runtimeName: "opencode", modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny" } } as never;
    const scratchPath = path.join(os.tmpdir(), "aeh-scratch-owned-launch-nonce");
    const candidate = createCandidateRevisionV1({ operationId, candidateId: `${operationId}:r1`, taskId: operationId, revision: 1, sourceDigest: "a".repeat(64), projectId: "project:test" });
    const scope = [scratchPath, `${scratchPath}/*`, `${scratchPath}/**`].sort();
    const capabilityLeases: CapabilityLeaseV1[] = (["read", "write"] as const).map((capability) => ({
      version: 1,
      leaseId: `lease:${operationId}:${capability}:scratch`,
      requestId: `request:${operationId}:${capability}:scratch`,
      operationId,
      participantId,
      projectId: candidate.projectId,
      candidate,
      capability,
      envelope: { version: 1, level: 50, capabilities: [capability], scope },
      issuedAt: "2026-10-02T00:00:00.000Z",
      expiresAt: "2026-10-02T01:00:00.000Z"
    }));
    const scratchLease = compileParticipantScratchLease({
      resourceId: operationResourceId(operationId, "staging-root", scratchPath),
      path: scratchPath,
      operationId,
      operationExecutionRevision: 1,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: 1,
      participantId,
      participantGeneration: "generation:launch",
      capabilityLeases
    });
    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection,
      logicalAgent: "implementer",
      participantId,
      candidateDigest: candidate.identityDigest,
      capabilityLeases,
      scratchLease,
      phase: "implementation"
    });
    const runtimeConfig = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as { permission: { external_directory: Record<string, string> } };
    const scopes = runtimeConfig.permission.external_directory;
    const unrelated = path.join(os.tmpdir(), "unrelated-host-temp-file");

    expect(spec.env).toMatchObject({ TMPDIR: scratchPath, TEMP: scratchPath, TMP: scratchPath, AEH_SCRATCH_RESOURCE: scratchLease.resourceId, AEH_SCRATCH_DIGEST: scratchLease.digest });
    expect(scopes).toEqual(expect.objectContaining({
      [scratchPath]: "allow",
      [`${scratchPath}/*`]: "allow",
      [`${scratchPath}/**`]: "allow"
    }));
    expect(Object.keys(scopes)).not.toContain("/tmp/*");
    expect(Object.keys(scopes)).not.toContain(unrelated);
    expect(Object.keys(scopes)).not.toContain(`${unrelated}/*`);
    expect(Object.keys(scopes)).not.toContain(`${unrelated}/**`);

    const codexSelection = { ...selection, paseoProvider: "codex", runtimeAdapter: "codex", runtimeName: "codex", modelName: "gpt-test", modelId: "gpt-test" } as never;
    const codexSpec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection: codexSelection,
      logicalAgent: "implementer",
      participantId,
      candidateDigest: candidate.identityDigest,
      capabilityLeases,
      scratchLease,
      phase: "implementation"
    });
    const codexSandbox = codexSpec.providerOptions!.sandbox_workspace_write as { writable_roots: string[]; exclude_slash_tmp: boolean };
    expect(codexSandbox.writable_roots).toContain(scratchPath);
    expect(codexSandbox.writable_roots).not.toContain(path.resolve(os.tmpdir()));
    expect(codexSandbox.exclude_slash_tmp).toBe(true);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
