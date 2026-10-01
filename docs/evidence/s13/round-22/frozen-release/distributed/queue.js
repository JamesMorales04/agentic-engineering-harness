import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { assertExecutionBindingV2 } from "../architecture/executionIdentity.js";
import { sha256Canonical } from "../core/digest.js";
import { createPromptManifest } from "../context/runtimeV2.js";
export async function submitDistributedJob(root, config, job) {
    if (job.version !== 2)
        throw new Error("UNSUPPORTED_DISTRIBUTED_JOB_VERSION: migrate this job to the two-phase ExecutionBinding session protocol.");
    assertJobSessionPreparation(job);
    if (config.distributed?.provider === "http")
        return submitHttp(config, job);
    const dirs = await queueDirs(root, config);
    await fs.writeFile(path.join(dirs.pending, `${safe(job.id)}.json`), `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
}
export async function claimDistributedJob(root, config, workerId) {
    if (config.distributed?.provider === "http")
        return claimHttp(config, workerId);
    const dirs = await queueDirs(root, config);
    await reclaimExpired(dirs);
    const files = (await fs.readdir(dirs.pending)).filter((name) => name.endsWith(".json")).sort();
    for (const file of files) {
        const source = path.join(dirs.pending, file);
        const leaseId = `${workerId}-${crypto.randomUUID()}`;
        const destination = path.join(dirs.leased, `${safe(leaseId)}.json`);
        try {
            const raw = await fs.readFile(source, "utf8");
            const job = JSON.parse(raw);
            const now = Date.now();
            const envelope = { leaseId, workerId, leasedAt: new Date(now).toISOString(), expiresAt: new Date(now + (config.distributed?.leaseSeconds ?? 1800) * 1000).toISOString(), job };
            await fs.rename(source, destination);
            await fs.writeFile(destination, `${JSON.stringify(envelope, null, 2)}\n`);
            return { job, leaseId };
        }
        catch (error) {
            if (error?.code === "ENOENT")
                continue;
            throw error;
        }
    }
    return undefined;
}
export async function completeDistributedJob(root, config, leaseId, result) {
    if (config.distributed?.provider === "http")
        return completeHttp(config, leaseId, result);
    const dirs = await queueDirs(root, config);
    const leaseFile = path.join(dirs.leased, `${safe(leaseId)}.json`);
    const envelope = await readLease(leaseFile);
    if (envelope.leaseId !== leaseId || envelope.job.id !== result.jobId || envelope.workerId !== result.workerId)
        throw new Error("DISTRIBUTED_QUEUE_LEASE_OWNER_MISMATCH");
    await fs.writeFile(path.join(dirs.completed, `${safe(result.jobId)}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await fs.rm(leaseFile, { force: true });
}
export async function waitForDistributedResult(root, config, jobId, timeoutMs) {
    const timeout = timeoutMs ?? (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000;
    const deadline = Date.now() + timeout;
    const interval = config.distributed?.pollIntervalMs ?? 1000;
    while (Date.now() < deadline) {
        const result = config.distributed?.provider === "http" ? await getHttpResult(config, jobId) : await getFilesystemResult(root, config, jobId);
        if (result)
            return result;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Distributed job ${jobId} timed out after ${timeout}ms.`);
}
export async function publishDistributedSessionReady(root, config, ready) {
    if (config.distributed?.provider === "http") {
        const response = await request(config, `/v1/leases/${encodeURIComponent(ready.leaseId)}/prepared`, { method: "POST", body: JSON.stringify(ready), headers: { "content-type": "application/json" } });
        if (!response.ok)
            throw new Error(`Distributed session preparation receipt was rejected: HTTP ${response.status}`);
        return;
    }
    const dirs = await queueDirs(root, config);
    const lease = await readLease(path.join(dirs.leased, `${safe(ready.leaseId)}.json`));
    assertReadyMatchesLease(ready, lease);
    await fs.writeFile(path.join(dirs.prepared, `${safe(ready.jobId)}.json`), `${JSON.stringify(ready, null, 2)}\n`, { flag: "wx" });
}
export async function waitForDistributedSessionReady(root, config, jobId, timeoutMs) {
    const timeout = timeoutMs ?? (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000;
    const deadline = Date.now() + timeout;
    const interval = config.distributed?.pollIntervalMs ?? 1000;
    while (Date.now() < deadline) {
        const ready = config.distributed?.provider === "http" ? await getHttpSessionReady(config, jobId) : await getFilesystemSessionReady(root, config, jobId);
        if (ready)
            return ready;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Distributed session preparation for ${jobId} timed out after ${timeout}ms.`);
}
export async function releaseDistributedExecutionBinding(root, config, release) {
    if (config.distributed?.provider === "http") {
        const response = await request(config, `/v1/jobs/${encodeURIComponent(release.jobId)}/release`, { method: "POST", body: JSON.stringify(release), headers: { "content-type": "application/json" } });
        if (!response.ok)
            throw new Error(`Distributed execution binding release was rejected: HTTP ${response.status}`);
        return;
    }
    const dirs = await queueDirs(root, config);
    const lease = await readLease(path.join(dirs.leased, `${safe(release.leaseId)}.json`));
    const ready = await getFilesystemSessionReady(root, config, release.jobId);
    assertReleaseMatchesLease(release, lease, ready);
    await fs.writeFile(path.join(dirs.released, `${safe(release.jobId)}.json`), `${JSON.stringify(release, null, 2)}\n`, { flag: "wx" });
}
export async function waitForDistributedExecutionRelease(root, config, jobId, workerId, leaseId, timeoutMs) {
    const timeout = timeoutMs ?? (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000;
    const deadline = Date.now() + timeout;
    const interval = config.distributed?.pollIntervalMs ?? 1000;
    while (Date.now() < deadline) {
        const release = config.distributed?.provider === "http" ? await getHttpExecutionRelease(config, leaseId, jobId) : await getFilesystemExecutionRelease(root, config, jobId);
        if (release) {
            if (release.jobId !== jobId || release.workerId !== workerId || release.leaseId !== leaseId)
                throw new Error("DISTRIBUTED_EXECUTION_RELEASE_OWNER_MISMATCH");
            return release;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Distributed binding release for ${jobId} timed out after ${timeout}ms.`);
}
export async function serveDistributedQueue(root, config, options) {
    if (config.distributed?.provider === "http")
        throw new Error("Queue server must use its local filesystem backing store; configure provider=filesystem on the coordinator server.");
    const token = config.distributed?.tokenEnv ? process.env[config.distributed.tokenEnv] : undefined;
    const host = options.host ?? "127.0.0.1";
    if (!token)
        throw new Error("Distributed HTTP queue requires distributed.tokenEnv with a non-empty token, including on loopback.");
    const server = http.createServer(async (request, response) => {
        try {
            if (request.headers.authorization !== `Bearer ${token}`) {
                json(response, 401, { error: "unauthorized" });
                return;
            }
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            if (request.method === "POST" && url.pathname === "/v1/jobs") {
                const job = await readJsonBody(request);
                await submitDistributedJob(root, config, job);
                json(response, 202, { id: job.id });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v1/claim") {
                const body = await readJsonBody(request);
                const claimed = await claimDistributedJob(root, config, body.workerId);
                json(response, claimed ? 200 : 204, claimed);
                return;
            }
            const complete = url.pathname.match(/^\/v1\/leases\/([^/]+)\/complete$/);
            if (request.method === "POST" && complete) {
                const result = await readJsonBody(request);
                await completeDistributedJob(root, config, decodeURIComponent(complete[1]), result);
                json(response, 200, { ok: true });
                return;
            }
            const prepared = url.pathname.match(/^\/v1\/leases\/([^/]+)\/prepared$/);
            if (request.method === "POST" && prepared) {
                const ready = await readJsonBody(request);
                if (ready.leaseId !== decodeURIComponent(prepared[1]))
                    throw new Error("DISTRIBUTED_SESSION_READY_LEASE_MISMATCH");
                await publishDistributedSessionReady(root, config, ready);
                json(response, 202, { ok: true });
                return;
            }
            const workerRelease = url.pathname.match(/^\/v1\/leases\/([^/]+)\/release$/);
            if (request.method === "GET" && workerRelease) {
                const jobId = url.searchParams.get("jobId") ?? "";
                const release = await getFilesystemExecutionRelease(root, config, jobId);
                if (!release) {
                    json(response, 204, undefined);
                    return;
                }
                if (release.leaseId !== decodeURIComponent(workerRelease[1]))
                    throw new Error("DISTRIBUTED_EXECUTION_RELEASE_LEASE_MISMATCH");
                json(response, 200, release);
                return;
            }
            const releaseMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/release$/);
            if (releaseMatch && request.method === "POST") {
                const release = await readJsonBody(request);
                if (release.jobId !== decodeURIComponent(releaseMatch[1]))
                    throw new Error("DISTRIBUTED_EXECUTION_RELEASE_JOB_MISMATCH");
                await releaseDistributedExecutionBinding(root, config, release);
                json(response, 200, { ok: true });
                return;
            }
            const readyLookup = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/prepared$/);
            if (request.method === "GET" && readyLookup) {
                const ready = await getFilesystemSessionReady(root, config, decodeURIComponent(readyLookup[1]));
                json(response, ready ? 200 : 404, ready ?? { error: "not-ready" });
                return;
            }
            const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
            if (request.method === "GET" && resultMatch) {
                const result = await getFilesystemResult(root, config, decodeURIComponent(resultMatch[1]));
                json(response, result ? 200 : 404, result ?? { error: "not-ready" });
                return;
            }
            json(response, 404, { error: "not-found" });
        }
        catch (error) {
            json(response, error instanceof Error && error.message === "DISTRIBUTED_QUEUE_BODY_TOO_LARGE" ? 413 : 500, { error: String(error) });
        }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port, host, () => resolve()); });
    return server;
}
async function getFilesystemResult(root, config, jobId) { const dirs = await queueDirs(root, config); try {
    return JSON.parse(await fs.readFile(path.join(dirs.completed, `${safe(jobId)}.json`), "utf8"));
}
catch {
    return undefined;
} }
async function getFilesystemSessionReady(root, config, jobId) { const dirs = await queueDirs(root, config); try {
    return JSON.parse(await fs.readFile(path.join(dirs.prepared, `${safe(jobId)}.json`), "utf8"));
}
catch {
    return undefined;
} }
async function getFilesystemExecutionRelease(root, config, jobId) { const dirs = await queueDirs(root, config); try {
    return JSON.parse(await fs.readFile(path.join(dirs.released, `${safe(jobId)}.json`), "utf8"));
}
catch {
    return undefined;
} }
async function readLease(file) { try {
    return JSON.parse(await fs.readFile(file, "utf8"));
}
catch {
    throw new Error("DISTRIBUTED_QUEUE_LEASE_NOT_FOUND");
} }
async function queueDirs(root, config) { const base = path.resolve(root, config.distributed?.queueDir ?? ".harness/distributed"); const dirs = { root: base, pending: path.join(base, "pending"), leased: path.join(base, "leased"), completed: path.join(base, "completed"), prepared: path.join(base, "prepared"), released: path.join(base, "released") }; await Promise.all([dirs.pending, dirs.leased, dirs.completed, dirs.prepared, dirs.released].map((dir) => fs.mkdir(dir, { recursive: true }))); return dirs; }
async function reclaimExpired(dirs) { const files = (await fs.readdir(dirs.leased)).filter((name) => name.endsWith(".json")); for (const file of files) {
    try {
        const envelope = JSON.parse(await fs.readFile(path.join(dirs.leased, file), "utf8"));
        if (Date.parse(envelope.expiresAt) <= Date.now()) {
            await fs.writeFile(path.join(dirs.pending, `${safe(envelope.job.id)}.json`), `${JSON.stringify(envelope.job, null, 2)}\n`, { flag: "wx" }).catch(() => undefined);
            await fs.rm(path.join(dirs.leased, file), { force: true });
        }
    }
    catch { /* malformed lease stays visible for operator inspection */ }
} }
async function submitHttp(config, job) { const response = await request(config, "/v1/jobs", { method: "POST", body: JSON.stringify(job), headers: { "content-type": "application/json" } }); if (!response.ok)
    throw new Error(`Distributed queue rejected job: HTTP ${response.status} ${await response.text()}`); }
async function claimHttp(config, workerId) { const response = await request(config, "/v1/claim", { method: "POST", body: JSON.stringify({ workerId }), headers: { "content-type": "application/json" } }); if (response.status === 204)
    return undefined; if (!response.ok)
    throw new Error(`Distributed queue claim failed: HTTP ${response.status}`); return await response.json(); }
async function completeHttp(config, leaseId, result) { const response = await request(config, `/v1/leases/${encodeURIComponent(leaseId)}/complete`, { method: "POST", body: JSON.stringify(result), headers: { "content-type": "application/json" } }); if (!response.ok)
    throw new Error(`Distributed queue completion failed: HTTP ${response.status}`); }
async function getHttpResult(config, jobId) { const response = await request(config, `/v1/jobs/${encodeURIComponent(jobId)}`); if (response.status === 404)
    return undefined; if (!response.ok)
    throw new Error(`Distributed queue result lookup failed: HTTP ${response.status}`); return await response.json(); }
async function getHttpSessionReady(config, jobId) { const response = await request(config, `/v1/jobs/${encodeURIComponent(jobId)}/prepared`); if (response.status === 404)
    return undefined; if (!response.ok)
    throw new Error(`Distributed session preparation lookup failed: HTTP ${response.status}`); return await response.json(); }
async function getHttpExecutionRelease(config, leaseId, jobId) { const response = await request(config, `/v1/leases/${encodeURIComponent(leaseId)}/release?jobId=${encodeURIComponent(jobId)}`); if (response.status === 204)
    return undefined; if (!response.ok)
    throw new Error(`Distributed execution binding release lookup failed: HTTP ${response.status}`); return await response.json(); }
async function request(config, pathname, init = {}) { const endpoint = config.distributed?.endpoint; if (!endpoint)
    throw new Error("distributed.endpoint is required for HTTP distributed queues."); const headers = new Headers(init.headers); const token = config.distributed?.tokenEnv ? process.env[config.distributed.tokenEnv] : undefined; if (token)
    headers.set("authorization", `Bearer ${token}`); return fetch(new URL(pathname, endpoint).toString(), { ...init, headers }); }
async function readJsonBody(request) { const maxBytes = 1024 * 1024; const declared = Number(request.headers["content-length"] ?? 0); if (declared > maxBytes)
    throw new Error("DISTRIBUTED_QUEUE_BODY_TOO_LARGE"); const chunks = []; let size = 0; for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes)
        throw new Error("DISTRIBUTED_QUEUE_BODY_TOO_LARGE");
    chunks.push(buffer);
} return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function json(response, status, value) { response.statusCode = status; if (value === undefined) {
    response.end();
    return;
} response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function assertReadyMatchesLease(ready, lease) {
    assertJobSessionPreparation(lease.job);
    if (ready.version !== 1 || ready.jobId !== lease.job.id || ready.workerId !== lease.workerId || ready.leaseId !== lease.leaseId || !ready.runtime?.sessionId?.trim() || ready.runtime.sessionId.startsWith("launch:") || ready.runtime.runtimeId !== lease.job.selection.runtimeName || ready.runtime.provider !== (lease.job.selection.modelProvider ?? lease.job.selection.paseoProvider ?? lease.job.selection.runtimeAdapter) || ready.runtime.modelId !== lease.job.selection.modelId || ready.runtime.model !== lease.job.selection.modelName || ready.contextManifestDigest !== lease.job.sessionPreparation.contextManifestDigest || ready.promptManifestDigest !== lease.job.sessionPreparation.promptManifestDigest || ready.sessionPreparation !== "RUNTIME_MATERIALIZED")
        throw new Error("DISTRIBUTED_SESSION_READY_IDENTITY_MISMATCH");
}
function assertJobSessionPreparation(job) {
    const contextDigest = job.sessionPreparation?.contextManifest ? sha256Canonical(job.sessionPreparation.contextManifest) : "";
    const promptDigest = typeof job.prompt === "string" ? createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: job.prompt, role: job.selection.role, source: "agent-prompt-projection" }] }).digest : "";
    if (!/^[a-f0-9]{64}$/.test(job.sessionPreparation?.contextManifestDigest ?? "") || contextDigest !== job.sessionPreparation.contextManifestDigest || promptDigest !== job.sessionPreparation.promptManifestDigest)
        throw new Error("DISTRIBUTED_EXECUTION_IDENTITY_INVALID: distributed job manifests do not match the actual frozen context and prompt.");
}
function assertReleaseMatchesLease(release, lease, ready) {
    assertExecutionBindingV2(release.executionBinding);
    if (!ready)
        throw new Error("DISTRIBUTED_SESSION_PREPARATION_REQUIRED");
    assertReadyMatchesLease(ready, lease);
    const binding = release.executionBinding;
    if (release.version !== 1 || release.jobId !== lease.job.id || release.workerId !== lease.workerId || release.leaseId !== lease.leaseId || binding.operationId !== lease.job.executionAuthority.operationId || binding.participantId !== lease.job.executionAuthority.participantId || binding.candidateDigest !== lease.job.executionAuthority.candidateDigest || binding.controllerEpoch !== lease.job.executionAuthority.controllerEpoch || binding.executionBlueprintDigest !== lease.job.executionBlueprint.digest || binding.roleInvocationPolicyDigest !== lease.job.roleInvocationPolicy.digest || binding.skillManifestDigest !== lease.job.skillManifest.digest || binding.runtime.sessionId !== ready.runtime.sessionId || binding.runtime.runtimeId !== ready.runtime.runtimeId || binding.runtime.provider !== ready.runtime.provider || binding.runtime.modelId !== ready.runtime.modelId || binding.runtime.model !== ready.runtime.model || binding.contextManifestDigest !== ready.contextManifestDigest || binding.promptManifestDigest !== ready.promptManifestDigest)
        throw new Error("DISTRIBUTED_EXECUTION_RELEASE_IDENTITY_MISMATCH");
}
function safe(value) { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
//# sourceMappingURL=queue.js.map