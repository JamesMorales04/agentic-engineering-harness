import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { saveOperation, loadOperation, registerOperationAgent } from "../src/operations/state.js";
import { attachParticipantScratchAuthority, prepareExecutionAuthority, provisionParticipantScratch } from "../src/security/executionLease.js";
import { operationResourceRegistryFile } from "../src/runtime/operationResources.js";
import { compileOperationOriginV1 } from "../src/operations/operationProvenance.js";
import { sha256Canonical } from "../src/core/digest.js";

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
    const now = new Date().toISOString();
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

  it("issues operation and participant scoped scratch leases and rejects takeover across participants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-execution-scratch-")); roots.push(root);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const operationId = "RUN-SCRATCH-AUTHORITY";
    const requestDigest = sha256Canonical({ operationId, request: "scratch root deadline" });
    const rootHardDeadlineAt = new Date(nowDate.getTime() + 120_000).toISOString();
    const origin = compileOperationOriginV1({ kind: "USER_REQUEST", controllerOwnerId: "controller:test", userTurnId: "user-turn:scratch", triggerEventId: "user.turn:user-turn:scratch", requestDigest, authorizationDigest: requestDigest, recoveryDepth: 0, rootHardDeadlineAt, reason: "scratch root deadline", createdAt: now });
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-SCRATCH" }, createdAt: now, updatedAt: now, origin });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = root;
    const paseoSelection = { ...selection, transport: "paseo" as const, paseoProvider: "opencode", runtimeAdapter: "opencode" };
    const firstAuthority = await prepareExecutionAuthority(root, paseoSelection, { participantId: "participant:first", phase: "implementation", required: true });
    const secondAuthority = await prepareExecutionAuthority(root, paseoSelection, { participantId: "participant:second", phase: "implementation", required: true });
    if (!firstAuthority || !secondAuthority) throw new Error("test requires operation-bound execution authority");

    const first = await provisionParticipantScratch(root, paseoSelection, firstAuthority, "generation:first");
    const second = await provisionParticipantScratch(root, paseoSelection, secondAuthority, "generation:second");
    if (!first || !second) throw new Error("test requires participant scratch");
    roots.push(first.scratchLease.path, second.scratchLease.path);

    expect(first.scratchLease.path).not.toBe(second.scratchLease.path);
    expect(Date.parse(first.scratchLease.capabilityLeases[0]!.expiresAt)).toBeLessThanOrEqual(Date.parse(rootHardDeadlineAt));
    expect(first.scratchLease.path).toContain(path.resolve(os.tmpdir()));
    expect((await fs.stat(first.scratchLease.path)).mode & 0o777).toBe(0o700);
    expect(first.scratchLease).toMatchObject({
      operationId,
      participantId: "participant:first",
      participantGeneration: "generation:first",
      candidateDigest: firstAuthority.candidateDigest,
      controllerEpoch: firstAuthority.controllerEpoch
    });
    expect(first.scratchLease.capabilityLeases.map((lease) => lease.capability).sort()).toEqual(["read", "write"]);
    for (const lease of first.scratchLease.capabilityLeases) {
      expect(lease.envelope.scope).toEqual([first.scratchLease.path, `${first.scratchLease.path}/*`, `${first.scratchLease.path}/**`].sort());
      expect(lease.envelope.scope).not.toContain("/tmp/*");
    }

    const registry = JSON.parse(await fs.readFile(operationResourceRegistryFile(root, operationId), "utf8")) as { resources: Array<Record<string, unknown>> };
    expect(registry.resources).toContainEqual(expect.objectContaining({
      kind: "staging-root",
      identity: first.scratchLease.path,
      path: first.scratchLease.path,
      operationId,
      owner: expect.objectContaining({ participantId: "participant:first", participantGeneration: "generation:first", candidateDigest: firstAuthority.candidateDigest, controllerEpoch: firstAuthority.controllerEpoch })
    }));

    await expect(attachParticipantScratchAuthority(root, secondAuthority, first.scratchLease)).rejects.toThrow("PARTICIPANT_SCRATCH_IDENTITY_MISMATCH");
  });
});
