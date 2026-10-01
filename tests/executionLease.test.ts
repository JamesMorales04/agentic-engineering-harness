import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { saveOperation, loadOperation, registerOperationAgent } from "../src/operations/state.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";

const roots: string[] = [];
const previousEnv = { id: process.env.AEH_OPERATION_ID, control: process.env.AEH_CONTROL_ROOT };
afterEach(async () => {
  if (previousEnv.id === undefined) delete process.env.AEH_OPERATION_ID; else process.env.AEH_OPERATION_ID = previousEnv.id;
  if (previousEnv.control === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previousEnv.control;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const selection: AgentExecutionSelection = {
  logicalAgent: "implementer",
  role: "Implementer",
  domains: ["typescript"],
  runtimeName: "codex",
  runtimeAdapter: "codex",
  paseoProvider: "codex",
  modelAlias: "test",
  modelId: "test",
  modelName: "test",
  transport: "direct",
  permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" },
  skills: [],
  mcps: [],
  args: [],
  runtimeCapabilities: {}
};

describe("execution capability leases", () => {
  it("binds launch authority to the current operation, candidate and participant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-execution-lease-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "RUN-LEASE", kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: now, updatedAt: now });
    const candidate = (await loadOperation(root, "RUN-LEASE")).candidateRevision!;
    process.env.AEH_OPERATION_ID = "RUN-LEASE";
    process.env.AEH_CONTROL_ROOT = root;
    const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", now: new Date(now) });
    expect(authority?.participantId).toMatch(/^participant:/);
    expect(authority?.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(authority?.leases.map((lease) => lease.capability)).toEqual(["read", "write", "execute"]);
    expect(authority?.leases.every((lease) => lease.operationId === "RUN-LEASE" && lease.candidate.identityDigest === candidate.identityDigest)).toBe(true);
    expect(Object.keys((await loadOperation(root, "RUN-LEASE")).participants)).toHaveLength(1);
  });

  it("does not fabricate launch authority outside a managed operation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-execution-lease-missing-")); roots.push(root);
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
    await expect(prepareExecutionAuthority(root, selection)).resolves.toBeUndefined();
  });

  it("does not rebind an already registered participant to a different role", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-execution-lease-role-")); roots.push(root);
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: "RUN-ROLE", kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: now, updatedAt: now });
    await registerOperationAgent(root, "RUN-ROLE", { id: "fixed-participant", logicalAgent: "reviewer", role: "Reviewer" });
    process.env.AEH_OPERATION_ID = "RUN-ROLE";
    process.env.AEH_CONTROL_ROOT = root;

    await expect(prepareExecutionAuthority(root, selection, { participantId: "fixed-participant", phase: "implementation", required: true }))
      .rejects.toThrow("not registered for selected role 'Implementer'");
    expect((await loadOperation(root, "RUN-ROLE")).participants["fixed-participant"]?.role).toBe("Reviewer");
  });
});
