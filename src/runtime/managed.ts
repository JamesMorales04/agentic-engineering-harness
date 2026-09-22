import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeSupervisorV1, type RuntimeServiceV1, type RuntimeServiceKindV1, type RuntimeServiceStatusV1, type RuntimeSnapshotV1 } from "./supervisorV2.js";

export interface ManagedRuntimeOptionsV1 {
  root: string;
  projectId?: string;
  ownerId?: string;
  statePath?: string;
  supervisor?: RuntimeSupervisorV1;
}

/** Stable local identity used when no repository registry record is available yet. */
export function runtimeProjectId(root: string): string {
  return `project:${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}`;
}

/**
 * Durable projection for the in-memory supervisor. The supervisor remains the
 * authority for leases and ownership; this file is only its crash-observable
 * runtime snapshot and is written atomically without secrets.
 */
export class ManagedRuntimeSupervisorV1 {
  readonly supervisor: RuntimeSupervisorV1;
  readonly root: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly statePath: string;

  constructor(options: ManagedRuntimeOptionsV1) {
    this.root = path.resolve(options.root);
    this.projectId = options.projectId ?? runtimeProjectId(this.root);
    this.ownerId = options.ownerId ?? `runtime:${process.pid}:${randomUUID()}`;
    this.statePath = path.resolve(options.statePath ?? path.join(this.root, ".harness", "runtime", "snapshot.json"));
    this.supervisor = options.supervisor ?? new RuntimeSupervisorV1();
  }

  registerService(input: Omit<RuntimeServiceV1, "version" | "projectId" | "canonicalRoot" | "ownerId" | "status" | "startedAt" | "lastHeartbeatAt"> & { kind: RuntimeServiceKindV1; status?: RuntimeServiceStatusV1; metadata?: Record<string, string> }): Promise<RuntimeServiceV1> {
    const service = this.supervisor.registerService({
      ...input,
      projectId: this.projectId,
      canonicalRoot: this.root,
      ownerId: this.ownerId,
      status: input.status ?? "STARTING",
      metadata: { ...(input.metadata ?? {}), projectId: this.projectId }
    });
    return this.persist().then(() => service);
  }

  updateService(serviceId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): Promise<RuntimeServiceV1> {
    const service = this.supervisor.updateService(serviceId, this.ownerId, update);
    return this.persist().then(() => service);
  }

  heartbeat(serviceId: string): Promise<RuntimeServiceV1> {
    const service = this.supervisor.heartbeat(serviceId, this.ownerId);
    return this.persist().then(() => service);
  }

  snapshot(): RuntimeSnapshotV1 {
    return this.supervisor.snapshot();
  }

  async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.statePath}.lock`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const lock = await fs.open(lockPath, "wx");
        try {
          await lock.writeFile(`${process.pid}\n`);
          const previous = await readRuntimeSnapshot(this.statePath);
          const current = this.snapshot();
          const services = new Map(previous.services.map((service) => [service.serviceId, service]));
          for (const service of current.services) services.set(service.serviceId, service);
          const leases = new Map(previous.providerLeases.map((lease) => [lease.leaseId, lease]));
          for (const lease of current.providerLeases) leases.set(lease.leaseId, lease);
          const merged: RuntimeSnapshotV1 = { version: 1, capturedAt: new Date().toISOString(), services: [...services.values()], providerLeases: [...leases.values()] };
          const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
          await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          try { await fs.rename(temporary, this.statePath); }
          finally { await fs.rm(temporary, { force: true }); }
          return;
        } finally {
          await lock.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

export async function readManagedRuntimeSnapshot(root: string, statePath?: string): Promise<RuntimeSnapshotV1> {
  return readRuntimeSnapshot(path.resolve(statePath ?? path.join(root, ".harness", "runtime", "snapshot.json")));
}

async function readRuntimeSnapshot(file: string): Promise<RuntimeSnapshotV1> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<RuntimeSnapshotV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.services) || !Array.isArray(parsed.providerLeases)) throw new Error("invalid runtime snapshot");
    return parsed as RuntimeSnapshotV1;
  } catch {
    return { version: 1, capturedAt: new Date(0).toISOString(), services: [], providerLeases: [] };
  }
}

export async function createManagedRuntime(options: ManagedRuntimeOptionsV1): Promise<ManagedRuntimeSupervisorV1> {
  const runtime = new ManagedRuntimeSupervisorV1(options);
  await runtime.persist();
  return runtime;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}
