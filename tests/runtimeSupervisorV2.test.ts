import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeOwnershipError, RuntimeSupervisorV1, createManagedRuntime, readManagedRuntimeSnapshot } from "../src/runtime/index.js";

describe("RuntimeSupervisorV1", () => {
  it("scopes service ownership and provider leases to a project workspace", () => {
    const supervisor = new RuntimeSupervisorV1({ leaseTtlMs: 1000 });
    supervisor.registerService({ serviceId: "paseo:project-a", kind: "paseo", projectId: "project-a", canonicalRoot: "/repo", ownerId: "home", metadata: {} });
    const read = supervisor.acquireProviderLease({ provider: "serena", projectId: "project-a", canonicalRoot: "/repo", workspaceId: "ws-a", mode: "read", ownerId: "reader" });
    expect(read.workspaceId).toBe("ws-a");
    expect(() => supervisor.acquireProviderLease({ provider: "serena", projectId: "project-a", canonicalRoot: "/repo", workspaceId: "ws-a", mode: "write", ownerId: "writer" })).toThrow(RuntimeOwnershipError);
    expect(() => supervisor.updateService("paseo:project-a", "other", { status: "FAILED" })).toThrow(RuntimeOwnershipError);
  });

  it("keeps expired provider leases fenced until explicit owner release", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const supervisor = new RuntimeSupervisorV1({ clock: () => now, leaseTtlMs: 100 });
    const first = supervisor.acquireProviderLease({ provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "read", ownerId: "a" });
    const second = supervisor.acquireProviderLease({ provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "read", ownerId: "b" });
    expect(supervisor.snapshot().providerLeases).toHaveLength(2);
    now = new Date("2026-01-01T00:00:00.101Z");
    expect(supervisor.snapshot().providerLeases).toHaveLength(2);
    expect(() => supervisor.acquireProviderLease({ provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId: "writer" })).toThrow(RuntimeOwnershipError);
    expect(() => supervisor.renewProviderLease(first.leaseId, "a")).toThrow(RuntimeOwnershipError);
    expect(() => supervisor.releaseProviderLease(first.leaseId, "a")).not.toThrow();
    expect(() => supervisor.releaseProviderLease(second.leaseId, "b")).not.toThrow();
  });

  it("merges durable service projections from independent runtime owners", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-"));
    try {
      const paseo = await createManagedRuntime({ root, ownerId: "paseo-owner" });
      await paseo.registerService({ serviceId: "paseo:p", kind: "paseo", status: "READY", pid: 10, metadata: {} });
      const control = await createManagedRuntime({ root, ownerId: "control-owner" });
      await control.registerService({ serviceId: "control-center:p", kind: "control-center", status: "READY", pid: 11, metadata: {} });
      const snapshot = await readManagedRuntimeSnapshot(root);
      expect(snapshot.services.map((item) => item.serviceId)).toEqual(expect.arrayContaining(["paseo:p", "control-center:p"]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows takeover only after the prior service owner process exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-service-takeover-"));
    try {
      const prior = await createManagedRuntime({ root, ownerId: "service-owner-prior" });
      const current = await createManagedRuntime({ root, ownerId: "service-owner-current" });
      await prior.registerService({ serviceId: "control-center:p", kind: "control-center", status: "READY", pid: process.pid, metadata: {} });
      await expect(current.registerService({ serviceId: "control-center:p", kind: "control-center", status: "READY", pid: process.pid, metadata: {} })).rejects.toThrow(RuntimeOwnershipError);

      const snapshot = await readManagedRuntimeSnapshot(root);
      snapshot.services[0]!.pid = 2_147_483_647;
      await fs.writeFile(path.join(root, ".harness", "runtime", "snapshot.json"), JSON.stringify(snapshot));
      const takenOver = await current.registerService({ serviceId: "control-center:p", kind: "control-center", status: "READY", pid: process.pid, metadata: {} });
      expect(takenOver.ownerId).toBe(current.ownerId);
      expect(takenOver.startedAt).not.toBe(snapshot.services[0]!.startedAt);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles only an exact-root legacy Paseo start record after current daemon observation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-paseo-observation-"));
    try {
      const projectId = `project:${Buffer.from(root).toString("hex").slice(0, 24)}`;
      const serviceId = `paseo:${projectId}`;
      const legacyOwnerId = `paseo-start:${process.pid}:${projectId}`;
      const prior = await createManagedRuntime({ root, projectId, ownerId: legacyOwnerId });
      await prior.registerService({ serviceId, kind: "paseo", status: "READY", pid: process.pid, metadata: {} });
      const current = await createManagedRuntime({ root, projectId, ownerId: `paseo-daemon:${projectId}` });

      await expect(current.registerService({ serviceId, kind: "paseo", status: "READY", pid: process.pid, metadata: {} })).rejects.toThrow(RuntimeOwnershipError);
      const observed = await current.registerObservedPaseoDaemon({
        serviceId,
        aehVersion: "test-version",
        paseoVersion: "0.9.1",
        observedServerId: "srv-current",
        observedPid: process.pid,
        priorDaemonState: "healthy"
      });
      expect(observed.ownerId).toBe(`paseo-daemon:${projectId}`);
      expect(observed.metadata.paseoServerId).toBe("srv-current");
      expect(observed.pid).toBe(process.pid);

      const snapshot = await readManagedRuntimeSnapshot(root);
      expect(snapshot.services).toEqual([observed]);
      const unrelated = await createManagedRuntime({ root, projectId, ownerId: "unrelated-owner" });
      await expect(unrelated.registerObservedPaseoDaemon({
        serviceId: "paseo:another-project",
        aehVersion: "test-version",
        paseoVersion: "0.9.1",
        priorDaemonState: "healthy"
      })).rejects.toThrow(RuntimeOwnershipError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes provider lease acquisition across runtime owners and persists renewal and release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-leases-"));
    try {
      const first = await createManagedRuntime({ root, ownerId: "controller-1", leaseTtlMs: 1000 });
      const second = await createManagedRuntime({ root, ownerId: "controller-2", leaseTtlMs: 1000 });
      const results = await Promise.allSettled([
        first.acquireProviderLease({ provider: "serena", workspaceId: "ws-a", mode: "write" }),
        second.acquireProviderLease({ provider: "serena", workspaceId: "ws-a", mode: "write" })
      ]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);

      const lease = results.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquireProviderLease>>> => item.status === "fulfilled")!.value;
      const owner = lease.ownerId === first.ownerId ? first : second;
      const other = owner === first ? second : first;
      const renewed = await owner.renewProviderLease(lease.leaseId, 2000);
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
      await expect(other.releaseProviderLease(lease.leaseId)).rejects.toThrow(RuntimeOwnershipError);
      expect((await readManagedRuntimeSnapshot(root)).providerLeases).toHaveLength(1);
      await owner.releaseProviderLease(lease.leaseId);
      expect((await readManagedRuntimeSnapshot(root)).providerLeases).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("permits a new epoch to take over only after the exact prior session is observed quiescent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-takeover-"));
    try {
      let now = new Date("2026-01-01T00:00:00.000Z");
      const first = await createManagedRuntime({ root, ownerId: "controller-old", clock: () => now, leaseTtlMs: 100 });
      const second = await createManagedRuntime({ root, ownerId: "controller-new", clock: () => now, leaseTtlMs: 100 });
      const priorIdentity = { operationId: "op-a", candidateDigest: "a".repeat(64), operationExecutionRevision: 2, policyDigest: "b".repeat(64), controllerTokenDigest: "c".repeat(64), controllerEpoch: 3, participantId: "participant-a", sessionId: "agent-a", providerStatus: "ACTIVE" as const };
      const oldLease = await first.acquireProviderLease({ provider: "paseo", workspaceId: "operation-ws", mode: "write", lifecycle: priorIdentity });
      now = new Date("2026-01-01T00:00:00.101Z");
      await expect(first.renewProviderLease(oldLease.leaseId)).rejects.toThrow(RuntimeOwnershipError);
      await expect(second.acquireProviderLease({ provider: "paseo", workspaceId: "operation-ws", mode: "write" })).rejects.toThrow(RuntimeOwnershipError);
      const currentIdentity = { ...priorIdentity, policyDigest: "d".repeat(64), controllerTokenDigest: "e".repeat(64), controllerEpoch: 4 };
      await expect(second.completeProviderLeaseTakeover(oldLease.leaseId, currentIdentity, { sessionId: "agent-a", status: "idle", observedAt: now.toISOString() })).resolves.toBeUndefined();
      const newLease = await second.acquireProviderLease({ provider: "paseo", workspaceId: "operation-ws", mode: "write" });
      expect(newLease.ownerId).toBe("controller-new");
      expect((await second.snapshot()).providerLeases.map((lease) => lease.leaseId)).toEqual([newLease.leaseId]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects provider lease takeover across participant identity or without quiescence", async () => {
    const supervisor = new RuntimeSupervisorV1();
    const prior = { operationId: "op-a", candidateDigest: "a".repeat(64), operationExecutionRevision: 1, policyDigest: "b".repeat(64), controllerTokenDigest: "c".repeat(64), controllerEpoch: 1, participantId: "participant-a", sessionId: "agent-a", providerStatus: "UNCERTAIN" as const };
    const lease = supervisor.acquireProviderLease({ provider: "paseo", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId: "old", lifecycle: prior });
    await expect(Promise.resolve().then(() => supervisor.completeProviderLeaseTakeover(lease.leaseId, "new", { ...prior, controllerEpoch: 2, participantId: "participant-b" }, { sessionId: "agent-a", status: "idle", observedAt: new Date().toISOString() }))).rejects.toThrow(RuntimeOwnershipError);
    await expect(Promise.resolve().then(() => supervisor.completeProviderLeaseTakeover(lease.leaseId, "new", { ...prior, controllerEpoch: 2 }, { sessionId: "agent-other", status: "idle", observedAt: new Date().toISOString() }))).rejects.toThrow(RuntimeOwnershipError);
    expect(supervisor.snapshot().providerLeases).toHaveLength(1);
  });

  it("rejects stale runtime snapshot versions instead of treating them as empty state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-version-"));
    try {
      const statePath = path.join(root, "snapshot.json");
      await fs.writeFile(statePath, JSON.stringify({ version: 9, capturedAt: new Date().toISOString(), services: [], providerLeases: [] }));
      await expect(createManagedRuntime({ root, statePath, ownerId: "controller" })).rejects.toThrow("UNSUPPORTED_RUNTIME_SNAPSHOT");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted snapshots that contain conflicting active provider writers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-conflict-"));
    try {
      const statePath = path.join(root, "snapshot.json");
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await fs.writeFile(statePath, JSON.stringify({
        version: 1,
        capturedAt: now,
        services: [],
        providerLeases: ["owner-a", "owner-b"].map((ownerId, index) => ({ version: 1, leaseId: `lease:${index}`, provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId, acquiredAt: now, expiresAt }))
      }));
      await expect(createManagedRuntime({ root, statePath, ownerId: "controller" })).rejects.toThrow("conflicting active owners");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed durable provider lifecycle identity during snapshot reload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-lifecycle-snapshot-"));
    try {
      const statePath = path.join(root, "snapshot.json");
      const now = new Date().toISOString();
      await fs.writeFile(statePath, JSON.stringify({
        version: 1, capturedAt: now, services: [],
        providerLeases: [{
          version: 1, leaseId: "lease:malformed-lifecycle", provider: "opencode", projectId: "p", canonicalRoot: "/r",
          workspaceId: "w", mode: "write", ownerId: "controller", acquiredAt: now,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          lifecycle: { operationId: "op", candidateDigest: "not-a-digest", providerStatus: "ACTIVE" }
        }]
      }));
      await expect(createManagedRuntime({ root, statePath, ownerId: "controller" })).rejects.toThrow("INVALID_PROVIDER_LEASE_LIFECYCLE");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drains owned services and releases owned provider leases atomically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-managed-runtime-drain-"));
    try {
      const runtime = await createManagedRuntime({ root, ownerId: "draining-controller" });
      const service = await runtime.registerService({ serviceId: "paseo:p", kind: "paseo", status: "READY", pid: process.pid, metadata: {} });
      await runtime.acquireProviderLease({ provider: "paseo", workspaceId: "operation-ws", mode: "write" });
      await runtime.drainAndRelease();
      const snapshot = await readManagedRuntimeSnapshot(root);
      expect(snapshot.services.find((item) => item.serviceId === service.serviceId)?.status).toBe("STOPPED");
      expect(snapshot.providerLeases).toEqual([]);
      await expect(runtime.heartbeat(service.serviceId)).rejects.toThrow("terminal (STOPPED)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
