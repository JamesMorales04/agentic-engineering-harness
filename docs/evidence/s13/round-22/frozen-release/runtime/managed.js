import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeSupervisorV1 } from "./supervisorV2.js";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
/** Stable local identity used when no repository registry record is available yet. */
export function runtimeProjectId(root) {
    return `project:${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}`;
}
/**
 * Controller-facing runtime supervisor. The shared snapshot is the durable
 * coordination authority for process records and provider leases: every
 * mutation reloads under one root-scoped lock and atomically replaces it.
 * Capability authority and ExecutionBinding identity remain separate.
 */
export class ManagedRuntimeSupervisorV1 {
    supervisor;
    root;
    projectId;
    ownerId;
    statePath;
    clock;
    leaseTtlMs;
    constructor(options) {
        this.root = path.resolve(options.root);
        this.projectId = options.projectId ?? runtimeProjectId(this.root);
        this.ownerId = options.ownerId ?? `runtime:${process.pid}:${randomUUID()}`;
        this.statePath = path.resolve(options.statePath ?? path.join(this.root, ".harness", "runtime", "snapshot.json"));
        this.supervisor = options.supervisor ?? new RuntimeSupervisorV1({ clock: options.clock, leaseTtlMs: options.leaseTtlMs });
        this.clock = options.clock ?? (() => new Date());
        this.leaseTtlMs = options.leaseTtlMs;
    }
    registerService(input) {
        return this.transact((supervisor) => supervisor.registerService({
            ...input,
            projectId: this.projectId,
            canonicalRoot: this.root,
            ownerId: this.ownerId,
            status: input.status ?? "STARTING",
            metadata: { ...(input.metadata ?? {}), projectId: this.projectId }
        }));
    }
    registerObservedPaseoDaemon(input) {
        return this.transact((supervisor) => supervisor.registerObservedPaseoDaemon({
            ...input,
            projectId: this.projectId,
            canonicalRoot: this.root
        }));
    }
    updateService(serviceId, update) {
        return this.transact((supervisor) => supervisor.updateService(serviceId, this.ownerId, update));
    }
    heartbeat(serviceId) {
        return this.transact((supervisor) => supervisor.heartbeat(serviceId, this.ownerId));
    }
    stopService(serviceId, status = "STOPPED") {
        return this.transact((supervisor) => supervisor.stopService(serviceId, this.ownerId, status));
    }
    acquireProviderLease(input) {
        return this.transact((supervisor) => supervisor.acquireProviderLease({
            ...input,
            projectId: this.projectId,
            canonicalRoot: this.root,
            ownerId: this.ownerId
        }));
    }
    renewProviderLease(leaseId, ttlMs) {
        return this.transact((supervisor) => supervisor.renewProviderLease(leaseId, this.ownerId, ttlMs ?? this.leaseTtlMs));
    }
    updateProviderLeaseLifecycle(leaseId, lifecycle) {
        return this.transact((supervisor) => supervisor.updateProviderLeaseLifecycle(leaseId, this.ownerId, lifecycle));
    }
    completeProviderLeaseTakeover(leaseId, lifecycle, quiescence) {
        return this.transact((supervisor) => supervisor.completeProviderLeaseTakeover(leaseId, this.ownerId, lifecycle, quiescence));
    }
    releaseProviderLease(leaseId) {
        return this.transact((supervisor) => supervisor.releaseProviderLease(leaseId, this.ownerId));
    }
    /** Release all leases owned by this exact runtime controller during drain/cleanup. */
    releaseOwnedProviderLeases() {
        return this.transact((supervisor) => {
            for (const lease of supervisor.snapshot().providerLeases) {
                if (lease.ownerId === this.ownerId)
                    supervisor.releaseProviderLease(lease.leaseId, this.ownerId);
            }
        });
    }
    /** Drain every service and provider lease owned by this runtime in one transaction. */
    drainAndRelease() {
        return this.transact((supervisor) => {
            const snapshot = supervisor.snapshot();
            for (const service of snapshot.services) {
                if (service.ownerId === this.ownerId && service.status !== "STOPPED" && service.status !== "FAILED") {
                    supervisor.stopService(service.serviceId, this.ownerId);
                }
            }
            for (const lease of supervisor.snapshot().providerLeases) {
                if (lease.ownerId === this.ownerId)
                    supervisor.releaseProviderLease(lease.leaseId, this.ownerId);
            }
        });
    }
    /** Read a current shared snapshot and expire leases before returning it. */
    snapshot() {
        return this.transact((supervisor) => supervisor.snapshot());
    }
    /** Refresh/expire shared state without introducing a second write path. */
    async persist() {
        await this.snapshot();
    }
    async transact(action) {
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
export async function readManagedRuntimeSnapshot(root, statePath) {
    return readRuntimeSnapshot(path.resolve(statePath ?? path.join(root, ".harness", "runtime", "snapshot.json")));
}
async function readRuntimeSnapshot(file, now = Date.now()) {
    let raw;
    try {
        raw = await fs.readFile(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return emptyRuntimeSnapshot();
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("INVALID_RUNTIME_SNAPSHOT: persisted runtime state is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("INVALID_RUNTIME_SNAPSHOT: expected an object.");
    const value = parsed;
    if (value.version !== 1)
        throw new Error(`UNSUPPORTED_RUNTIME_SNAPSHOT: expected version 1, received ${String(value.version)}.`);
    if (!Array.isArray(value.services) || !Array.isArray(value.providerLeases) || typeof value.capturedAt !== "string") {
        throw new Error("INVALID_RUNTIME_SNAPSHOT: expected capturedAt, services, and providerLeases.");
    }
    const snapshot = value;
    const validator = new RuntimeSupervisorV1({ clock: () => new Date(now) });
    validator.restoreSnapshot(snapshot);
    return validator.snapshot();
}
function emptyRuntimeSnapshot() {
    return { version: 1, capturedAt: new Date(0).toISOString(), services: [], providerLeases: [] };
}
async function writeRuntimeSnapshot(file, snapshot) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}
async function withRuntimeLock(file, action) {
    const lockPath = `${file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        let handle;
        try {
            handle = await fs.open(lockPath, "wx", 0o600);
            try {
                await handle.writeFile(`${process.pid}\n`);
                await handle.sync();
                return await action();
            }
            finally {
                await handle.close().catch(() => undefined);
                await fs.rm(lockPath, { force: true }).catch(() => undefined);
            }
        }
        catch (error) {
            if (handle) {
                await handle.close().catch(() => undefined);
                await fs.rm(lockPath, { force: true }).catch(() => undefined);
                throw error;
            }
            if (!isAlreadyExists(error))
                throw error;
            if (await canRecoverLock(lockPath)) {
                await fs.rm(lockPath, { force: true }).catch(() => undefined);
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out acquiring managed runtime lock for ${path.basename(file)}.`);
            await delay(LOCK_RETRY_MS);
        }
    }
}
async function canRecoverLock(lockPath) {
    try {
        const [rawPid, stat] = await Promise.all([fs.readFile(lockPath, "utf8").catch(() => ""), fs.stat(lockPath)]);
        const pid = Number.parseInt(rawPid.trim(), 10);
        if (Number.isInteger(pid) && pid > 0)
            return !processAlive(pid);
        return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    }
    catch {
        return true;
    }
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function isAlreadyExists(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
export async function createManagedRuntime(options) {
    const runtime = new ManagedRuntimeSupervisorV1(options);
    await runtime.persist();
    return runtime;
}
//# sourceMappingURL=managed.js.map