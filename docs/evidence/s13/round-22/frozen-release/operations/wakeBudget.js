import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOperationStateRoot } from "./state.js";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
export function operationWakeBudgetFile(root, operationId) {
    return path.resolve(resolveOperationStateRoot(root), ".harness/operations", `${safeId(operationId)}.wake.json`);
}
export async function loadOperationWakeBudget(root, operationId, revision) {
    try {
        const parsed = JSON.parse(await fs.readFile(operationWakeBudgetFile(root, operationId), "utf8"));
        if (parsed.version !== 1 || parsed.operationId !== operationId || parsed.revision !== revision)
            return empty(operationId, revision);
        return {
            ...parsed,
            supervisorAccepted: count(parsed.supervisorAccepted),
            leadAccepted: count(parsed.leadAccepted),
            terminalLeadAccepted: count(parsed.terminalLeadAccepted)
        };
    }
    catch (error) {
        if (isMissing(error))
            return empty(operationId, revision);
        throw error;
    }
}
export async function recordOperationWakeAccepted(root, operationId, revision, target, reason) {
    const file = operationWakeBudgetFile(root, operationId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withLock(file, async () => {
        const previous = await loadUnlocked(file, operationId, revision);
        const now = new Date().toISOString();
        const next = {
            ...previous,
            supervisorAccepted: previous.supervisorAccepted + (target === "supervisor" ? 1 : 0),
            leadAccepted: previous.leadAccepted + (target === "lead" ? 1 : 0),
            terminalLeadAccepted: previous.terminalLeadAccepted + (target === "lead" && reason === "terminal" ? 1 : 0),
            updatedAt: now,
            lastAcceptedAt: now
        };
        await writeAtomic(file, next);
        return next;
    });
}
async function loadUnlocked(file, operationId, revision) {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (parsed.version !== 1 || parsed.operationId !== operationId || parsed.revision !== revision)
            return empty(operationId, revision);
        return {
            ...parsed,
            supervisorAccepted: count(parsed.supervisorAccepted),
            leadAccepted: count(parsed.leadAccepted),
            terminalLeadAccepted: count(parsed.terminalLeadAccepted)
        };
    }
    catch (error) {
        if (isMissing(error))
            return empty(operationId, revision);
        throw error;
    }
}
function empty(operationId, revision) {
    return {
        version: 1,
        operationId,
        revision,
        supervisorAccepted: 0,
        leadAccepted: 0,
        terminalLeadAccepted: 0,
        updatedAt: new Date().toISOString()
    };
}
async function writeAtomic(file, budget) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(budget, null, 2)}\n`);
    try {
        await fs.rename(temp, file);
    }
    finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
    }
}
async function withLock(file, action) {
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
            if (handle)
                throw error;
            if (!isAlreadyExists(error))
                throw error;
            if (await canRecoverLock(lock)) {
                await fs.rm(lock, { force: true }).catch(() => undefined);
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out acquiring wake budget lock for ${path.basename(file)}.`);
            await delay(LOCK_RETRY_MS);
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
function count(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function safeId(value) { if (!/^[A-Za-z0-9._-]+$/.test(value))
    throw new Error(`Invalid operation id '${value}'.`); return value; }
function isMissing(error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function isAlreadyExists(error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
//# sourceMappingURL=wakeBudget.js.map