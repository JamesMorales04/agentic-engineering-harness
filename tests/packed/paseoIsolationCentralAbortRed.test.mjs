import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-6 (redesign): CENTRAL abort/fatal manager.
// Luna round-5 REJECTED ru/packed-isolation-5 (tip a5cf6d2): per-handle
// handlers can't reconcile non-interference with guaranteed termination
// (exit-in-handler kills siblings; no-exit hangs; identity gate only refuses
// live-home). Required: a single module-level manager — one listener set per
// process (refcounted, never stacked), a live-handle REGISTRY (Set) as the
// ownership proof, signal path tears down ALL registered (reverse order)
// then re-raises via process.kill (no hang, deterministic order), fatal path
// tears down ALL then process.exit(1) (no sibling skipped, no compromised
// continue).
//
// Four RED points (each FAILS on the round-5 per-handle design):
// (1) hang on SIGINT: signal path must re-raise via process.kill(pid, sig)
//     after teardown (old: no kill/exit -> hangs).
// (2) uncaught continues: ONE fatal handler must teardown ALL registered
//     then process.exit(1) (old: per-handle cleans only its own, no exit ->
//     compromised process continues).
// (3) foreign-path cleanup: syncTeardown must refuse handles NOT in the
//     registry (old: cleans any path except live-home -> foreign home removed).
// (4) stacked-handler interference: N setups install ONE listener set
//     (refcounted), never N stacked sets (old: 2 setups -> >=8 listeners).

function makeCentralFakePaseoBin(stateDir) {
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

function addedListeners(before, event) {
  const baseline = new Set(before[event]);
  return process.listeners(event).filter((l) => !baseline.has(l));
}

function removeAddedListeners(before) {
  for (const key of Object.keys(before)) {
    const baseline = new Set(before[key]);
    for (const listener of process.listeners(key).slice()) {
      if (!baseline.has(listener)) process.removeListener(key, listener);
    }
  }
}

async function withFakePaseoOnPath(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-central-"));
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
  const handles = [];
  try {
    return await fn({ stateDir, before, handles });
  } finally {
    try {
      const mod = await import("./paseoIsolatedHome.mjs");
      for (const h of handles) {
        if (h && !h.cleaned) {
          try { await mod.teardownIsolatedPaseoHome(h); } catch {}
        }
        if (h?.home) await fs.rm(h.home, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {}
    removeAddedListeners(before);
    // Central-manager hygiene: a GREEN manager unregisters verified handles
    // and removes its single listener set when the registry empties. If a RED
    // run leaves the registry populated the listeners stay by design; the
    // snapshot restore above already detached them from this process.
    try {
      const mod = await import("./paseoIsolatedHome.mjs");
      if (typeof mod.__resetIsolationAbortManagerForTests === "function") {
        mod.__resetIsolationAbortManagerForTests(before);
      }
    } catch {}
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
}

test("RED central-abort (1) hang on SIGINT: signal path must teardown + re-raise via process.kill (no hang)", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  assert.ok(
    /process\.kill\s*\(\s*process\.pid/.test(src),
    "BLOCKER: signal abort path must re-raise via process.kill(process.pid, sig) after teardown; without it the process hangs after SIGINT"
  );
  await withFakePaseoOnPath(async ({ before, handles }) => {
    const { setupIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
    const handleA = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-sig-a-", startTimeoutMs: 10_000 });
    const handleB = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-sig-b-", startTimeoutMs: 10_000 });
    handles.push(handleA, handleB);
    const homeA = handleA.home;
    const homeB = handleB.home;
    const sigintAdded = addedListeners(before, "SIGINT");
    assert.ok(sigintAdded.length >= 1, "expected at least one SIGINT listener from the abort manager");
    // A CENTRAL manager exposes exactly ONE SIGINT listener no matter how many
    // setups registered; per-handle stacking is the round-5 blocker.
    assert.equal(sigintAdded.length, 1, `BLOCKER: stacked per-handle SIGINT listeners (${sigintAdded.length}); central manager installs ONE set per process`);
    const origKill = process.kill;
    const killCalls = [];
    process.kill = ((...args) => { killCalls.push(args); });
    try {
      await sigintAdded[0]();
      assert.ok(!existsSync(homeA), "central signal path must teardown ALL registered handles (homeA removed)");
      assert.ok(!existsSync(homeB), "central signal path must teardown ALL registered handles (homeB removed, no sibling skipped)");
      assert.ok(killCalls.length >= 1, "BLOCKER: signal handler returned without re-raise; process hangs after SIGINT");
      assert.ok(killCalls.some((c) => c[1] === "SIGINT"), `re-raise must target the received signal; got ${JSON.stringify(killCalls).slice(0, 200)}`);
    } finally {
      process.kill = origKill;
    }
  });
});

test("RED central-abort (2) uncaught continues: ONE fatal handler must teardown ALL registered then exit(1)", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  // Code gate: the fatal path (uncaughtException/unhandledRejection) must end
  // the compromised process with exit(1) AFTER cleaning. Strip comments so
  // prose cannot satisfy the gate.
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/process\.exit\s*\(\s*1\s*\)/.test(code), "BLOCKER: fatal abort path must process.exit(1) after teardown; without it the process continues compromised after uncaughtException");
  await withFakePaseoOnPath(async ({ before, handles }) => {
    const { setupIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
    const handleA = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-fat-a-", startTimeoutMs: 10_000 });
    const handleB = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-fat-b-", startTimeoutMs: 10_000 });
    handles.push(handleA, handleB);
    const homeA = handleA.home;
    const homeB = handleB.home;
    const uncaughtAdded = addedListeners(before, "uncaughtException");
    assert.ok(uncaughtAdded.length >= 1, "expected at least one uncaughtException listener from the abort manager");
    assert.equal(uncaughtAdded.length, 1, `BLOCKER: stacked per-handle uncaught handlers (${uncaughtAdded.length}); central manager installs ONE fatal handler`);
    const origExit = process.exit;
    const exitCalls = [];
    process.exit = ((...args) => { exitCalls.push(args); });
    try {
      // ONE central fatal handler must claim every registered handle; a
      // per-handle handler cleans only its own capture (sibling skipped).
      await uncaughtAdded[0](new Error("red-central-fatal-probe"));
      assert.ok(!existsSync(homeA), "central fatal path must teardown ALL registered handles (homeA removed)");
      assert.ok(!existsSync(homeB), "central fatal path must teardown ALL registered handles (homeB removed, no sibling skipped)");
      assert.ok(exitCalls.some((c) => c[0] === 1), `BLOCKER: fatal handler returned without exit(1); compromised process continues. exitCalls=${JSON.stringify(exitCalls).slice(0, 200)}`);
    } finally {
      process.exit = origExit;
    }
  });
});

test("RED central-abort (3) foreign-path cleanup: syncTeardown must refuse handles NOT in the registry", async () => {
  await withFakePaseoOnPath(async () => {
    const { syncTeardown } = await import("./paseoIsolatedHome.mjs");
    // A live foreign home the manager never registered: must never be touched.
    const foreignHome = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-central-foreign-"));
    await fs.writeFile(path.join(foreignHome, "probe.txt"), "foreign");
    const foreignHandle = {
      home: foreignHome,
      host: "127.0.0.1",
      port: 16767,
      daemonUrl: "ws://127.0.0.1:16767/ws",
      previous: {},
      cleaned: false,
    };
    try {
      const result = syncTeardown(foreignHandle);
      assert.equal(result?.cleaned ?? false, false, "BLOCKER: unregistered foreign handle reported cleaned");
      assert.ok(
        result?.reason === "unregistered-handle" || result?.reason === "not-registered",
        `BLOCKER: unregistered handle must no-op with a registry-membership reason; got ${JSON.stringify(result).slice(0, 300)}`
      );
      assert.ok(existsSync(foreignHome), "BLOCKER: syncTeardown cleaned a path the registry never owned (foreign-path cleanup)");
      assert.ok(existsSync(path.join(foreignHome, "probe.txt")), "foreign home contents must be untouched");
      assert.equal(foreignHandle.cleaned, false, "foreign handle must not flip cleaned");
    } finally {
      await fs.rm(foreignHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

test("RED central-abort (4) stacked-handler interference: N setups install ONE listener set (refcounted)", async () => {
  await withFakePaseoOnPath(async ({ before, handles }) => {
    const { setupIsolatedPaseoHome, teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
    const handleA = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-n-a-", startTimeoutMs: 10_000 });
    handles.push(handleA);
    const afterOne = listenerSnapshot();
    assert.equal(addedCount(before, afterOne), 4, `one setup installs exactly ONE manager set (SIGINT/SIGTERM/uncaught/unhandled); added=${addedCount(before, afterOne)}`);
    const handleB = await setupIsolatedPaseoHome({ prefix: "aeh-red-central-n-b-", startTimeoutMs: 10_000 });
    handles.push(handleB);
    const afterTwo = listenerSnapshot();
    assert.equal(
      addedCount(before, afterTwo),
      4,
      `BLOCKER: two setups stacked ${addedCount(before, afterTwo)} listeners; central manager installs ONCE (refcounted, never stacked duplicates)`
    );
    // Refcounted: releasing one handle keeps the single set; releasing the
    // last removes it (no orphan listeners, no premature removal).
    await teardownIsolatedPaseoHome(handleA);
    const afterFirstTeardown = listenerSnapshot();
    assert.equal(addedCount(before, afterFirstTeardown), 4, "manager must stay installed while the registry is non-empty");
    await teardownIsolatedPaseoHome(handleB);
    const afterBothTeardown = listenerSnapshot();
    assert.equal(addedCount(before, afterBothTeardown), 0, "manager must uninstall when the last handle unregisters (no orphan listeners)");
  });
});
