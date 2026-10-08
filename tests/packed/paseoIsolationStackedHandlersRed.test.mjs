import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-5: stacked per-handle abort handlers must be
// non-interfering. Luna round-4 REJECTED ru/packed-isolation-4 with 1 lifecycle
// blocker: a retained (unverified) old abort handler calls syncTeardown for
// its captured handle then process.exit, terminating the shared process before
// the next suite's handlers run (their setup installed another set but threw,
// so the caller has no handle for retry). Required net effect: N stacked
// handlers each clean (or no-op) ONLY their own home in registration order,
// then the process terminates by signal default disposition — exit codes, when
// needed, are owned by the campaign runner, never by a per-handle handler.
//
// Gates:
// (a) NO process.exit inside per-handle abort handlers (+ documented default
//     disposition / runner-owned exit codes).
// (b) each handler cleans ONLY its own handle's resources (home-path identity;
//     skip anything else — incl. refusing the shared live daemon home).
// (c) syncTeardown idempotent per handle (cleaned flag -> re-fire is a no-op).

function handlerRegion(src) {
  const start = src.indexOf("function installAbortHandlers");
  assert.ok(start !== -1, "installAbortHandlers must exist");
  const end = src.indexOf("function removeAbortHandlers", start);
  assert.ok(end !== -1 && end > start, "removeAbortHandlers must follow installAbortHandlers");
  return src.slice(start, end);
}

function syncTeardownRegion(src) {
  const start = src.indexOf("export function syncTeardown");
  assert.ok(start !== -1, "syncTeardown must exist");
  const end = src.indexOf("function installAbortHandlers", start);
  assert.ok(end !== -1 && end > start, "installAbortHandlers must follow syncTeardown");
  return src.slice(start, end);
}

test("RED stacked-handlers (a): per-handle abort handlers must NOT call process.exit", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const region = handlerRegion(src);
  // Code-only check: strip comments first so prose documenting the ban (e.g.
  // "NO process.exit() ...") cannot trip the gate; strings are left intact.
  const code = region.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/process\.exit\s*\(/.test(code),
    "BLOCKER: stale per-handle signal handler calls process.exit after syncTeardown, terminating the shared process before later suites' handlers run; exit codes belong to the campaign runner"
  );
});

test("RED stacked-handlers (a-doc): non-interference must be documented (default disposition + runner-owned exit codes)", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const region = handlerRegion(src);
  assert.ok(
    /default disposition/.test(region),
    "handlers must document that the signal default disposition terminates the process after listeners run (no per-handle exit)"
  );
  assert.ok(
    /campaign runner owns exit codes/.test(region),
    "handlers must document that the campaign runner owns exit codes, not the per-handle handler"
  );
});

test("RED stacked-handlers (b): syncTeardown must gate on own-home identity (refuse the live home)", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const region = syncTeardownRegion(src);
  assert.ok(
    region.includes("livePaseoHome"),
    "syncTeardown must match by home-path identity against the shared live daemon home and skip anything not owned by its handle"
  );
  assert.ok(
    region.includes("refuses-live-home"),
    "syncTeardown must refuse non-owned (live) homes with an explicit refuses-live-home no-op"
  );
});

// Deterministic lifecycle fake: per-PASEO_HOME port + started-state so setup
// health (running) and teardown proof (stopped) both verify without a real
// daemon. NOTE the double-escaped \\d: this source is itself nested inside a
// JS template literal.
function makeStackFakePaseoBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
const tag = Buffer.from(home).toString("hex");
function count(name) {
  const f = path.join(stateDir, name + "-" + tag);
  let n = 0;
  try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}
  fs.writeFileSync(f, String(n + 1));
  return n + 1;
}
function portFile() { return path.join(stateDir, "port-" + tag); }
function startedFile() { return path.join(stateDir, "started-" + tag); }
if (args[0] === "daemon" && args[1] === "config") {
  const listen = args[args.length - 1] ?? "";
  const m = /:(\\d+)$/.exec(listen);
  if (m) fs.writeFileSync(portFile(), m[1]);
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "start") {
  count("daemon-start-count");
  fs.writeFileSync(startedFile(), "1");
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "stop") {
  count("daemon-stop-count");
  try { fs.rmSync(startedFile(), { force: true }); } catch {}
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "status") {
  let port = "0";
  try { port = fs.readFileSync(portFile(), "utf8").trim() || "0"; } catch {}
  let started = false;
  try { fs.accessSync(startedFile()); started = true; } catch {}
  if (started && port !== "0") {
    console.log(JSON.stringify({ home, localDaemon: "running", listen: "127.0.0.1:" + port, configuredListen: "127.0.0.1:" + port }));
  } else {
    console.log(JSON.stringify({ home, localDaemon: "stopped", listen: null }));
  }
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "ls") { console.log("[]"); process.exit(0); }
if (args[0] === "workspace" && args[1] === "ls") { console.log("[]"); process.exit(0); }
console.log("");
process.exit(0);
`;
}

function listenerSnapshot() {
  return {
    SIGINT: process.listeners("SIGINT").slice(),
    SIGTERM: process.listeners("SIGTERM").slice(),
    uncaughtException: process.listeners("uncaughtException").slice(),
    unhandledRejection: process.listeners("unhandledRejection").slice(),
  };
}

function addedCount(before, after) {
  let total = 0;
  for (const key of Object.keys(before)) {
    total += Math.max(0, after[key].length - before[key].length);
  }
  return total;
}

function removeAddedListeners(before) {
  for (const key of Object.keys(before)) {
    const baseline = new Set(before[key]);
    for (const listener of process.listeners(key).slice()) {
      if (!baseline.has(listener)) process.removeListener(key, listener);
    }
  }
}

async function stopCountFor(stateDir, home) {
  const tag = Buffer.from(home).toString("hex");
  try {
    return Number(await fs.readFile(path.join(stateDir, `daemon-stop-count-${tag}`), "utf8")) || 0;
  } catch {
    return 0;
  }
}

test("RED stacked-handlers (a+b+c): stale handler cleans ONLY its own home, never exits, re-fire is a no-op", async () => {
  const { setupIsolatedPaseoHome, teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-stack-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeStackFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch {}

  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_SESSION_ID;
  const before = listenerSnapshot();

  // process.exit stub: the BLOCKER kills the shared process here. Record the
  // call instead so the test survives to report it; the fixed handler must
  // never call exit at all (campaign runner owns exit codes).
  const origExit = process.exit;
  const exitCalls = [];
  process.exit = ((...args) => { exitCalls.push(args); });

  let handleA;
  let handleB;
  try {
    // Two successive suites stack two handler sets in one process (the second
    // setup models the retry after the first setup threw with no handle).
    handleA = await setupIsolatedPaseoHome({ prefix: "aeh-red-stack-a-", startTimeoutMs: 10_000 });
    handleB = await setupIsolatedPaseoHome({ prefix: "aeh-red-stack-b-", startTimeoutMs: 10_000 });
    const afterSetup = listenerSnapshot();
    assert.ok(
      addedCount(before, afterSetup) >= 8,
      `two setups must stack two handler sets (added=${addedCount(before, afterSetup)}, expected>=8)`
    );
    const homeA = handleA.home;
    const homeB = handleB.home;
    assert.ok(homeA && homeB && homeA !== homeB, "stacked suites must own distinct homes");

    // Fire the STALE (first-registered) handler: must clean ONLY homeA.
    handleA.abortHandlers.sigint();
    assert.equal(exitCalls.length, 0, "BLOCKER: stale per-handle handler called process.exit and would terminate before the next suite's handlers run");
    assert.equal(handleA.cleaned, true, "stale handler must still clean its own home (verified)");
    assert.ok(!existsSync(homeA), "stale handler must remove its own home");
    assert.equal(handleB.cleaned, false, "stale handler must NOT disturb the subsequent suite's handle");
    assert.ok(existsSync(homeB), "stale handler must NOT touch the subsequent suite's home");
    assert.equal(process.env.PASEO_HOME, homeB, "stale handler must NOT disturb the current isolation pointers");

    // (c) Re-fire of the stale handler must be a no-op (cleaned flag).
    const stopsAfterFirst = await stopCountFor(stateDir, homeA);
    assert.ok(stopsAfterFirst >= 1, "first stale fire must have driven daemon-stop for its own home");
    handleA.abortHandlers.sigint();
    assert.equal(exitCalls.length, 0, "re-fired stale handler must NOT call process.exit either");
    assert.equal(await stopCountFor(stateDir, homeA), stopsAfterFirst, "re-fired stale handler must be a no-op (no further stop probes for its already-cleaned home)");
    assert.ok(existsSync(homeB), "re-fired stale handler must still leave the subsequent suite's home alone");
  } finally {
    process.exit = origExit;
    if (handleB && !handleB.cleaned) {
      try { await teardownIsolatedPaseoHome(handleB); } catch {}
    }
    if (handleA?.home) await fs.rm(handleA.home, { recursive: true, force: true }).catch(() => undefined);
    if (handleB?.home) await fs.rm(handleB.home, { recursive: true, force: true }).catch(() => undefined);
    removeAddedListeners(before);
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    if (savedAgent === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = savedAgent;
    if (savedSession === undefined) delete process.env.PASEO_SESSION_ID;
    else process.env.PASEO_SESSION_ID = savedSession;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
