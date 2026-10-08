import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-7 F2: pre-flight reconciliation of leaked setup-failure
// registrations. Round-6 retains unverified handles only for verified teardown
// or abort; a failed setup with no later abort leaks the registration forever.
// Required: each new setupIsolatedPaseoHome FIRST attempts verified teardown
// (bounded, best-effort, traced) of leftover registered handles from prior
// failed setups (any handle not owned by the current setup), unregistering on
// success. Every leaked registration thus gains an owner (the next setup).
// Document the chain (failed setup -> next setup reconciles; last-suite-leak
// covered by abort path).

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

test("RED F2 reconcile code gate: setup FIRST reconciles leftover handles (bounded, traced, documented chain)", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const setupIdx = src.indexOf("export async function setupIsolatedPaseoHome");
  assert.ok(setupIdx !== -1, "setupIsolatedPaseoHome must exist");
  const setupBody = src.slice(setupIdx);
  // Pre-flight reconciliation must exist in the setup path.
  assert.ok(
    /reconcile/i.test(setupBody),
    "BLOCKER F2: setupIsolatedPaseoHome must FIRST reconcile leftover registered handles (no reconcile found in setup path)"
  );
  // Must attempt verified teardown of leftovers via the verified sync path.
  assert.ok(
    setupBody.includes("syncTeardown"),
    "BLOCKER F2: pre-flight reconcile must attempt verified teardown (syncTeardown) of leftover handles"
  );
  // Documented ownership chain: failed setup -> next setup reconciles; last leak -> abort.
  assert.ok(
    /next setup reconciles|gains an owner|last-suite-leak|abort path/i.test(src),
    "BLOCKER F2: must document the chain (failed setup -> next setup reconciles; last-suite-leak covered by abort path)"
  );
});

test("RED F2 reconcile behavior: next setup claims a prior failed-setup leak without abort", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-reconcile-"));
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
  let leakedHome;
  try {
    mod = await import("./paseoIsolatedHome.mjs");
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
    // Simulate a prior failed setup leak: hand-built handle, registered, home present.
    // Phase (P-NEW-4 round-8): a failed-setup leak is phase 'failed' (provably
    // ownerless) — the only phase pre-flight reconciles. 'live'/'setting-up'
    // handles are never touched (see paseoIsolationPhaseGateRed.test.mjs).
    leakedHome = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-reconcile-leak-"));
    await fs.writeFile(path.join(leakedHome, "probe.txt"), "leak");
    const leaked = { home: leakedHome, host: "127.0.0.1", port: 19211, daemonUrl: "ws://127.0.0.1:19211/ws", previous: {}, cleaned: false, phase: "failed" };
    mod.__registerIsolationHandleForTests(leaked);
    assert.ok(mod.__isIsolationHandleRegisteredForTests(leaked), "leak precondition: handle registered");
    console.error = (...args) => { errors.push(args.map(String).join(" ")); };
    // Next setup must reconcile the leak WITHOUT any abort signal.
    const next = await mod.setupIsolatedPaseoHome({ prefix: "aeh-red-reconcile-next-", startTimeoutMs: 10_000 });
    handles.push(next);
    console.error = origError;
    const trace = errors.join("\n");
    // The leak gains an owner: verified teardown + unregistered on success.
    assert.equal(leaked.cleaned, true, "BLOCKER F2: next setup did not reconcile the prior failed-setup leak (leaked.cleaned still false)");
    assert.ok(!mod.__isIsolationHandleRegisteredForTests(leaked), "BLOCKER F2: reconciled leak must unregister on verified success; leaked registration never reconciled without abort");
    // Best-effort traced reconcile (loud, with identity).
    assert.ok(
      /RECONCILE|reconcile/i.test(trace) && trace.includes(leakedHome),
      `BLOCKER F2: pre-flight reconcile must trace the leftover attempt with handle identity. Got: ${trace.slice(0, 1200)}`
    );
    // The next setup itself still works and stays registered until its teardown.
    assert.ok(next?.home, "next setup must still return a handle");
    assert.ok(mod.__isIsolationHandleRegisteredForTests(next), "next setup handle must be registered");
  } finally {
    console.error = origError;
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
