import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Hermetic Paseo isolation for packed S13 campaigns (P-NEW-4).
 *
 * Packed campaigns that exercise REAL provider sessions must never touch the
 * live daemon (`~/.paseo`, `ws://127.0.0.1:6767`). This helper boots a
 * temporary isolated daemon home (mkdtemp under `os.tmpdir()`) on a free
 * loopback port, points both the CLI (`PASEO_HOME`) and the SDK
 * (`PASEO_DAEMON_URL`) at it, and tears everything down afterwards.
 *
 * MECHANISM: DETERMINISTIC for lifecycle/isolation decisions (temp dir, free
 * port discovery, daemon status polling, orphan inventory by id); MODEL is
 * never involved. Teardown is mandatory on success/failure/abort: async
 * teardown for the normal path plus best-effort SYNC teardown for
 * SIGINT/SIGTERM/uncaught failures. The helper NEVER falls back to the live
 * daemon: a failed setup throws `PASEO_ISOLATION_UNAVAILABLE`.
 *
 * Usage (top of a packed campaign, before any lane runs):
 *
 *   import { setupIsolatedPaseoHome, teardownIsolatedPaseoHome, assertIsolatedPaseoEnv } from "./paseoIsolatedHome.mjs";
 *   const paseoIsolation = await setupIsolatedPaseoHome({ prefix: "aeh-s13-gov-" });
 *   assertIsolatedPaseoEnv(paseoIsolation);
 *   // ... lanes (laneEnvironment() already preserves PASEO_HOME/PASEO_DAEMON_URL) ...
 *   const cleanup = await teardownIsolatedPaseoHome(paseoIsolation);
 *   // ... record cleanup accounting in the summary, then process.exit ...
 */

export const LIVE_PASEO_LISTEN_PORT = 6767;
export const LIVE_PASEO_WS_URL = `ws://127.0.0.1:${LIVE_PASEO_LISTEN_PORT}/ws`;

export function livePaseoHome() {
  return path.join(os.homedir(), ".paseo");
}

function scrubbedEnv(home) {
  const env = { ...process.env, PASEO_HOME: home };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_SESSION_ID;
  return env;
}

function runPaseo(args, home, timeoutMs = 60_000) {
  const result = spawnSync("paseo", args, { encoding: "utf8", timeout: timeoutMs, env: scrubbedEnv(home), maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("PASEO_ISOLATION_NO_PORT: free port discovery returned no port."));
        else resolve(port);
      });
    });
  });
}

function parseDaemonStatus(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function waitForIsolatedDaemon(home, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const status = runPaseo(["daemon", "status", "--json"], home, 15_000);
    last = parseDaemonStatus(status.stdout);
    if (last && last.home === home && last.localDaemon === "running") {
      const listen = String(last.listen ?? last.configuredListen ?? "");
      if (listen.endsWith(`:${port}`)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PASEO_ISOLATION_UNAVAILABLE: isolated daemon at ${home} did not reach healthy status on port ${port} within ${timeoutMs}ms. Last status: ${JSON.stringify(last ?? null).slice(0, 500)}`);
}

function listJson(args, home) {
  const result = runPaseo(args, home, 60_000);
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function agentIdOf(entry) {
  return entry?.id ?? entry?.agentId ?? undefined;
}

function workspaceIdOf(entry) {
  return entry?.workspaceId ?? undefined;
}

function syncTeardown(handle) {
  if (!handle || handle.cleaned) return { cleaned: false, reason: "already-cleaned" };
  handle.cleaned = true;
  const accounting = { agentsDeleted: [], agentsDeleteFailed: [], workspacesArchived: [], workspacesArchiveFailed: [], daemonStopped: false, homeRemoved: false };
  try {
    for (const entry of listJson(["agent", "ls", "--json"], handle.home)) {
      const id = agentIdOf(entry);
      if (!id) continue;
      const deleted = runPaseo(["agent", "delete", id], handle.home, 60_000);
      if (deleted.status === 0) accounting.agentsDeleted.push(id);
      else accounting.agentsDeleteFailed.push({ agentId: id, exitCode: deleted.status });
    }
  } catch { /* best-effort */ }
  try {
    for (const entry of listJson(["workspace", "ls", "--json"], handle.home)) {
      const id = workspaceIdOf(entry);
      if (!id) continue;
      const archived = runPaseo(["workspace", "archive", id], handle.home, 60_000);
      if (archived.status === 0) accounting.workspacesArchived.push(id);
      else accounting.workspacesArchiveFailed.push({ workspaceId: id, exitCode: archived.status });
    }
  } catch { /* best-effort */ }
  try {
    const stopped = runPaseo(["daemon", "stop"], handle.home, 30_000);
    accounting.daemonStopped = stopped.status === 0;
  } catch { /* best-effort */ }
  try {
    rmSync(handle.home, { recursive: true, force: true });
    accounting.homeRemoved = true;
  } catch { /* best-effort */ }
  return accounting;
}

function installAbortHandlers(handle) {
  const onSignal = (signal) => {
    try {
      syncTeardown(handle);
    } finally {
      // Re-raise with the conventional exit code after best-effort cleanup so
      // no isolated orphan survives an operator abort.
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  const onUncaught = (error) => {
    try {
      syncTeardown(handle);
    } finally {
      console.error(`PASEO_ISOLATION_ABORT_TEARDOWN: uncaught failure; isolated home ${handle.home} cleaned best-effort. Original error: ${error?.stack ?? error}`);
      process.exit(1);
    }
  };
  const handlers = {
    sigint: () => onSignal("SIGINT"),
    sigterm: () => onSignal("SIGTERM"),
    uncaught: (error) => onUncaught(error),
    unhandled: (reason) => onUncaught(reason),
  };
  process.on("SIGINT", handlers.sigint);
  process.on("SIGTERM", handlers.sigterm);
  process.on("uncaughtException", handlers.uncaught);
  process.on("unhandledRejection", handlers.unhandled);
  handle.abortHandlers = handlers;
}

function removeAbortHandlers(handle) {
  const handlers = handle.abortHandlers;
  if (!handlers) return;
  process.removeListener("SIGINT", handlers.sigint);
  process.removeListener("SIGTERM", handlers.sigterm);
  process.removeListener("uncaughtException", handlers.uncaught);
  process.removeListener("unhandledRejection", handlers.unhandled);
  handle.abortHandlers = undefined;
}

/**
 * Boot an isolated Paseo daemon home and redirect this process (plus every
 * child spawned via `laneEnvironment()`) at it. Throws
 * `PASEO_ISOLATION_UNAVAILABLE` on any failure — callers must fail the run,
 * never fall back to the live daemon.
 */
export async function setupIsolatedPaseoHome(options = {}) {
  const prefix = options.prefix ?? "aeh-s13-iso-";
  const host = options.host ?? "127.0.0.1";
  const previous = {
    PASEO_HOME: process.env.PASEO_HOME,
    PASEO_DAEMON_URL: process.env.PASEO_DAEMON_URL,
    PASEO_AGENT_ID: process.env.PASEO_AGENT_ID,
    PASEO_SESSION_ID: process.env.PASEO_SESSION_ID,
  };
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const handle = { home, host, port: undefined, daemonUrl: undefined, previous, cleaned: false, startedAt: new Date().toISOString() };
  try {
    // A second daemon cannot share the live listen port (EADDRINUSE); pick a
    // free loopback port first, then pin the isolated home to it.
    let port = await findFreePort(host);
    if (port === LIVE_PASEO_LISTEN_PORT) port = await findFreePort(host);
    handle.port = port;
    const configured = runPaseo(["daemon", "config", "set", "daemon.listen", `${host}:${port}`], home, 30_000);
    if (configured.status !== 0) throw new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon config set failed: ${(configured.stderr || configured.stdout).slice(0, 500)}`);
    const started = runPaseo(["daemon", "start"], home, 60_000);
    if (started.status !== 0) throw new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon start failed: ${(started.stderr || started.stdout).slice(0, 800)}`);
    await waitForIsolatedDaemon(home, port, options.startTimeoutMs ?? 30_000);
    handle.daemonUrl = `ws://${host}:${port}/ws`;
    // Redirect this process and every lane child: laneEnvironment() spreads
    // process.env and only strips AEH_*/PASEO_AGENT_ID/PASEO_SESSION_ID, so
    // PASEO_HOME/PASEO_DAEMON_URL flow through automatically. Drop the
    // foreign caller identity: it belongs to the live daemon and the isolated
    // daemon rejects it (`Caller agent ... not found`).
    process.env.PASEO_HOME = home;
    process.env.PASEO_DAEMON_URL = handle.daemonUrl;
    delete process.env.PASEO_AGENT_ID;
    delete process.env.PASEO_SESSION_ID;
    installAbortHandlers(handle);
    return handle;
  } catch (error) {
    try {
      runPaseo(["daemon", "stop"], home, 30_000);
    } catch { /* best-effort */ }
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    handle.cleaned = true;
    throw error instanceof Error ? error : new Error(`PASEO_ISOLATION_UNAVAILABLE: ${String(error)}`);
  }
}

/**
 * Fail-closed guard: refuse to run lanes unless this process is redirected at
 * the given isolated home. Call immediately after setup.
 */
export function assertIsolatedPaseoEnv(handle) {
  if (!handle || !handle.home || !handle.port || !handle.daemonUrl) {
    throw new Error("PASEO_ISOLATION_UNVERIFIED: no isolated Paseo home handle; refusing to run against an unverified daemon.");
  }
  if (process.env.PASEO_HOME !== handle.home) {
    throw new Error(`PASEO_ISOLATION_UNVERIFIED: PASEO_HOME=${process.env.PASEO_HOME ?? "missing"} does not match isolated home ${handle.home}; refusing live-daemon lanes.`);
  }
  if (process.env.PASEO_DAEMON_URL !== handle.daemonUrl) {
    throw new Error(`PASEO_ISOLATION_UNVERIFIED: PASEO_DAEMON_URL=${process.env.PASEO_DAEMON_URL ?? "missing"} does not match isolated daemon ${handle.daemonUrl}; refusing live-daemon lanes.`);
  }
  if (path.resolve(handle.home) === path.resolve(livePaseoHome())) {
    throw new Error(`PASEO_ISOLATION_UNVERIFIED: isolated home resolves to the live daemon home ${handle.home}; refusing live-daemon lanes.`);
  }
  if (handle.port === LIVE_PASEO_LISTEN_PORT) {
    throw new Error(`PASEO_ISOLATION_UNVERIFIED: isolated daemon port ${handle.port} collides with the live daemon port; refusing live-daemon lanes.`);
  }
}

/**
 * Mandatory teardown: delete every agent and archive every workspace left in
 * the isolated home (the home starts empty, so any remainder is this run's
 * orphan), stop the isolated daemon, remove the temp home, and restore the
 * previous environment. Idempotent; safe to call twice.
 */
export async function teardownIsolatedPaseoHome(handle) {
  if (!handle || handle.cleaned) return { cleaned: false, reason: "already-cleaned-or-missing" };
  handle.cleaned = true;
  removeAbortHandlers(handle);
  const accounting = {
    home: handle.home,
    port: handle.port,
    agentsDeleted: [],
    agentsDeleteFailed: [],
    workspacesArchived: [],
    workspacesArchiveFailed: [],
    daemonStopped: false,
    homeRemoved: false,
  };
  for (const entry of listJson(["agent", "ls", "--json"], handle.home)) {
    const id = agentIdOf(entry);
    if (!id) continue;
    const deleted = runPaseo(["agent", "delete", id], handle.home, 60_000);
    if (deleted.status === 0) accounting.agentsDeleted.push(id);
    else accounting.agentsDeleteFailed.push({ agentId: id, exitCode: deleted.status, stderr: deleted.stderr.slice(0, 300) });
  }
  for (const entry of listJson(["workspace", "ls", "--json"], handle.home)) {
    const id = workspaceIdOf(entry);
    if (!id) continue;
    const archived = runPaseo(["workspace", "archive", id], handle.home, 60_000);
    if (archived.status === 0) accounting.workspacesArchived.push(id);
    else accounting.workspacesArchiveFailed.push({ workspaceId: id, exitCode: archived.status, stderr: archived.stderr.slice(0, 300) });
  }
  const remainingAgents = listJson(["agent", "ls", "--json"], handle.home).map(agentIdOf).filter(Boolean);
  const remainingWorkspaces = listJson(["workspace", "ls", "--json"], handle.home).map(workspaceIdOf).filter(Boolean);
  accounting.remainingAgents = remainingAgents;
  accounting.remainingWorkspaces = remainingWorkspaces;
  const stopped = runPaseo(["daemon", "stop"], handle.home, 30_000);
  accounting.daemonStopped = stopped.status === 0;
  await fs.rm(handle.home, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.access(handle.home);
  } catch {
    accounting.homeRemoved = true;
  }
  // Restore the caller's environment so no isolated pointer leaks past teardown.
  const previous = handle.previous ?? {};
  if (previous.PASEO_HOME === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previous.PASEO_HOME;
  if (previous.PASEO_DAEMON_URL === undefined) delete process.env.PASEO_DAEMON_URL;
  else process.env.PASEO_DAEMON_URL = previous.PASEO_DAEMON_URL;
  if (previous.PASEO_AGENT_ID === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previous.PASEO_AGENT_ID;
  if (previous.PASEO_SESSION_ID === undefined) delete process.env.PASEO_SESSION_ID;
  else process.env.PASEO_SESSION_ID = previous.PASEO_SESSION_ID;
  accounting.orphanFree = remainingAgents.length === 0 && remainingWorkspaces.length === 0;
  return accounting;
}
