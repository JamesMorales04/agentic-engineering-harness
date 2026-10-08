import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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
 * Teardown guarantee (B1 fix): campaign bodies enter `try { ... } finally { ... }`
 * immediately when isolation setup returns, so ALL subsequent fallible setup
 * (staging mkdtemp, dist reads, packing, fixture prep) is inside the protected
 * region. Abort handlers are installed FIRST in setup (before mkdtemp/port
 * discovery/daemon start) and stay installed until teardown VERIFIES completion
 * (positive stopped-proof `localDaemon === "stopped"` + home removed, both
 * probed, never assumed); `handle.cleaned` flips only on verified completion
 * so a failed attempt remains retryable. Both async and sync teardown retry a
 * bounded number of times before giving up and trace persistently via
 * `console.error` (`PASEO_ISOLATION_TEARDOWN_FAILED` /
 * `PASEO_ISOLATION_ABORT_TEARDOWN`) plus machine-readable accounting
 * (`attempts`, `daemonStopped`, `homeRemoved`, `verified`). Unknown/missing
 * stopped vocabulary → UNVERIFIED → retry then fail, never verified.
 *
 * Port race (B2 fix): `findFreePort()` is availability-only (TOCTOU): the OS
 * frees the port on close and another process may bind it before
 * `paseo daemon start` runs. Setup therefore spawns with bounded retry on
 * `EADDRINUSE` (next free port each time, up to
 * `ISOLATION_SETUP_MAX_PORT_ATTEMPTS` attempts) instead of single-shot.
 * Residual: if every attempt collides (sustained port exhaustion or a
 * hostile binder), setup fails closed with `PASEO_ISOLATION_UNAVAILABLE`
 * and never falls back to the live daemon.
 *
 * Usage (top of a packed campaign, before any lane runs):
 *
 *   import { setupIsolatedPaseoHome, teardownIsolatedPaseoHome, assertIsolatedPaseoEnv } from "./paseoIsolatedHome.mjs";
 *   const paseoIsolation = await setupIsolatedPaseoHome({ prefix: "aeh-s13-gov-" });
 *   try {
 *     assertIsolatedPaseoEnv(paseoIsolation);
 *     // ... staging, lanes (laneEnvironment() already preserves PASEO_HOME/PASEO_DAEMON_URL) ...
 *   } finally {
 *     const cleanup = await teardownIsolatedPaseoHome(paseoIsolation);
 *     // ... record cleanup accounting in the summary, then process.exit ...
 *   }
 */

export const LIVE_PASEO_LISTEN_PORT = 6767;
export const LIVE_PASEO_WS_URL = `ws://127.0.0.1:${LIVE_PASEO_LISTEN_PORT}/ws`;
export const ISOLATION_SETUP_MAX_PORT_ATTEMPTS = 5;
export const ISOLATION_TEARDOWN_MAX_ATTEMPTS = 3;

// Positive stopped-proof vocabulary for `paseo daemon status --json`
// `.localDaemon`. Source: @getpaseo/cli
// `dist/commands/daemon/status.js` localStatus():
//   let localDaemon = "stopped";
//   if (instance) localDaemon = instance.listen ? "running" : "not_ready";
// Only "stopped" (no instance file) proves the daemon is gone. "not_ready"
// still has an instance record; missing/unknown values are UNVERIFIED and must
// retry then fail, never verify.
export const DAEMON_STOPPED_PROOF_VALUES = new Set(["stopped"]);

export function livePaseoHome() {
  return path.join(os.homedir(), ".paseo");
}

export function isAddrInUseMessage(text) {
  return /EADDRINUSE|address already in use/i.test(String(text ?? ""));
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

async function isHomeRemoved(home) {
  try {
    await fs.access(home);
    return false;
  } catch {
    return true;
  }
}

function isHomeRemovedSync(home) {
  try {
    return !existsSync(home);
  } catch {
    return false;
  }
}

function isDaemonStoppedSync(home) {
  try {
    if (!home) return false;
    const status = runPaseo(["daemon", "status", "--json"], home, 15_000);
    const parsed = parseDaemonStatus(status.stdout);
    if (!parsed || typeof parsed !== "object") return false;
    // POSITIVE proof only: accept exactly the daemon's real stopped states.
    // {} / missing localDaemon / unknown values → UNVERIFIED (false) so the
    // caller retries then fails, never verifies.
    return DAEMON_STOPPED_PROOF_VALUES.has(parsed.localDaemon);
  } catch {
    return false;
  }
}

function readDaemonLogTail(home, maxChars = 4000) {
  try {
    const logPath = path.join(home, "daemon.log");
    // Sync read: called from both sync and async paths right after a failed
    // `daemon start`; async fs would add latency to the retry loop.
    const raw = readFileSync(logPath, "utf8");
    return String(raw ?? "").slice(-maxChars);
  } catch {
    return "";
  }
}

function collectAddrInUseEvidence(parts) {
  return parts.filter(Boolean).join("\n").slice(0, 8000);
}

function restorePreviousEnv(handle) {
  try {
    const previous = handle.previous ?? {};
    if (previous.PASEO_HOME === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous.PASEO_HOME;
    if (previous.PASEO_DAEMON_URL === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = previous.PASEO_DAEMON_URL;
    if (previous.PASEO_AGENT_ID === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous.PASEO_AGENT_ID;
    if (previous.PASEO_SESSION_ID === undefined) delete process.env.PASEO_SESSION_ID;
    else process.env.PASEO_SESSION_ID = previous.PASEO_SESSION_ID;
  } catch { /* best-effort: env restore must never throw past teardown */ }
}

export function syncTeardown(handle) {
  if (!handle || handle.cleaned) return { cleaned: false, reason: "already-cleaned" };
  if (!handle.home) return { cleaned: false, reason: "no-home-yet", daemonStopped: false, homeRemoved: false, attempts: 0, verified: false };
  const accounting = { agentsDeleted: [], agentsDeleteFailed: [], workspacesArchived: [], workspacesArchiveFailed: [], daemonStopped: false, homeRemoved: false, attempts: 0, verified: false };
  for (let attempt = 1; attempt <= ISOLATION_TEARDOWN_MAX_ATTEMPTS; attempt += 1) {
    accounting.attempts = attempt;
    try {
      for (const entry of listJson(["agent", "ls", "--json"], handle.home)) {
        const id = agentIdOf(entry);
        if (!id || accounting.agentsDeleted.includes(id)) continue;
        const deleted = runPaseo(["agent", "delete", id], handle.home, 60_000);
        if (deleted.status === 0) {
          if (!accounting.agentsDeleted.includes(id)) accounting.agentsDeleted.push(id);
        } else if (!accounting.agentsDeleteFailed.some((item) => item.agentId === id)) {
          accounting.agentsDeleteFailed.push({ agentId: id, exitCode: deleted.status });
        }
      }
    } catch { /* best-effort, retried */ }
    try {
      for (const entry of listJson(["workspace", "ls", "--json"], handle.home)) {
        const id = workspaceIdOf(entry);
        if (!id || accounting.workspacesArchived.includes(id)) continue;
        const archived = runPaseo(["workspace", "archive", id], handle.home, 60_000);
        if (archived.status === 0) {
          if (!accounting.workspacesArchived.includes(id)) accounting.workspacesArchived.push(id);
        } else if (!accounting.workspacesArchiveFailed.some((item) => item.workspaceId === id)) {
          accounting.workspacesArchiveFailed.push({ workspaceId: id, exitCode: archived.status });
        }
      }
    } catch { /* best-effort, retried */ }
    try {
      const stopped = runPaseo(["daemon", "stop"], handle.home, 30_000);
      // Positive proof only: isDaemonStoppedSync accepts exactly "stopped".
      accounting.daemonStopped = stopped.status === 0 && isDaemonStoppedSync(handle.home);
    } catch {
      accounting.daemonStopped = isDaemonStoppedSync(handle.home);
    }
    // Verify, don't assume: a zero exit from `daemon stop` alone is not
    // completion; the status probe must return positive stopped-proof ("stopped").
    // {} / missing / unknown → UNVERIFIED → retry then fail, never verified.
    if (!accounting.daemonStopped) accounting.daemonStopped = isDaemonStoppedSync(handle.home);
    try {
      rmSync(handle.home, { recursive: true, force: true });
    } catch { /* best-effort, verified below */ }
    accounting.homeRemoved = isHomeRemovedSync(handle.home);
    accounting.verified = accounting.daemonStopped === true && accounting.homeRemoved === true;
    if (accounting.verified) {
      handle.cleaned = true;
      return accounting;
    }
    if (attempt < ISOLATION_TEARDOWN_MAX_ATTEMPTS) {
      console.error(`PASEO_ISOLATION_TEARDOWN_FAILED: sync attempt ${attempt}/${ISOLATION_TEARDOWN_MAX_ATTEMPTS} unverified for ${handle.home} (daemonStopped=${accounting.daemonStopped} homeRemoved=${accounting.homeRemoved}); retrying.`);
    }
  }
  console.error(`PASEO_ISOLATION_TEARDOWN_FAILED: sync teardown gave up after ${accounting.attempts} attempts for ${handle.home} (daemonStopped=${accounting.daemonStopped} homeRemoved=${accounting.homeRemoved}); isolated resources may remain.`);
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
      const result = syncTeardown(handle);
      if (result?.verified) {
        console.error(`PASEO_ISOLATION_ABORT_TEARDOWN: uncaught failure; isolated home ${handle.home} cleaned verified after ${result.attempts} attempt(s). Original error: ${error?.stack ?? error}`);
      } else {
        console.error(`PASEO_ISOLATION_ABORT_TEARDOWN: uncaught failure; isolated home ${handle.home} cleanup UNVERIFIED after ${result?.attempts ?? 1} attempt(s) (daemonStopped=${result?.daemonStopped ?? false} homeRemoved=${result?.homeRemoved ?? false}). Original error: ${error?.stack ?? error}`);
      }
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
  const maxPortAttempts = options.maxPortAttempts ?? ISOLATION_SETUP_MAX_PORT_ATTEMPTS;
  const previous = {
    PASEO_HOME: process.env.PASEO_HOME,
    PASEO_DAEMON_URL: process.env.PASEO_DAEMON_URL,
    PASEO_AGENT_ID: process.env.PASEO_AGENT_ID,
    PASEO_SESSION_ID: process.env.PASEO_SESSION_ID,
  };
  // V2: install abort handlers FIRST, before any fallible step (mkdtemp, port
  // discovery, daemon config/start, health wait) so an abort during setup
  // still cleans. The handle starts without a home; syncTeardown early-returns
  // until the home is assigned below.
  const handle = { home: undefined, host, port: undefined, daemonUrl: undefined, previous, cleaned: false, startedAt: new Date().toISOString() };
  installAbortHandlers(handle);
  let home;
  try {
    home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    handle.home = home;
  } catch (error) {
    removeAbortHandlers(handle);
    throw error instanceof Error ? error : new Error(`PASEO_ISOLATION_UNAVAILABLE: ${String(error)}`);
  }
  let lastError;
  const attemptedPorts = [];
  for (let attempt = 1; attempt <= maxPortAttempts; attempt += 1) {
    try {
      // A second daemon cannot share the live listen port (EADDRINUSE); pick a
      // free loopback port first, then pin the isolated home to it. The free
      // port is availability-only (TOCTOU): retry on EADDRINUSE below.
      let port = await findFreePort(host);
      if (port === LIVE_PASEO_LISTEN_PORT) port = await findFreePort(host);
      if (port === LIVE_PASEO_LISTEN_PORT) {
        lastError = new Error(`PASEO_ISOLATION_UNAVAILABLE: free port discovery collided with the live daemon port ${LIVE_PASEO_LISTEN_PORT}; refusing live-daemon lanes.`);
        continue;
      }
      handle.port = port;
      attemptedPorts.push(port);
      const configured = runPaseo(["daemon", "config", "set", "daemon.listen", `${host}:${port}`], home, 30_000);
      if (configured.status !== 0) {
        const evidence = collectAddrInUseEvidence([configured.stderr, configured.stdout, readDaemonLogTail(home)]);
        if (isAddrInUseMessage(evidence) && attempt < maxPortAttempts) {
          try { runPaseo(["daemon", "stop"], home, 15_000); } catch { /* best-effort before next port */ }
          lastError = new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon config set hit EADDRINUSE on port ${port} (attempt ${attempt}/${maxPortAttempts}); retrying with the next free port.`);
          continue;
        }
        throw new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon config set failed: ${(configured.stderr || configured.stdout).slice(0, 500)}`);
      }
      const started = runPaseo(["daemon", "start"], home, 60_000);
      if (started.status !== 0) {
        const evidence = collectAddrInUseEvidence([started.stderr, started.stdout, readDaemonLogTail(home)]);
        if (isAddrInUseMessage(evidence) && attempt < maxPortAttempts) {
          try { runPaseo(["daemon", "stop"], home, 15_000); } catch { /* best-effort before next port */ }
          lastError = new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon start hit EADDRINUSE on port ${port} (attempt ${attempt}/${maxPortAttempts}); retrying with the next free port. Evidence: ${evidence.slice(0, 300)}`);
          console.error(`PASEO_ISOLATION_PORT_RETRY: ${lastError.message}`);
          continue;
        }
        throw new Error(`PASEO_ISOLATION_UNAVAILABLE: daemon start failed: ${(started.stderr || started.stdout).slice(0, 800)}`);
      }
      try {
        await waitForIsolatedDaemon(home, port, options.startTimeoutMs ?? 30_000);
      } catch (waitError) {
        const evidence = collectAddrInUseEvidence([String(waitError?.message ?? waitError), readDaemonLogTail(home)]);
        if (isAddrInUseMessage(evidence) && attempt < maxPortAttempts) {
          try { runPaseo(["daemon", "stop"], home, 15_000); } catch { /* best-effort before next port */ }
          lastError = waitError instanceof Error ? waitError : new Error(String(waitError));
          console.error(`PASEO_ISOLATION_PORT_RETRY: health check hit EADDRINUSE on port ${port} (attempt ${attempt}/${maxPortAttempts}); retrying with the next free port.`);
          continue;
        }
        throw waitError;
      }
      handle.daemonUrl = `ws://${host}:${port}/ws`;
      handle.portAttempts = attemptedPorts;
      handle.setupAttempts = attempt;
      // Redirect this process and every lane child: laneEnvironment() spreads
      // process.env and only strips AEH_*/PASEO_AGENT_ID/PASEO_SESSION_ID, so
      // PASEO_HOME/PASEO_DAEMON_URL flow through automatically. Drop the
      // foreign caller identity: it belongs to the live daemon and the isolated
      // daemon rejects it (`Caller agent ... not found`).
      // Abort handlers were already installed FIRST (before any fallible step)
      // and stay installed until verified teardown; do NOT reinstall here.
      process.env.PASEO_HOME = home;
      process.env.PASEO_DAEMON_URL = handle.daemonUrl;
      delete process.env.PASEO_AGENT_ID;
      delete process.env.PASEO_SESSION_ID;
      return handle;
    } catch (error) {
      // Non-EADDRINUSE failures fail closed immediately; EADDRINUSE that
      // exhausted its attempts falls through to the fail-closed throw below.
      if (error instanceof Error && /retrying with the next free port/.test(error.message)) {
        lastError = error;
        continue;
      }
      try {
        runPaseo(["daemon", "stop"], home, 30_000);
      } catch { /* best-effort */ }
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
      handle.cleaned = await isHomeRemoved(home);
      // Setup failed with no handle to return: drop the early-installed abort
      // handlers when nothing leaks (cleaned), otherwise keep them so an abort
      // can still clean the leaked home.
      if (handle.cleaned) removeAbortHandlers(handle);
      throw error instanceof Error ? error : new Error(`PASEO_ISOLATION_UNAVAILABLE: ${String(error)}`);
    }
  }
  try {
    runPaseo(["daemon", "stop"], home, 30_000);
  } catch { /* best-effort */ }
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  handle.cleaned = await isHomeRemoved(home);
  if (handle.cleaned) removeAbortHandlers(handle);
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  console.error(`PASEO_ISOLATION_UNAVAILABLE: isolated daemon setup gave up after ${maxPortAttempts} port attempts [${attemptedPorts.join(",")}]. Last: ${detail.slice(0, 500)} Residual: free-port discovery is availability-only; sustained collision fails closed and never falls back to live.`);
  throw lastError instanceof Error ? lastError : new Error(`PASEO_ISOLATION_UNAVAILABLE: isolated daemon setup failed after ${maxPortAttempts} port attempts [${attemptedPorts.join(",")}].`);
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
 * previous environment. Idempotent; safe to call twice. Verified completion
 * only: `handle.cleaned` flips and abort handlers are removed solely after
 * daemon-stopped + home-removed both verify; otherwise handlers stay
 * installed and a later call retries. Bounded retries with persistent traces.
 */
export async function teardownIsolatedPaseoHome(handle) {
  if (!handle || handle.cleaned) return { cleaned: false, reason: "already-cleaned-or-missing" };
  if (!handle.home) return { cleaned: false, reason: "no-home-yet", daemonStopped: false, homeRemoved: false, attempts: 0, verified: false, orphanFree: false };
  const accounting = {
    home: handle.home,
    port: handle.port,
    agentsDeleted: [],
    agentsDeleteFailed: [],
    workspacesArchived: [],
    workspacesArchiveFailed: [],
    daemonStopped: false,
    homeRemoved: false,
    attempts: 0,
    verified: false,
    orphanFree: false,
  };
  for (let attempt = 1; attempt <= ISOLATION_TEARDOWN_MAX_ATTEMPTS; attempt += 1) {
    accounting.attempts = attempt;
    for (const entry of listJson(["agent", "ls", "--json"], handle.home)) {
      const id = agentIdOf(entry);
      if (!id || accounting.agentsDeleted.includes(id)) continue;
      const deleted = runPaseo(["agent", "delete", id], handle.home, 60_000);
      if (deleted.status === 0) {
        if (!accounting.agentsDeleted.includes(id)) accounting.agentsDeleted.push(id);
      } else if (!accounting.agentsDeleteFailed.some((item) => item.agentId === id)) {
        accounting.agentsDeleteFailed.push({ agentId: id, exitCode: deleted.status, stderr: deleted.stderr.slice(0, 300) });
      }
    }
    for (const entry of listJson(["workspace", "ls", "--json"], handle.home)) {
      const id = workspaceIdOf(entry);
      if (!id || accounting.workspacesArchived.includes(id)) continue;
      const archived = runPaseo(["workspace", "archive", id], handle.home, 60_000);
      if (archived.status === 0) {
        if (!accounting.workspacesArchived.includes(id)) accounting.workspacesArchived.push(id);
      } else if (!accounting.workspacesArchiveFailed.some((item) => item.workspaceId === id)) {
        accounting.workspacesArchiveFailed.push({ workspaceId: id, exitCode: archived.status, stderr: archived.stderr.slice(0, 300) });
      }
    }
    const remainingAgents = listJson(["agent", "ls", "--json"], handle.home).map(agentIdOf).filter(Boolean);
    const remainingWorkspaces = listJson(["workspace", "ls", "--json"], handle.home).map(workspaceIdOf).filter(Boolean);
    accounting.remainingAgents = remainingAgents;
    accounting.remainingWorkspaces = remainingWorkspaces;
    try {
      const stopped = runPaseo(["daemon", "stop"], handle.home, 30_000);
      // Positive proof only: isDaemonStoppedSync accepts exactly "stopped".
      accounting.daemonStopped = stopped.status === 0 && isDaemonStoppedSync(handle.home);
    } catch {
      accounting.daemonStopped = isDaemonStoppedSync(handle.home);
    }
    // {} / missing / unknown → UNVERIFIED → retry then fail, never verified.
    if (!accounting.daemonStopped) accounting.daemonStopped = isDaemonStoppedSync(handle.home);
    await fs.rm(handle.home, { recursive: true, force: true }).catch(() => undefined);
    accounting.homeRemoved = await isHomeRemoved(handle.home);
    accounting.orphanFree = remainingAgents.length === 0 && remainingWorkspaces.length === 0;
    accounting.verified = accounting.daemonStopped === true && accounting.homeRemoved === true;
    if (accounting.verified) {
      handle.cleaned = true;
      removeAbortHandlers(handle);
      restorePreviousEnv(handle);
      return accounting;
    }
    if (attempt < ISOLATION_TEARDOWN_MAX_ATTEMPTS) {
      console.error(`PASEO_ISOLATION_TEARDOWN_FAILED: async attempt ${attempt}/${ISOLATION_TEARDOWN_MAX_ATTEMPTS} unverified for ${handle.home} (daemonStopped=${accounting.daemonStopped} homeRemoved=${accounting.homeRemoved} remainingAgents=${remainingAgents.length} remainingWorkspaces=${remainingWorkspaces.length}); retrying with abort handlers still installed.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.error(`PASEO_ISOLATION_TEARDOWN_FAILED: async teardown gave up after ${accounting.attempts} attempts for ${handle.home} (daemonStopped=${accounting.daemonStopped} homeRemoved=${accounting.homeRemoved} remainingAgents=${(accounting.remainingAgents ?? []).length} remainingWorkspaces=${(accounting.remainingWorkspaces ?? []).length}); abort handlers stay installed for a later retry; isolated resources may remain.`);
  // Restore the caller's environment so no isolated pointer leaks past teardown
  // even on unverified completion; the handle stays dirty (cleaned=false) so a
  // later teardown or abort handler retries the verified path.
  restorePreviousEnv(handle);
  return accounting;
}
