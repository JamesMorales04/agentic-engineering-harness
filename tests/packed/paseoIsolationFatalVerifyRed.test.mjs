import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-7 F1: fatal path must verify-and-retry (bounded) and LOUDLY
// record VERIFIED vs UNVERIFIED with handle identity before exit(1).
// Round-6 handleIsolationFatal best-effort-teardowns once then unconditional
// exit(1) with a generic "cleaned" line; unverified handles stay registered
// silently. Required: bounded sync verify-and-retry in the fatal path (sync
// teardown + positive verification isDaemonStoppedSync + home-removed, retry
// bounded times via a documented constant); exit(1) ONLY after verified OR
// retries exhausted, outcome LOUDLY recorded (stderr: VERIFIED vs UNVERIFIED
// with handle identity). Never exit silently-unverified; never hang.

function makeUnverifiableFakePaseoBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
if (args[0] === "daemon" && args[1] === "status") {
  // UNVERIFIABLE: always running, never stopped-proof.
  console.log(JSON.stringify({ home, localDaemon: "running", listen: "127.0.0.1:19999", configuredListen: "127.0.0.1:19999" }));
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "stop") { process.exit(0); }
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

function addedListeners(before, event) {
  const baseline = new Set(before[event]);
  return process.listeners(event).filter((l) => !baseline.has(l));
}

function removeAddedListeners(before) {
  for (const key of Object.keys(before)) {
    const baseline = new Set(before[key]);
    for (const listener of process.listeners(key).slice()) {
      if (!baseline.has(listener)) {
        try { process.removeListener(key, listener); } catch {}
      }
    }
  }
}

test("RED F1 fatal-verify code gate: fatal path has bounded verify-and-retry + VERIFIED vs UNVERIFIED with identity", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const fatalIdx = src.indexOf("function handleIsolationFatal");
  assert.ok(fatalIdx !== -1, "handleIsolationFatal must exist");
  const fatalBody = src.slice(fatalIdx, src.indexOf("\n}", fatalIdx) + 2);
  // Documented bounded constant for the fatal verify-and-retry loop.
  assert.ok(
    /ISOLATION_FATAL_MAX_ATTEMPTS|FATAL_MAX|FATAL_VERIFY_MAX/.test(src),
    "BLOCKER F1: fatal path must have a documented bounded retry constant (e.g. ISOLATION_FATAL_MAX_ATTEMPTS=3); unbounded or single-shot exit is forbidden"
  );
  // Fatal body must positively verify (stopped-proof + home-removed).
  assert.ok(
    fatalBody.includes("isDaemonStoppedSync"),
    "BLOCKER F1: fatal path must positively verify via isDaemonStoppedSync (stopped-proof), not trust stop exit codes"
  );
  assert.ok(
    /isHomeRemovedSync|home-removed|homeRemoved/.test(fatalBody),
    "BLOCKER F1: fatal path must positively verify home-removed alongside daemon-stopped"
  );
  // Fatal body must loudly record VERIFIED vs UNVERIFIED with handle identity.
  assert.ok(
    fatalBody.includes("VERIFIED") && fatalBody.includes("UNVERIFIED"),
    "BLOCKER F1: fatal path must LOUDLY record VERIFIED vs UNVERIFIED outcome per handle; generic 'cleaned' line is silently-unverified"
  );
  // Bounded retry loop in the fatal path (not just the inner syncTeardown loop).
  assert.ok(
    /for\s*\(|while\s*\(/.test(fatalBody),
    "BLOCKER F1: fatal path must retry verify-and-retry in a bounded loop; single-shot teardown then exit is forbidden"
  );
  // Exit only after verified OR retries exhausted — exit(1) must still exist.
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/process\.exit\s*\(\s*1\s*\)/.test(code), "fatal path must still process.exit(1) after verified-or-exhausted");
});

test("RED F1 fatal-verify behavior: unverifiable handles exit(1) ONLY with LOUD UNVERIFIED + identity (bounded, no hang)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-fatal-verify-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeUnverifiableFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch {}
  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  const before = listenerSnapshot();
  const errors = [];
  const origError = console.error;
  const origExit = process.exit;
  const exitCalls = [];
  let mod;
  const leakedHomes = [];
  try {
    mod = await import("./paseoIsolatedHome.mjs");
    if (typeof mod.__resetIsolationAbortManagerForTests === "function") mod.__resetIsolationAbortManagerForTests(before);
    // Two unverifiable leaked handles (daemon never stopped-proof).
    const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-fatal-a-"));
    const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-fatal-b-"));
    leakedHomes.push(homeA, homeB);
    const handleA = { home: homeA, host: "127.0.0.1", port: 19111, daemonUrl: "ws://127.0.0.1:19111/ws", previous: {}, cleaned: false };
    const handleB = { home: homeB, host: "127.0.0.1", port: 19112, daemonUrl: "ws://127.0.0.1:19112/ws", previous: {}, cleaned: false };
    mod.__registerIsolationHandleForTests(handleA);
    mod.__registerIsolationHandleForTests(handleB);
    const uncaughtAdded = addedListeners(before, "uncaughtException");
    assert.ok(uncaughtAdded.length >= 1, "expected fatal handler from abort manager");
    console.error = (...args) => { errors.push(args.map(String).join(" ")); };
    process.exit = ((...args) => { exitCalls.push(args); });
    const start = Date.now();
    await uncaughtAdded[0](new Error("red-fatal-verify-probe"));
    const elapsed = Date.now() - start;
    // Bounded: must return quickly (sync retries, no hang).
    assert.ok(elapsed < 60_000, `fatal path hung or too slow (${elapsed}ms); must be bounded sync`);
    // Must still exit(1) — but ONLY after verified OR retries exhausted, loudly.
    assert.ok(exitCalls.some((c) => c[0] === 1), "fatal path must process.exit(1) after verified-or-exhausted");
    const trace = errors.join("\n");
    // LOUD UNVERIFIED with handle identity (home path) for each unverifiable handle.
    assert.ok(
      /UNVERIFIED/.test(trace),
      `BLOCKER F1: fatal path exited without LOUD UNVERIFIED outcome; trace was silently-unverified. Got: ${trace.slice(0, 1200)}`
    );
    assert.ok(
      trace.includes(homeA) && trace.includes(homeB),
      `BLOCKER F1: fatal UNVERIFIED trace must carry handle identity (home paths). Missing homeA/homeB. Got: ${trace.slice(0, 1500)}`
    );
    // Unverified handles stay registered (retryable) — but LOUDLY, never silently.
    assert.ok(mod.__isIsolationHandleRegisteredForTests(handleA), "unverified handleA must stay registered for retry");
    assert.ok(mod.__isIsolationHandleRegisteredForTests(handleB), "unverified handleB must stay registered for retry");
  } finally {
    console.error = origError;
    process.exit = origExit;
    try {
      const m2 = mod ?? await import("./paseoIsolatedHome.mjs");
      if (typeof m2.__resetIsolationAbortManagerForTests === "function") m2.__resetIsolationAbortManagerForTests(before);
    } catch {}
    removeAddedListeners(before);
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    for (const h of leakedHomes) await fs.rm(h, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
