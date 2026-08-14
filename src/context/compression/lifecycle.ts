import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

export interface HeadroomRuntimeHandle { operationId: string; pid?: number; port: number; endpoint: string; }
export interface HeadroomRuntimeOptions { command?: string; host?: string; port?: number; environment?: Record<string, string>; healthTimeoutMs?: number; }

/** Owns only a local Headroom proxy process; Paseo remains the agent/session owner. */
export class HeadroomRuntimeManager {
  private readonly processes = new Map<string, { child: ChildProcess; handle: HeadroomRuntimeHandle }>();

  async start(root: string, operationId: string, options: HeadroomRuntimeOptions = {}): Promise<HeadroomRuntimeHandle> {
    const existing = this.processes.get(operationId);
    if (existing) return existing.handle;
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("Headroom local proxy must bind to loopback.");
    const port = options.port ?? await freePort(host);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("Headroom proxy port must be a valid TCP port.");
    const command = options.command ?? "headroom";
    const child = spawn(command, ["proxy", "--host", host, "--port", String(port)], { cwd: root, env: { ...process.env, ...(options.environment ?? {}) }, stdio: "ignore" });
    const handle = { operationId, pid: child.pid, port, endpoint: `http://${host}:${port}` } satisfies HeadroomRuntimeHandle;
    this.processes.set(operationId, { child, handle });
    child.once("error", () => { /* readiness polling reports the deterministic failure to the caller */ });
    child.once("exit", () => { if (this.processes.get(operationId)?.child === child) this.processes.delete(operationId); });
    try { await waitForHealth(handle.endpoint, options.healthTimeoutMs ?? 15_000); return handle; }
    catch (error) { await this.stop(operationId); throw new Error(`Headroom proxy failed readiness for operation '${operationId}': ${String(error)}`); }
  }

  async stop(operationId: string): Promise<void> {
    const value = this.processes.get(operationId); if (!value) return;
    this.processes.delete(operationId);
    if (!value.child.killed) value.child.kill("SIGTERM");
  }

  async stopAll(): Promise<void> { await Promise.all([...this.processes.keys()].map((operationId) => this.stop(operationId))); }
}

async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address(); const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error("Could not allocate a Headroom port.")));
    });
  });
}

async function waitForHealth(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no health response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError);
}
