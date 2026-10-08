import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED V1 (round-3): positive stopped-proof — {} / missing / unknown must NOT
// verify. Only the daemon's real stopped vocabulary counts.
// Source: @getpaseo/cli dist/commands/daemon/status.js localStatus():
//   let localDaemon = "stopped";
//   if (instance) localDaemon = instance.listen ? "running" : "not_ready";
// So the ONLY stopped-proof value is "stopped". "not_ready" means an instance
// record still exists (never verified). Unknown/missing → UNVERIFIED.

function makeFakePaseoBin(stateDir, statusPayload) {
  const payloadJson = JSON.stringify(statusPayload);
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
const payload = ${payloadJson};
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
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "status") {
  const out = typeof payload === "object" && payload !== null
    ? { ...payload, home }
    : payload;
  // When payload is an object, spread keeps explicit fields and injects home;
  // {} therefore stays {}+home (no localDaemon) — must NOT verify.
  console.log(JSON.stringify(out));
  process.exit(0);
}
console.log("");
process.exit(0);
`;
}

async function withFakePaseo(statusPayload, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-v1-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFakePaseoBin(stateDir, statusPayload), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch {}
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-v1-home-"));
  await fs.writeFile(path.join(home, "probe.txt"), "x");
  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  process.env.PASEO_HOME = home;
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:16767/ws";
  try {
    return await fn(home, stateDir);
  } finally {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

function baseHandle(home) {
  // NOTE round-6: no per-handle abortHandlers field. The central abort manager
  // owns listeners module-level; async teardown needs no registration. The
  // hand-built handle stays unregistered here by design (explicit teardown,
  // not the abort path).
  return {
    home,
    host: "127.0.0.1",
    port: 16767,
    daemonUrl: "ws://127.0.0.1:16767/ws",
    previous: { PASEO_HOME: undefined, PASEO_DAEMON_URL: undefined, PASEO_AGENT_ID: undefined, PASEO_SESSION_ID: undefined },
    cleaned: false,
    startedAt: new Date().toISOString(),
  };
}

test("RED V1: {} status must NOT verify daemonStopped (positive proof required)", async () => {
  const { teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  await withFakePaseo({}, async (home) => {
    const handle = baseHandle(home);
    // Home is removed by teardown (rm -rf), so homeRemoved=true; daemonStopped
    // must stay false for {} and verified must stay false.
    const accounting = await teardownIsolatedPaseoHome(handle);
    assert.equal(accounting.daemonStopped, false, "{} has no localDaemon=stopped proof; daemonStopped must be false (UNVERIFIED)");
    assert.equal(accounting.verified, false, "{} must never verify");
    assert.equal(handle.cleaned, false, "handle.cleaned must stay false when stopped-proof is missing");
  });
});

test("RED V1: unknown localDaemon value must NOT verify", async () => {
  const { teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  await withFakePaseo({ localDaemon: "weird", listen: null }, async (home) => {
    const handle = baseHandle(home);
    const accounting = await teardownIsolatedPaseoHome(handle);
    assert.equal(accounting.daemonStopped, false, "unknown localDaemon must be UNVERIFIED");
    assert.equal(accounting.verified, false, "unknown vocabulary must never verify");
  });
});

test("RED V1: not_ready must NOT verify (instance still present)", async () => {
  const { teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  await withFakePaseo({ localDaemon: "not_ready", listen: null }, async (home) => {
    const handle = baseHandle(home);
    const accounting = await teardownIsolatedPaseoHome(handle);
    assert.equal(accounting.daemonStopped, false, "not_ready means instance record exists; not stopped-proof");
    assert.equal(accounting.verified, false, "not_ready must never verify");
  });
});

test("RED V1: explicit stopped vocabulary DOES verify (control)", async () => {
  const { teardownIsolatedPaseoHome } = await import("./paseoIsolatedHome.mjs");
  await withFakePaseo({ localDaemon: "stopped", listen: null }, async (home) => {
    const handle = baseHandle(home);
    const accounting = await teardownIsolatedPaseoHome(handle);
    assert.equal(accounting.daemonStopped, true, "localDaemon=stopped is positive proof");
    assert.equal(accounting.verified, true, "stopped + homeRemoved must verify");
    assert.equal(handle.cleaned, true, "verified completion flips cleaned");
  });
});
