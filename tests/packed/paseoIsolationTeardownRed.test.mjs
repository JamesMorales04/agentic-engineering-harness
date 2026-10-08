import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED B1-1: signal-during-cleanup leaks — teardown must keep abort handlers
// installed until VERIFIED completion and must not mark cleaned before that.
// Deterministic simulation via a fake `paseo` on PATH whose `daemon stop`
// always fails (exit 1) while `daemon status` still reports running.

function makeFakePaseoBin(stateDir) {
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
if (args[0] === "agent" && args[1] === "ls") { console.log("[]"); process.exit(0); }
if (args[0] === "workspace" && args[1] === "ls") { console.log("[]"); process.exit(0); }
if (args[0] === "daemon" && args[1] === "stop") {
  count("daemon-stop-count");
  console.error("simulated stop failure");
  process.exit(1);
}
if (args[0] === "daemon" && args[1] === "status") {
  console.log(JSON.stringify({ home, localDaemon: "running", listen: "127.0.0.1:16767" }));
  process.exit(0);
}
console.log("");
process.exit(0);
`;
}

test("RED B1: failed teardown must NOT mark cleaned and must keep abort protection + retry", async () => {
  const {
    teardownIsolatedPaseoHome,
    __registerIsolationHandleForTests,
    __isIsolationHandleRegisteredForTests,
    __resetIsolationAbortManagerForTests,
  } = await import("./paseoIsolatedHome.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-b1-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch {}

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-b1-home-"));
  await fs.writeFile(path.join(home, "probe.txt"), "x");

  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  // Isolate env pointers from the live daemon for the duration of the test.
  process.env.PASEO_HOME = home;
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:16767/ws";
  const listenerBaseline = {
    SIGINT: process.listeners("SIGINT").slice(),
    SIGTERM: process.listeners("SIGTERM").slice(),
    uncaughtException: process.listeners("uncaughtException").slice(),
    unhandledRejection: process.listeners("unhandledRejection").slice(),
  };
  const addedListeners = () => {
    let total = 0;
    for (const key of Object.keys(listenerBaseline)) {
      const base = new Set(listenerBaseline[key]);
      for (const l of process.listeners(key)) if (!base.has(l)) total += 1;
    }
    return total;
  };
  let handle;
  try {
    handle = {
      home,
      host: "127.0.0.1",
      port: 16767,
      daemonUrl: "ws://127.0.0.1:16767/ws",
      previous: { PASEO_HOME: undefined, PASEO_DAEMON_URL: undefined, PASEO_AGENT_ID: undefined, PASEO_SESSION_ID: undefined },
      cleaned: false,
      startedAt: new Date().toISOString(),
    };
    // Round-6 central manager: the handle enters the live registry as a setup
    // would register it, so the failed-teardown retention below exercises the
    // real ownership proof (not the deleted per-handle abortHandlers field).
    __registerIsolationHandleForTests(handle);
    assert.equal(addedListeners(), 4, "central manager installs ONE listener set on registration");
    const accounting = await teardownIsolatedPaseoHome(handle);

    // Desired (post-fix) behavior: failure is NOT verified completion.
    assert.equal(handle.cleaned, false, "handle.cleaned must stay false after unverified teardown so a retry is possible");
    assert.equal(__isIsolationHandleRegisteredForTests(handle), true, "handle must stay registered until teardown VERIFIES (signal-during-cleanup must still clean)");
    assert.equal(addedListeners(), 4, "central manager must stay installed while the registry is non-empty");

    let stopCount = 0;
    try { stopCount = Number(await fs.readFile(path.join(stateDir, "daemon-stop-count"), "utf8")) || 0; } catch { stopCount = 0; }
    assert.ok(stopCount >= 2, `teardown must retry bounded times on failure before giving up (daemon stop attempts=${stopCount})`);
    assert.equal(accounting.daemonStopped, false, "accounting must report daemonStopped=false on failure");
  } finally {
    try { __resetIsolationAbortManagerForTests(listenerBaseline); } catch { /* best-effort */ }
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("RED B1: campaign bodies must wrap isolated teardown in try/finally", async () => {
  const campaigns = [
    "s13GovernedOperationCampaign.mjs",
    "s13ContextPermissionCampaign.mjs",
    "s13RealPaseoLifecycleCampaign.mjs",
  ];
  for (const file of campaigns) {
    const src = await fs.readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(src.includes("try"), `${file} must contain a try block for guaranteed teardown`);
    // Match the `finally` keyword (not the word inside log strings): `} finally {`
    // or `finally {` at statement position.
    const finallyKeyword = [...src.matchAll(/(^|\W)finally\s*\{/g)].map((m) => (m.index ?? 0) + m[0].indexOf("finally"));
    assert.ok(finallyKeyword.length > 0, `${file} must contain a finally block for guaranteed teardown`);
    const teardownIdx = src.lastIndexOf("await teardownIsolatedPaseoHome(");
    assert.ok(teardownIdx !== -1, `${file} must await teardownIsolatedPaseoHome`);
    const enclosingFinally = finallyKeyword.filter((idx) => idx < teardownIdx).pop();
    assert.ok(enclosingFinally !== undefined, `${file} must call teardownIsolatedPaseoHome inside finally (teardown guaranteed on every exit)`);
  }
});
