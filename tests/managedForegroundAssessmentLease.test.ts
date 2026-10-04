import { afterEach, describe, expect, it, vi } from "vitest";
import { launchManagedPaseoAgent } from "../src/paseo/runtimeInitialTurn.js";

const originalEnv = { id: process.env.AEH_OPERATION_ID, control: process.env.AEH_CONTROL_ROOT };
afterEach(() => {
  if (originalEnv.id === undefined) delete process.env.AEH_OPERATION_ID; else process.env.AEH_OPERATION_ID = originalEnv.id;
  if (originalEnv.control === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = originalEnv.control;
});

function fakeDeps() {
  return {
    run: vi.fn(),
    detectCapabilities: vi.fn(),
    trace: vi.fn(async () => undefined),
    native: {
      preflight: vi.fn(async () => ({ ok: true, message: "ok" })),
      preflightMode: vi.fn(async () => ({ ok: true, message: "ok", availableModes: [] })),
      wait: vi.fn(async () => ({ id: "agent-1", status: "idle", lastMessage: "{}" }))
    },
    sdk: {
      create: vi.fn(async () => ({ id: "agent-created", status: "idle", lastMessage: "{}" })),
      materialize: vi.fn(async () => ({ id: "agent-1", status: "idle" })),
      dispatch: vi.fn(),
      wait: vi.fn(),
      run: vi.fn(async () => ({ id: "agent-1", status: "idle", lastMessage: '{"judgment":{"type":"ROUTE"}}' })),
      probe: vi.fn(),
      inspect: vi.fn(),
      list: vi.fn()
    }
  } as never;
}

describe("managed foreground turn lifecycle selection", () => {
  it("creates controller-side semantic assessments with the provider output schema as the initial prompt and no AEH result sink", async () => {
    process.env.AEH_OPERATION_ID = "AUDIT-1";
    process.env.AEH_CONTROL_ROOT = "/tmp/aeh-assessment-lease";
    const schema = { type: "object", properties: { judgment: { type: "object" } } };
    const deps = fakeDeps() as never as { sdk: { create: ReturnType<typeof vi.fn>; materialize: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }; native: { wait: ReturnType<typeof vi.fn> } };
    const result = await launchManagedPaseoAgent("/tmp/aeh-assessment-lease", {
      cwd: "/tmp/aeh-assessment-lease",
      title: "assessor",
      provider: "opencode",
      model: "opencode-go/muse-spark-1.3-contributor",
      prompt: "return a typed assessment",
      outputSchema: schema,
      waitForFinish: true,
      labels: { "aeh.kind": "semantic-assessment", "aeh.operation": "AUDIT-1", "aeh.role": "Semantic Assessor" }
    } as never, deps as never);
    expect(result.id).toBe("agent-1");
    expect((deps as { sdk: { materialize: ReturnType<typeof vi.fn> } }).sdk.materialize).not.toHaveBeenCalled();
    expect((deps as { sdk: { run: ReturnType<typeof vi.fn> } }).sdk.run).not.toHaveBeenCalled();
    const createCalls = (deps as { sdk: { create: ReturnType<typeof vi.fn> } }).sdk.create.mock.calls;
    expect(createCalls).toHaveLength(1);
    const createOptions = createCalls[0]?.[1] as Record<string, unknown>;
    expect(createOptions).toMatchObject({ prompt: "return a typed assessment", outputSchema: schema, waitForFinish: false });
    expect(createOptions.mcpServers).toBeUndefined();
    expect((createOptions.labels as Record<string, string>)["aeh.output.contract"]).toBeUndefined();
    expect((deps as { native: { wait: ReturnType<typeof vi.fn> } }).native.wait).toHaveBeenCalledTimes(1);
  });

  it("still rejects operation-bound worker turns without participant or bound Lead generation labels", async () => {
    process.env.AEH_OPERATION_ID = "AUDIT-1";
    process.env.AEH_CONTROL_ROOT = "/tmp/aeh-assessment-lease";
    const deps = fakeDeps();
    await expect(launchManagedPaseoAgent("/tmp/aeh-assessment-lease", {
      cwd: "/tmp/aeh-assessment-lease",
      title: "reviewer",
      provider: "opencode",
      model: "opencode-go/muse-spark-1.3-contributor",
      prompt: "review the candidate",
      waitForFinish: true,
      labels: { "aeh.kind": "worker", "aeh.operation": "AUDIT-1", "aeh.role": "reviewer" }
    } as never, deps as never)).rejects.toThrow(/PASEO_PROVIDER_LEASE_CONTEXT_MISMATCH/);
  });
});
