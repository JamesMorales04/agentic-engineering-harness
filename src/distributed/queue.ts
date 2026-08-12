import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import type { ClaimedJob, DistributedDelegationJob, DistributedDelegationResult } from "./types.js";

interface LeaseEnvelope { leaseId: string; leasedAt: string; expiresAt: string; job: DistributedDelegationJob; }

export async function submitDistributedJob(root: string, config: HarnessProjectConfig, job: DistributedDelegationJob): Promise<void> {
  if (config.distributed?.provider === "http") return submitHttp(config, job);
  const dirs = await queueDirs(root, config); await fs.writeFile(path.join(dirs.pending, `${safe(job.id)}.json`), `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
}

export async function claimDistributedJob(root: string, config: HarnessProjectConfig, workerId: string): Promise<ClaimedJob | undefined> {
  if (config.distributed?.provider === "http") return claimHttp(config, workerId);
  const dirs = await queueDirs(root, config); await reclaimExpired(dirs);
  const files = (await fs.readdir(dirs.pending)).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const source = path.join(dirs.pending, file); const leaseId = `${workerId}-${crypto.randomUUID()}`; const destination = path.join(dirs.leased, `${safe(leaseId)}.json`);
    try {
      const raw = await fs.readFile(source, "utf8"); const job = JSON.parse(raw) as DistributedDelegationJob; const now = Date.now(); const envelope: LeaseEnvelope = { leaseId, leasedAt: new Date(now).toISOString(), expiresAt: new Date(now + (config.distributed?.leaseSeconds ?? 1800) * 1000).toISOString(), job };
      await fs.rename(source, destination); await fs.writeFile(destination, `${JSON.stringify(envelope, null, 2)}\n`); return { job, leaseId };
    } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
  }
  return undefined;
}

export async function completeDistributedJob(root: string, config: HarnessProjectConfig, leaseId: string, result: DistributedDelegationResult): Promise<void> {
  if (config.distributed?.provider === "http") return completeHttp(config, leaseId, result);
  const dirs = await queueDirs(root, config); const leaseFile = path.join(dirs.leased, `${safe(leaseId)}.json`);
  await fs.writeFile(path.join(dirs.completed, `${safe(result.jobId)}.json`), `${JSON.stringify(result, null, 2)}\n`); await fs.rm(leaseFile, { force: true });
}

export async function waitForDistributedResult(root: string, config: HarnessProjectConfig, jobId: string, timeoutMs?: number): Promise<DistributedDelegationResult> {
  const timeout = timeoutMs ?? (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000; const deadline = Date.now() + timeout; const interval = config.distributed?.pollIntervalMs ?? 1000;
  while (Date.now() < deadline) {
    const result = config.distributed?.provider === "http" ? await getHttpResult(config, jobId) : await getFilesystemResult(root, config, jobId);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Distributed job ${jobId} timed out after ${timeout}ms.`);
}

export async function serveDistributedQueue(root: string, config: HarnessProjectConfig, options: { port: number; host?: string }): Promise<http.Server> {
  if (config.distributed?.provider === "http") throw new Error("Queue server must use its local filesystem backing store; configure provider=filesystem on the coordinator server.");
  const token = config.distributed?.tokenEnv ? process.env[config.distributed.tokenEnv] : undefined;
  const server = http.createServer(async (request, response) => {
    try {
      if (token && request.headers.authorization !== `Bearer ${token}`) { json(response, 401, { error: "unauthorized" }); return; }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && url.pathname === "/v1/jobs") { const job = await readJsonBody<DistributedDelegationJob>(request); await submitDistributedJob(root, config, job); json(response, 202, { id: job.id }); return; }
      if (request.method === "POST" && url.pathname === "/v1/claim") { const body = await readJsonBody<{ workerId: string }>(request); const claimed = await claimDistributedJob(root, config, body.workerId); json(response, claimed ? 200 : 204, claimed); return; }
      const complete = url.pathname.match(/^\/v1\/leases\/([^/]+)\/complete$/); if (request.method === "POST" && complete) { const result = await readJsonBody<DistributedDelegationResult>(request); await completeDistributedJob(root, config, decodeURIComponent(complete[1]), result); json(response, 200, { ok: true }); return; }
      const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/); if (request.method === "GET" && resultMatch) { const result = await getFilesystemResult(root, config, decodeURIComponent(resultMatch[1])); json(response, result ? 200 : 404, result ?? { error: "not-ready" }); return; }
      json(response, 404, { error: "not-found" });
    } catch (error) { json(response, 500, { error: String(error) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host ?? "127.0.0.1", () => resolve()); }); return server;
}

async function getFilesystemResult(root: string, config: HarnessProjectConfig, jobId: string): Promise<DistributedDelegationResult | undefined> { const dirs = await queueDirs(root, config); try { return JSON.parse(await fs.readFile(path.join(dirs.completed, `${safe(jobId)}.json`), "utf8")) as DistributedDelegationResult; } catch { return undefined; } }
async function queueDirs(root: string, config: HarnessProjectConfig): Promise<{ root: string; pending: string; leased: string; completed: string }> { const base = path.resolve(root, config.distributed?.queueDir ?? ".harness/distributed"); const dirs = { root: base, pending: path.join(base, "pending"), leased: path.join(base, "leased"), completed: path.join(base, "completed") }; await Promise.all([dirs.pending, dirs.leased, dirs.completed].map((dir) => fs.mkdir(dir, { recursive: true }))); return dirs; }
async function reclaimExpired(dirs: Awaited<ReturnType<typeof queueDirs>>): Promise<void> { const files = (await fs.readdir(dirs.leased)).filter((name) => name.endsWith(".json")); for (const file of files) { try { const envelope = JSON.parse(await fs.readFile(path.join(dirs.leased, file), "utf8")) as LeaseEnvelope; if (Date.parse(envelope.expiresAt) <= Date.now()) { await fs.writeFile(path.join(dirs.pending, `${safe(envelope.job.id)}.json`), `${JSON.stringify(envelope.job, null, 2)}\n`, { flag: "wx" }).catch(() => undefined); await fs.rm(path.join(dirs.leased, file), { force: true }); } } catch { /* malformed lease stays visible for operator inspection */ } } }

async function submitHttp(config: HarnessProjectConfig, job: DistributedDelegationJob): Promise<void> { const response = await request(config, "/v1/jobs", { method: "POST", body: JSON.stringify(job), headers: { "content-type": "application/json" } }); if (!response.ok) throw new Error(`Distributed queue rejected job: HTTP ${response.status} ${await response.text()}`); }
async function claimHttp(config: HarnessProjectConfig, workerId: string): Promise<ClaimedJob | undefined> { const response = await request(config, "/v1/claim", { method: "POST", body: JSON.stringify({ workerId }), headers: { "content-type": "application/json" } }); if (response.status === 204) return undefined; if (!response.ok) throw new Error(`Distributed queue claim failed: HTTP ${response.status}`); return await response.json() as ClaimedJob; }
async function completeHttp(config: HarnessProjectConfig, leaseId: string, result: DistributedDelegationResult): Promise<void> { const response = await request(config, `/v1/leases/${encodeURIComponent(leaseId)}/complete`, { method: "POST", body: JSON.stringify(result), headers: { "content-type": "application/json" } }); if (!response.ok) throw new Error(`Distributed queue completion failed: HTTP ${response.status}`); }
async function getHttpResult(config: HarnessProjectConfig, jobId: string): Promise<DistributedDelegationResult | undefined> { const response = await request(config, `/v1/jobs/${encodeURIComponent(jobId)}`); if (response.status === 404) return undefined; if (!response.ok) throw new Error(`Distributed queue result lookup failed: HTTP ${response.status}`); return await response.json() as DistributedDelegationResult; }
async function request(config: HarnessProjectConfig, pathname: string, init: RequestInit = {}): Promise<Response> { const endpoint = config.distributed?.endpoint; if (!endpoint) throw new Error("distributed.endpoint is required for HTTP distributed queues."); const headers = new Headers(init.headers); const token = config.distributed?.tokenEnv ? process.env[config.distributed.tokenEnv] : undefined; if (token) headers.set("authorization", `Bearer ${token}`); return fetch(new URL(pathname, endpoint).toString(), { ...init, headers }); }
async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; }
function json(response: http.ServerResponse, status: number, value: unknown): void { response.statusCode = status; if (value === undefined) { response.end(); return; } response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
