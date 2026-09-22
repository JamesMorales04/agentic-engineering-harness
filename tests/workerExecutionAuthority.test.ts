import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { loadOperation, saveOperation } from "../src/operations/state.js";
import { DirectWorkerExecutor } from "../src/workers/direct.js";
import { PaseoWorkerExecutor } from "../src/workers/paseo.js";
import { PodmanWorkerExecutor } from "../src/workers/podman.js";
import { runDirectWorkerProcess } from "../src/workers/directProcess.js";
import { executeAgentPrompt } from "../src/workers/agentPrompt.js";

vi.mock("../src/workers/directProcess.js", () => ({
  runDirectWorkerProcess: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
}));
vi.mock("../src/workers/agentPrompt.js", () => ({
  executeAgentPrompt: vi.fn(async (_root: string, _config: HarnessProjectConfig, _contract: TaskContract, selected: AgentExecutionSelection, _prompt: string, options: Record<string, unknown>) => ({
    id: "prepared-runtime-session",
    provider: selected.paseoProvider,
    model: selected.modelId,
    transport: selected.transport,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    participantId: options.participantId as string,
    capabilityLeases: (options.capabilityAuthority as { leases?: unknown[] } | undefined)?.leases
  }))
}));

const mockedDirectProcess = vi.mocked(runDirectWorkerProcess);
const mockedExecuteAgentPrompt = vi.mocked(executeAgentPrompt);
const roots: string[] = [];
const originalEnv = {
  operation: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT
};

const selection: AgentExecutionSelection = {
  logicalAgent: "implementer",
  role: "Implementer",
  domains: ["typescript"],
  runtimeName: "codex",
  runtimeAdapter: "codex",
  paseoProvider: "codex",
  modelAlias: "test",
  modelId: "test-model",
  modelName: "test-model",
  transport: "direct",
  permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" },
  skills: [],
  mcps: [],
  args: [],
  runtimeCapabilities: {},
  outputContract: "implementer"
};

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "worker-authority-test" },
  orchestration: { provider: "direct", worker: { timeoutSeconds: 5 } }
};

const contract = {
  version: 1,
  task: { id: "RUN-AUTH", title: "authority" },
  routing: { intent: "run" }
} as unknown as TaskContract;

afterEach(async () => {
  mockedDirectProcess.mockClear();
  mockedExecuteAgentPrompt.mockClear();
  if (originalEnv.operation === undefined) delete process.env.AEH_OPERATION_ID;
  else process.env.AEH_OPERATION_ID = originalEnv.operation;
  if (originalEnv.control === undefined) delete process.env.AEH_CONTROL_ROOT;
  else process.env.AEH_CONTROL_ROOT = originalEnv.control;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("worker execution authority boundary", () => {
  it.each([
    ["direct", () => new DirectWorkerExecutor()],
    ["podman", () => new PodmanWorkerExecutor()],
    ["paseo", () => new PaseoWorkerExecutor()]
  ] as const)("rejects an unmanaged %s launch before spawning", async (_name, create) => {
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
    const executor = create();
    await expect(executor.start("/repo", config, contract, selection)).rejects.toThrow("V2_AUTHORITY_REQUIRED");
  });

  it("rejects direct launches when topology permissions exceed the compiled role ceiling", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-worker-role-ceiling-"));
    roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, {
      version: 1,
      id: "RUN-ROLE-CEILING",
      kind: "run",
      status: "RUNNING",
      phase: "review",
      root,
      payload: { taskId: "RUN-ROLE-CEILING" },
      createdAt: now,
      updatedAt: now
    });
    process.env.AEH_OPERATION_ID = "RUN-ROLE-CEILING";
    process.env.AEH_CONTROL_ROOT = root;

    const reviewerWithWriterPermissions: AgentExecutionSelection = {
      ...selection,
      role: "Reviewer",
      permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" }
    };
    await expect(new DirectWorkerExecutor().start(root, config, contract, reviewerWithWriterPermissions))
      .rejects.toThrow("V2_AUTHORITY_DENIED: role 'Reviewer'");
    const reviewerWithGitMutation = {
      ...reviewerWithWriterPermissions,
      permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny", gitWrite: "allow" }
    };
    await expect(new DirectWorkerExecutor().start(root, config, contract, reviewerWithGitMutation))
      .rejects.toThrow("V2_AUTHORITY_DENIED: role 'Reviewer'");
    expect(mockedDirectProcess).not.toHaveBeenCalled();
    expect(mockedExecuteAgentPrompt).not.toHaveBeenCalled();
  });

  it("rejects launches with an unregistered role identity before registering a participant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-worker-unregistered-role-"));
    roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, {
      version: 1,
      id: "RUN-UNKNOWN-ROLE",
      kind: "run",
      status: "RUNNING",
      phase: "implementation",
      root,
      payload: { taskId: "RUN-UNKNOWN-ROLE" },
      createdAt: now,
      updatedAt: now
    });
    process.env.AEH_OPERATION_ID = "RUN-UNKNOWN-ROLE";
    process.env.AEH_CONTROL_ROOT = root;

    const unregisteredRole = { ...selection, role: "quality-specialist" } as unknown as AgentExecutionSelection;
    await expect(new DirectWorkerExecutor().start(root, config, contract, unregisteredRole))
      .rejects.toThrow("has no registered canonical RoleProfile");
    expect(Object.keys((await loadOperation(root, "RUN-UNKNOWN-ROLE")).participants)).toHaveLength(0);
    expect(mockedDirectProcess).not.toHaveBeenCalled();
    expect(mockedExecuteAgentPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", () => new DirectWorkerExecutor()],
    ["podman", () => new PodmanWorkerExecutor()],
    ["paseo", () => new PaseoWorkerExecutor()]
  ] as const)("propagates prepared authority and output identity through the %s binding compiler", async (_name, create) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-worker-authority-"));
    roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, {
      version: 1,
      id: "RUN-AUTH",
      kind: "run",
      status: "RUNNING",
      phase: "implementation",
      root,
      payload: { taskId: "RUN-AUTH" },
      createdAt: now,
      updatedAt: now
    });
    const candidate = (await loadOperation(root, "RUN-AUTH")).candidateRevision!;
    process.env.AEH_OPERATION_ID = "RUN-AUTH";
    process.env.AEH_CONTROL_ROOT = root;

    const session = await create().start(root, config, contract, selection);
    const options = mockedExecuteAgentPrompt.mock.calls[0]?.[5];
    expect(session.participantId).toMatch(/^participant:/);
    expect(session.capabilityLeases?.map((lease) => lease.capability)).toEqual(["read", "write", "execute"]);
    expect(options).toEqual(expect.objectContaining({
      outputContract: "implementer",
      phase: "implementation",
      participantId: session.participantId,
      capabilityAuthority: expect.objectContaining({ participantId: session.participantId, candidateDigest: candidate.identityDigest }),
      requireExecutionAuthority: true
    }));
    expect(mockedDirectProcess).not.toHaveBeenCalled();
  });
});
