import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED P-NEW-4 round-4: setup-failure cleanup must NOT mark cleaned on
// home-removal alone. cleaned requires BOTH home-removed AND positive
// stopped-proof (localDaemon === "stopped" via DAEMON_STOPPED_PROOF_VALUES).
// Daemon-unknown → cleaned=false, handlers stay installed, loud trace, throw.

function makeFailingConfigBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
function count(name) {
  const f = path.join(stateDir, name);
  let n = 0;
  try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}
  fs.writeFileSync(f, String(n + 1));
  return n + 1;
}
if (args[0] === "daemon" && args[1] === "config") {
  count("daemon-config-count");
  console.error("simulated config failure (non-EADDRINUSE)");
  process.exit(1);
}
if (args[0] === "daemon" && args[1] === "stop") {
  count("daemon-stop-count");
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "status") {
  // UNVERIFIED: home echoes back but no localDaemon stopped-proof.
  console.log(JSON.stringify({ home }));
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

test("RED setup-cleanup: home-removed + daemon-unknown must NOT clean or drop handlers", async () => {
  const { setupIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-setup-cleanup-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFailingConfigBin(stateDir), { mode: 0o755 });
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
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  let threw = null;
  try {
    await setupIsolatedPaseoHome({ prefix: "aeh-red-setup-cleanup-" });
  } catch (error) {
    threw = error;
  } finally {
    console.error = origError;
  }
  const after = listenerSnapshot();
  try {
    // Setup must still fail loudly — never fall back to the live daemon.
    assert.ok(threw instanceof Error, "setup must throw on config failure");
    assert.match(String(threw?.message ?? threw), /PASEO_ISOLATION_UNAVAILABLE/);
    // Handlers installed FIRST must stay installed when daemon state is
    // unverified (home-removed alone is not verified completion).
    assert.ok(
      addedCount(before, after) >= 4,
      `abort handlers must stay installed on unverified setup cleanup (added=${addedCount(before, after)}, expected>=4)`
    );
    // Loud unverified trace (daemonStopped=false / UNVERIFIED).
    const trace = errors.join("\n");
    assert.ok(
      /UNVERIFIED|daemonStopped=false/.test(trace),
      `setup cleanup must trace the unverified daemon state; got: ${trace.slice(0, 800)}`
    );
  } finally {
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

test("RED setup-cleanup: failure paths gate cleaned on stopped-proof, not home-removal alone", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const setupIdx = src.indexOf("export async function setupIsolatedPaseoHome");
  assert.ok(setupIdx !== -1, "setupIsolatedPaseoHome must exist");
  const setupBody = src.slice(setupIdx);
  // The home-removal-alone gate must be gone from setup-failure paths.
  assert.ok(
    !setupBody.includes("handle.cleaned = await isHomeRemoved(home)"),
    "setup-failure cleanup must NOT set handle.cleaned from isHomeRemoved alone; cleaned requires stopped-proof + home-removed"
  );
  // Both failure paths must consult the accepted stopped-proof predicate.
  assert.ok(
    setupBody.includes("isDaemonStoppedSync("),
    "setup-failure cleanup must consult isDaemonStoppedSync (positive stopped-proof) before marking cleaned"
  );
});
