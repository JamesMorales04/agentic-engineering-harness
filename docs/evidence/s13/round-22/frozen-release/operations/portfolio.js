import fs from "node:fs/promises";
import path from "node:path";
import { activeOperationSupervisor } from "./state.js";
const DEFAULT_POLICY = {
    maxActiveOperations: 5, maxActiveAgents: 16, maxAgentsPerOperation: 8, maxProviderAgents: { codex: 4, opencode: 8 }
};
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
export function operationPortfolioFile(root) { return path.resolve(root, ".harness/operations/portfolio.json"); }
export async function loadOperationPortfolio(root, project = "unknown") {
    return readPortfolio(operationPortfolioFile(root), project);
}
export async function syncOperationPortfolio(root, project, operation) {
    return mutatePortfolio(root, project, (current) => {
        const supervisor = activeOperationSupervisor(operation);
        return {
            ...current,
            project,
            leadAgentId: operation.lead?.agentId ?? current.leadAgentId,
            leadGeneration: Math.max(current.leadGeneration, operation.lead?.generation ?? 0),
            updatedAt: new Date().toISOString(),
            operations: {
                ...current.operations,
                [operation.id]: {
                    operationId: operation.id, kind: operation.kind, status: operation.status, phase: operation.phase,
                    workspaceId: operation.workspaceId, supervisorAgentId: supervisor?.agentId, supervisorGeneration: supervisor?.generation,
                    revision: operation.revision,
                    acknowledgedRevision: operation.lead?.acknowledgedRevision ?? operation.notification.lastLeadWakeRevision,
                    priority: operation.intent?.priority ?? 50,
                    updatedAt: operation.updatedAt
                }
            }
        };
    });
}
export async function bindPortfolioLead(root, project, agentId, generation) {
    return mutatePortfolio(root, project, (current) => ({
        ...current, project, leadAgentId: agentId,
        leadGeneration: generation ?? current.leadGeneration + 1,
        updatedAt: new Date().toISOString()
    }));
}
export function operationConcurrencyPolicy(config) {
    const orchestration = config.orchestration;
    const configured = orchestration?.operations?.concurrency;
    return {
        maxActiveOperations: positive(configured?.maxActiveOperations, DEFAULT_POLICY.maxActiveOperations),
        maxActiveAgents: positive(configured?.maxActiveAgents, DEFAULT_POLICY.maxActiveAgents),
        maxAgentsPerOperation: positive(configured?.maxAgentsPerOperation, DEFAULT_POLICY.maxAgentsPerOperation),
        maxProviderAgents: { ...DEFAULT_POLICY.maxProviderAgents, ...(configured?.maxProviderAgents ?? {}) }
    };
}
export async function assertOperationCapacity(root, config, requestedPriority = 50) {
    const file = operationPortfolioFile(root);
    const policy = operationConcurrencyPolicy(config);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await withPortfolioLock(file, async () => {
        const portfolio = await readPortfolio(file, config.project.name);
        const active = Object.values(portfolio.operations).filter((item) => item.status === "QUEUED" || item.status === "RUNNING");
        if (active.length < policy.maxActiveOperations)
            return;
        const lowest = active.reduce((min, item) => Math.min(min, item.priority), Number.POSITIVE_INFINITY);
        throw new Error(`AEH_OPERATION_CAPACITY: ${active.length} active operations already consume the configured lead/project limit ${policy.maxActiveOperations}. Requested priority=${requestedPriority}; current lowest priority=${Number.isFinite(lowest) ? lowest : "n/a"}. Wait, cancel, or raise the configured orchestration.operations.concurrency.maxActiveOperations limit.`);
    });
}
async function mutatePortfolio(root, project, mutate) {
    const file = operationPortfolioFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withPortfolioLock(file, async () => {
        // Atomic rename alone does not prevent lost updates: multiple operation
        // controllers must serialize the complete read-modify-write transaction.
        const current = await readPortfolio(file, project);
        const next = mutate(current);
        await persistUnlocked(file, next);
        return next;
    });
}
async function readPortfolio(file, project) {
    try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        if (value.version !== 1 || !value.operations)
            throw new Error("invalid portfolio record");
        return value;
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
        return { version: 1, project, leadGeneration: 0, updatedAt: new Date().toISOString(), operations: {} };
    }
}
async function persistUnlocked(file, portfolio) {
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(portfolio, null, 2)}\n`);
    try {
        await fs.rename(temp, file);
    }
    finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
    }
}
async function withPortfolioLock(file, action) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        let handle;
        try {
            handle = await fs.open(lock, "wx");
            try {
                await handle.writeFile(`${process.pid}\n`);
                return await action();
            }
            finally {
                await handle.close().catch(() => undefined);
                await fs.rm(lock, { force: true }).catch(() => undefined);
            }
        }
        catch (error) {
            if (handle) {
                await handle.close().catch(() => undefined);
                await fs.rm(lock, { force: true }).catch(() => undefined);
                throw error;
            }
            if (!isAlreadyExists(error))
                throw error;
            if (await canRecoverLock(lock)) {
                await fs.rm(lock, { force: true }).catch(() => undefined);
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out acquiring operation portfolio lock for ${path.basename(file)}.`);
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }
}
async function canRecoverLock(lock) {
    try {
        const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]);
        const ownerPid = Number.parseInt(rawPid.trim(), 10);
        if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid))
            return true;
        return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    }
    catch {
        return true;
    }
}
function processAlive(pid) { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} }
function positive(value, fallback) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function isMissing(error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function isAlreadyExists(error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST"); }
//# sourceMappingURL=portfolio.js.map