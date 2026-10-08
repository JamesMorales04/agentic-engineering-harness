import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-8: pre-flight reconcile cannot distinguish abandoned handles
// from LIVE concurrent setups. Round-7 reconciles EVERY non-owner registration,
// so a second setup in the same process tears down the first suite's LIVE
// daemon home (release blocker when suites run concurrently).
// Required: registry records a lifecycle phase per handle — 'setting-up' (at
// register, before fallible steps) -> 'live' (on setup success return) ->
// 'failed' (on setup throw); verified teardown unregisters (any phase).
// Pre-flight reconciles ONLY 'failed' handles (provably ownerless); 'live' and
// 'setting-up' handles are NEVER touched by pre-flight (concurrent suites safe
// by construction; in-flight setups may still succeed).

function makeCentralFakePaseoBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
const tag = Buffer.from(home).toString("hex");
function portFile() { return path.join(stateDir, "port-" + tag); }
function startedFile() { return path.join(stateDir, "started-" + tag); }
if (args[0] === "daemon" && args[1] === "config") {
  const listen = args[args.length - 1] ?? "";
  const m = /:(\\d+)$/.exec(listen);
  if (m) fs.writeFileSync(portFile(), m[1]);
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "start") {
  fs.writeFileSync(startedFile(), "1");
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "stop") {
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

function removeAddedListeners(before) {
  for (const key of Object.keys(before)) {
    const baseline = new Set(before[key]);
    for (const listener of process.listeners(key).slice()) {
      if (!baseline.has(listener)) process.removeListener(key, listener);
    }
  }
}

test("RED phase gate code: registry phases + pre-flight reconciles ONLY 'failed'", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const setupIdx = src.indexOf("export async function setupIsolatedPaseoHome");
  assert.ok(setupIdx !== -1, "setupIsolatedPaseoHome must exist");
  // Phase vocabulary must exist: setting-up at register, live on success, failed on throw.
  assert.ok(src.includes("setting-up"), "BLOCKER: registry must record phase 'setting-up' at register (before fallible steps)");
  assert.ok(/phase[^;]*'live'|"live"/.test(src), "BLOCKER: setup success must transition the handle to phase 'live'");
  assert.ok(/phase[^;]*'failed'|"failed"/.test(src), "BLOCKER: setup throw must transition the handle to phase 'failed'");
  // Pre-flight filter: ONLY 'failed' handles are provably ownerless. A filter on
  // bare identity (h !== ownerHandle) tears down live concurrent suites.
  const reconcileIdx = src.indexOf("reconcileLeftoverIsolationHandlesSync");
  assert.ok(reconcileIdx !== -1, "reconcileLeftoverIsolationHandlesSync must exist");
  const reconcileBody = src.slice(reconcileIdx, reconcileIdx + 3000);
  assert.ok(
    /phase\s*===\s*["']failed["']/.test(reconcileBody),
    "BLOCKER: pre-flight reconcile must filter to phase === 'failed' only (identity-only filter tears down LIVE concurrent handles)"
  );
  // Documented transitions + cross-process residual honesty.
  assert.ok(
    /setting-up.*live.*failed|live.*failed/i.test(src) && /cross-process|per-process/i.test(src),
    "BLOCKER: must document phase transitions and the per-process-registry residual (SIGKILLed prior process invisible; janitor follow-up, no cross-process reaping here)"
  );
});

test("RED BLOCKER: pre-flight must NOT tear down a live concurrent handle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-phasegate-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeCentralFakePaseoBin(stateDir), { mode: 0o755 });
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
  const errors = [];
  const origError = console.error;
  let mod;
  const handles = [];
  try {
    mod = await import("./paseoIsolatedHome.mjs");
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
    // First suite: a real, successful setup -> LIVE handle (concurrent suite).
    const first = await mod.setupIsolatedPaseoHome({ prefix: "aeh-red-phase-live-", startTimeoutMs: 10_000 });
    handles.push(first);
    const homeA = first.home;
    assert.ok(homeA, "first setup must return a handle with a home");
    await fs.writeFile(path.join(homeA, "live-probe.txt"), "live-suite");
    console.error = (...args) => { errors.push(args.map(String).join(" ")); };
    // Second (concurrent) suite starts: its pre-flight must NOT touch the live handle.
    const second = await mod.setupIsolatedPaseoHome({ prefix: "aeh-red-phase-next-", startTimeoutMs: 10_000 });
    handles.push(second);
    console.error = origError;
    const trace = errors.join("\n");
    assert.equal(first.cleaned, false, "BLOCKER: pre-flight tore down a LIVE concurrent handle (first.cleaned flipped true)");
    assert.ok(mod.__isIsolationHandleRegisteredForTests(first), "BLOCKER: pre-flight unregistered a LIVE concurrent handle");
    assert.ok(existsSync(homeA), "BLOCKER: pre-flight removed a LIVE concurrent suite home");
    assert.ok(existsSync(path.join(homeA, "live-probe.txt")), "BLOCKER: pre-flight damaged a LIVE concurrent suite home");
    assert.ok(!trace.includes(homeA), `BLOCKER: pre-flight attempted reconcile on a LIVE handle; trace mentions ${homeA}. Got: ${trace.slice(0, 800)}`);
    assert.equal(first.phase, "live", "setup success must transition the handle to phase 'live'");
    assert.equal(second.phase, "live", "second setup success must transition its handle to phase 'live'");
    assert.ok(mod.__isIsolationHandleRegisteredForTests(second), "second setup handle must be registered");
  } finally {
    console.error = origError;
    try {
      const m2 = mod ?? await import("./paseoIsolatedHome.mjs");
      for (const h of handles) {
        if (h && !h.cleaned) { try { await m2.teardownIsolatedPaseoHome(h); } catch {} }
        if (h?.home) await fs.rm(h.home, { recursive: true, force: true }).catch(() => undefined);
      }
      if (typeof m2.__resetIsolationAbortManagerForTests === "function") m2.__resetIsolationAbortManagerForTests(before);
    } catch {}
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

test("GREEN guard: pre-flight still reconciles 'failed' handles (F2 no-regression)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-phase-failed-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeCentralFakePaseoBin(stateDir), { mode: 0o755 });
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
  let mod;
  const handles = [];
  let leakedHome;
  try {
    mod = await import("./paseoIsolatedHome.mjs");
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
    // A prior FAILED setup leak: provably ownerless -> pre-flight must claim it.
    leakedHome = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-phase-failed-leak-"));
    await fs.writeFile(path.join(leakedHome, "probe.txt"), "leak");
    const leaked = { home: leakedHome, host: "127.0.0.1", port: 19212, daemonUrl: "ws://127.0.0.1:19212/ws", previous: {}, cleaned: false, phase: "failed" };
    mod.__registerIsolationHandleForTests(leaked);
    assert.ok(mod.__isIsolationHandleRegisteredForTests(leaked), "leak precondition: handle registered");
    const next = await mod.setupIsolatedPaseoHome({ prefix: "aeh-red-phase-failed-next-", startTimeoutMs: 10_000 });
    handles.push(next);
    assert.equal(leaked.cleaned, true, "pre-flight must still reconcile 'failed' handles (F2 regression)");
    assert.ok(!mod.__isIsolationHandleRegisteredForTests(leaked), "reconciled 'failed' leak must unregister on verified success");
  } finally {
    try {
      const m2 = mod ?? await import("./paseoIsolatedHome.mjs");
      for (const h of handles) {
        if (h && !h.cleaned) { try { await m2.teardownIsolatedPaseoHome(h); } catch {} }
        if (h?.home) await fs.rm(h.home, { recursive: true, force: true }).catch(() => undefined);
      }
      if (leakedHome) await fs.rm(leakedHome, { recursive: true, force: true }).catch(() => undefined);
      if (typeof m2.__resetIsolationAbortManagerForTests === "function") m2.__resetIsolationAbortManagerForTests(before);
    } catch {}
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

test("GREEN guard: pre-flight never touches 'setting-up' handles (in-flight setup)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-phase-settingup-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeCentralFakePaseoBin(stateDir), { mode: 0o755 });
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
  let mod;
  const handles = [];
  try {
    mod = await import("./paseoIsolatedHome.mjs");
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
    // A concurrent setup still in flight: no home yet, may still succeed.
    const inflight = { home: undefined, host: "127.0.0.1", port: undefined, daemonUrl: undefined, previous: {}, cleaned: false, phase: "setting-up" };
    mod.__registerIsolationHandleForTests(inflight);
    assert.ok(mod.__isIsolationHandleRegisteredForTests(inflight), "in-flight precondition: handle registered");
    const next = await mod.setupIsolatedPaseoHome({ prefix: "aeh-red-phase-settingup-next-", startTimeoutMs: 10_000 });
    handles.push(next);
    assert.equal(inflight.cleaned, false, "pre-flight must never flip an in-flight 'setting-up' handle");
    assert.ok(mod.__isIsolationHandleRegisteredForTests(inflight), "pre-flight must never unregister an in-flight 'setting-up' handle");
    // Cleanup: the simulated in-flight handle never got a home; drop it from
    // the registry directly so no listener set leaks past this test.
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
  } finally {
    try {
      const m2 = mod ?? await import("./paseoIsolatedHome.mjs");
      for (const h of handles) {
        if (h && !h.cleaned) { try { await m2.teardownIsolatedPaseoHome(h); } catch {} }
        if (h?.home) await fs.rm(h.home, { recursive: true, force: true }).catch(() => undefined);
      }
      if (typeof m2.__resetIsolationAbortManagerForTests === "function") m2.__resetIsolationAbortManagerForTests(before);
    } catch {}
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
