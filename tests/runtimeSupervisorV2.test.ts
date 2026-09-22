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

  it("allows one writer or multiple readers and removes expired leases", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const supervisor = new RuntimeSupervisorV1({ clock: () => now, leaseTtlMs: 100 });
    const first = supervisor.acquireProviderLease({ provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "read", ownerId: "a" });
    const second = supervisor.acquireProviderLease({ provider: "serena", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "read", ownerId: "b" });
    expect(supervisor.snapshot().providerLeases).toHaveLength(2);
    now = new Date("2026-01-01T00:00:00.101Z");
    expect(supervisor.snapshot().providerLeases).toHaveLength(0);
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
});
