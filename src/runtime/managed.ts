import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeSupervisorV1, type ObservedPaseoDaemonV1, type ProviderLeaseLifecycleIdentityV1, type ProviderLeaseModeV1, type ProviderLeaseQuiescenceV1, type ProviderLeaseV1, type RuntimeServiceV1, type RuntimeServiceKindV1, type RuntimeServiceStatusV1, type RuntimeSnapshotV1 } from "./supervisorV2.js";

export interface ManagedRuntimeOptionsV1 {
  root: string;
  projectId?: string;
  ownerId?: string;
  statePath?: string;
  supervisor?: RuntimeSupervisorV1;
  clock?: () => Date;
  leaseTtlMs?: number;
}

export interface ManagedProviderLeaseInputV1 {
  provider: string;
  workspaceId: string;
  mode: ProviderLeaseModeV1;
  ttlMs?: number;
  lifecycle?: ProviderLeaseLifecycleIdentityV1;
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

/** Stable local identity used when no repository registry record is available yet. */
export function runtimeProjectId(root: string): string {
  return `project:${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}`;
}

/**
 * Controller-facing runtime supervisor. The shared snapshot is the durable
 * coordination authority for process records and provider leases: every
 * mutation reloads under one root-scoped lock and atomically replaces it.
 * Capability authority and ExecutionBinding identity remain separate.
 */
export class ManagedRuntimeSupervisorV1 {
  readonly supervisor: RuntimeSupervisorV1;
  readonly root: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly statePath: string;
  private readonly clock: () => Date;
  private readonly leaseTtlMs?: number;

  constructor(options: ManagedRuntimeOptionsV1) {
    this.root = path.resolve(options.root);
    this.projectId = options.projectId ?? runtimeProjectId(this.root);
    this.ownerId = options.ownerId ?? `runtime:${process.pid}:${randomUUID()}`;
    this.statePath = path.resolve(options.statePath ?? path.join(this.root, ".harness", "runtime", "snapshot.json"));
    this.supervisor = options.supervisor ?? new RuntimeSupervisorV1({ clock: options.clock, leaseTtlMs: options.leaseTtlMs });
    this.clock = options.clock ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs;
  }

  registerService(input: Omit<RuntimeServiceV1, "version" | "projectId" | "canonicalRoot" | "ownerId" | "status" | "startedAt" | "lastHeartbeatAt"> & { kind: RuntimeServiceKindV1; status?: RuntimeServiceStatusV1; metadata?: Record<string, string> }): Promise<RuntimeServiceV1> {
    return this.transact((supervisor) => supervisor.registerService({
      ...input,
      projectId: this.projectId,
      canonicalRoot: this.root,
      ownerId: this.ownerId,
      status: input.status ?? "STARTING",
      metadata: { ...(input.metadata ?? {}), projectId: this.projectId }
    }));
  }

  registerObservedPaseoDaemon(input: Omit<ObservedPaseoDaemonV1, "projectId" | "canonicalRoot">): Promise<RuntimeServiceV1> {
    return this.transact((supervisor) => supervisor.registerObservedPaseoDaemon({
      ...input,
      projectId: this.projectId,
      canonicalRoot: this.root
    }));
  }

  updateService(serviceId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): Promise<RuntimeServiceV1> {
    return this.transact((supervisor) => supervisor.updateService(serviceId, this.ownerId, update));
  }

  heartbeat(serviceId: string): Promise<RuntimeServiceV1> {
    return this.transact((supervisor) => supervisor.heartbeat(serviceId, this.ownerId));
  }

  stopService(serviceId: string, status: "STOPPED" | "FAILED" = "STOPPED"): Promise<RuntimeServiceV1> {
    return this.transact((supervisor) => supervisor.stopService(serviceId, this.ownerId, status));
  }

  acquireProviderLease(input: ManagedProviderLeaseInputV1): Promise<ProviderLeaseV1> {
    return this.transact((supervisor) => supervisor.acquireProviderLease({
      ...input,
      projectId: this.projectId,
      canonicalRoot: this.root,
      ownerId: this.ownerId
    }));
  }

  renewProviderLease(leaseId: string, ttlMs?: number): Promise<ProviderLeaseV1> {
    return this.transact((supervisor) => supervisor.renewProviderLease(leaseId, this.ownerId, ttlMs ?? this.leaseTtlMs));
  }

  updateProviderLeaseLifecycle(leaseId: string, lifecycle: ProviderLeaseLifecycleIdentityV1): Promise<ProviderLeaseV1> {
    return this.transact((supervisor) => supervisor.updateProviderLeaseLifecycle(leaseId, this.ownerId, lifecycle));
  }

  completeProviderLeaseTakeover(leaseId: string, lifecycle: ProviderLeaseLifecycleIdentityV1, quiescence: ProviderLeaseQuiescenceV1): Promise<void> {
    return this.transact((supervisor) => supervisor.completeProviderLeaseTakeover(leaseId, this.ownerId, lifecycle, quiescence));
  }

  releaseProviderLease(leaseId: string): Promise<void> {
    return this.transact((supervisor) => supervisor.releaseProviderLease(leaseId, this.ownerId));
  }

  /** Release all leases owned by this exact runtime controller during drain/cleanup. */
  releaseOwnedProviderLeases(): Promise<void> {
    return this.transact((supervisor) => {
      for (const lease of supervisor.snapshot().providerLeases) {
        if (lease.ownerId === this.ownerId) supervisor.releaseProviderLease(lease.leaseId, this.ownerId);
      }
    });
  }

  /** Drain every service and provider lease owned by this runtime in one transaction. */
  drainAndRelease(): Promise<void> {
    return this.transact((supervisor) => {
      const snapshot = supervisor.snapshot();
      for (const service of snapshot.services) {
        if (service.ownerId === this.ownerId && service.status !== "STOPPED" && service.status !== "FAILED") {
          supervisor.stopService(service.serviceId, this.ownerId);
        }
      }
      for (const lease of supervisor.snapshot().providerLeases) {
        if (lease.ownerId === this.ownerId) supervisor.releaseProviderLease(lease.leaseId, this.ownerId);
      }
    });
  }

  /** Read a current shared snapshot and expire leases before returning it. */
  snapshot(): Promise<RuntimeSnapshotV1> {
    return this.transact((supervisor) => supervisor.snapshot());
  }

  /** Refresh/expire shared state without introducing a second write path. */
  async persist(): Promise<void> {
    await this.snapshot();
  }

  private async transact<T>(action: (supervisor: RuntimeSupervisorV1) => T): Promise<T> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    return withRuntimeLock(this.statePath, async () => {
      const shared = new RuntimeSupervisorV1({ clock: this.clock, leaseTtlMs: this.leaseTtlMs });
      shared.restoreSnapshot(await readRuntimeSnapshot(this.statePath, this.clock().getTime()));
      const result = action(shared);
      const snapshot = shared.snapshot();
      await writeRuntimeSnapshot(this.statePath, snapshot);
      this.supervisor.restoreSnapshot(snapshot);
      return result;
    });
  }
}

export async function readManagedRuntimeSnapshot(root: string, statePath?: string): Promise<RuntimeSnapshotV1> {
  return readRuntimeSnapshot(path.resolve(statePath ?? path.join(root, ".harness", "runtime", "snapshot.json")));
}

async function readRuntimeSnapshot(file: string, now = Date.now()): Promise<RuntimeSnapshotV1> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRuntimeSnapshot();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("INVALID_RUNTIME_SNAPSHOT: persisted runtime state is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_RUNTIME_SNAPSHOT: expected an object.");
  const value = parsed as Partial<RuntimeSnapshotV1>;
  if (value.version !== 1) throw new Error(`UNSUPPORTED_RUNTIME_SNAPSHOT: expected version 1, received ${String(value.version)}.`);
  if (!Array.isArray(value.services) || !Array.isArray(value.providerLeases) || typeof value.capturedAt !== "string") {
    throw new Error("INVALID_RUNTIME_SNAPSHOT: expected capturedAt, services, and providerLeases.");
  }
  const snapshot = value as RuntimeSnapshotV1;
  const validator = new RuntimeSupervisorV1({ clock: () => new Date(now) });
  validator.restoreSnapshot(snapshot);
  return validator.snapshot();
}

function emptyRuntimeSnapshot(): RuntimeSnapshotV1 {
  return { version: 1, capturedAt: new Date(0).toISOString(), services: [], providerLeases: [] };
}

async function writeRuntimeSnapshot(file: string, snapshot: RuntimeSnapshotV1): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function withRuntimeLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      if (!isAlreadyExists(error)) throw error;
      if (await canRecoverLock(lockPath)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring managed runtime lock for ${path.basename(file)}.`);
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function canRecoverLock(lockPath: string): Promise<boolean> {
  try {
    const [rawPid, stat] = await Promise.all([fs.readFile(lockPath, "utf8").catch(() => ""), fs.stat(lockPath)]);
    const pid = Number.parseInt(rawPid.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
    return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
  } catch { return true; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function createManagedRuntime(options: ManagedRuntimeOptionsV1): Promise<ManagedRuntimeSupervisorV1> {
  const runtime = new ManagedRuntimeSupervisorV1(options);
  await runtime.persist();
  return runtime;
}
