import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Luna round-9 (ru/packed-isolation-10): three rejected points from
// ru/packed-isolation-9 (b7dfefc). Each test below is RED on the round-9 tip
// and GREEN after the round-10 repair. Production file under test:
// tests/packed/paseoIsolatedHome.mjs (verify with
// `git show ru/packed-isolation-9:tests/packed/paseoIsolatedHome.mjs`).
//
// C1: timeout must CLOSE the pending discovery server (pre-round-10
//   Promise.race left the findFreePort server bound, keeping the process
//   alive). Verified with a REAL pending server, not a fake without handles.
// C2: options.portDiscoveryTimeoutMs must be validated finite + positive,
//   throwing explicit PASEO_ISOLATION_INVALID at setup entry before any side
//   effect (0/negative -> immediate, Infinity -> overflow).
// C3: PORT_TIMEOUT must be retried in the bounded setup loop (same
//   maxPortAttempts budget as EADDRINUSE); exhaustion still throws
//   PASEO_ISOLATION_UNAVAILABLE loudly.

// ---------------------------------------------------------------------------
// C1: timeout closes a REAL pending server.
// ---------------------------------------------------------------------------

test("C1: timeout CLOSES the REAL pending discovery server (no leaked handle)", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const origCreate = net.createServer;
  const captured = [];
  net.createServer = function (...args) {
    const srv = origCreate(...args);
    captured.push(srv);
    const origListen = srv.listen.bind(srv);
    let wrapped = false;
    srv.listen = function (...largs) {
      if (!wrapped) {
        wrapped = true;
        const cb = largs.length && typeof largs[largs.length - 1] === "function" ? largs.pop() : undefined;
        // Bind a REAL loopback port (holds a real handle) but swallow the
        // discovery callback so the promise never settles via listen.
        origListen(...largs);
        void cb;
        return srv;
      }
      return origListen(...largs);
    };
    return srv;
  };
  t.after(() => {
    net.createServer = origCreate;
    for (const s of captured) {
      try { s.close(); } catch { /* best-effort */ }
    }
  });
  const start = Date.now();
  await assert.rejects(
    mod.findFreePortWithTimeout("127.0.0.1", 200),
    (err) => {
      assert.match(String(err?.message ?? err), /PASEO_ISOLATION_UNAVAILABLE/);
      assert.match(String(err?.message ?? err), /PASEO_ISOLATION_PORT_TIMEOUT/);
      return true;
    },
    "hanging discovery must reject with UNAVAILABLE + PORT_TIMEOUT"
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `bounded reject (elapsed=${elapsed}ms)`);
  assert.ok(captured.length >= 1, "must have created a REAL server handle");
  // Give any async close a tick to settle.
  await new Promise((r) => setTimeout(r, 100));
  const srv = captured[0];
  assert.equal(srv.listening, false, "REAL pending server must be closed on timeout (listening=false), not leaked");
});

// ---------------------------------------------------------------------------
// C2: portDiscoveryTimeoutMs validation (finite + positive, INVALID fast).
// ---------------------------------------------------------------------------

test("C2: findFreePortWithTimeout rejects invalid timeoutMs with INVALID", async () => {
  const mod = await import("./paseoIsolatedHome.mjs");
  for (const bad of [0, -1, -100, Infinity, -Infinity, NaN, "fast", null, undefined === null ? 0 : undefined]) {
    // undefined triggers the default (valid) via the default parameter, so
    // skip it here; setup-entry covers the undefined->default path.
    if (bad === undefined) continue;
    await assert.rejects(
      // Wrap in an async lambda so a SYNC throw also becomes a rejection.
      async () => mod.findFreePortWithTimeout("127.0.0.1", bad),
      /PASEO_ISOLATION_INVALID/,
      `timeoutMs=${String(bad)} must throw PASEO_ISOLATION_INVALID`
    );
  }
});

test("C2: setup rejects invalid portDiscoveryTimeoutMs with INVALID before any side effect", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  t.after(() => {
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    if (savedAgent === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = savedAgent;
    if (savedSession === undefined) delete process.env.PASEO_SESSION_ID;
    else process.env.PASEO_SESSION_ID = savedSession;
    try { mod.__resetIsolationAbortManagerForTests(); } catch { /* best-effort */ }
  });
  try { mod.__resetIsolationAbortManagerForTests(); } catch { /* best-effort */ }
  for (const bad of [0, -5, Infinity, -Infinity, NaN]) {
    const before = new Set(await fs.readdir(os.tmpdir()).catch(() => []));
    const start = Date.now();
    await assert.rejects(
      mod.setupIsolatedPaseoHome({ prefix: "aeh-c2-invalid-", portDiscoveryTimeoutMs: bad }),
      /PASEO_ISOLATION_INVALID/,
      `setup with portDiscoveryTimeoutMs=${String(bad)} must throw INVALID`
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `INVALID must fail fast (elapsed=${elapsed}ms for ${String(bad)})`);
    // No side effect: env untouched and no temp home leaked for this prefix.
    assert.equal(process.env.PASEO_HOME ?? undefined, savedHome ?? undefined, "PASEO_HOME must be untouched on INVALID");
    const after = await fs.readdir(os.tmpdir()).catch(() => []);
    const leaked = after.filter((e) => e.startsWith("aeh-c2-invalid-") && !before.has(e));
    for (const entry of leaked) {
      await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true }).catch(() => undefined);
    }
    assert.equal(leaked.length, 0, `INVALID must not create a temp home (leaked: ${leaked.join(",")})`);
  }
});

// ---------------------------------------------------------------------------
// C3: PORT_TIMEOUT retried bounded; exhaustion still loud.
// ---------------------------------------------------------------------------

function makeFakePaseoBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
function portFile() { return path.join(stateDir, "port-" + Buffer.from(home).toString("hex")); }
if (args[0] === "daemon" && args[1] === "config") {
  const listen = args[args.length - 1] ?? "";
  const m = /:(\\d+)$/.exec(listen);
  if (m) fs.writeFileSync(portFile(), m[1]);
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "start") { process.exit(0); }
if (args[0] === "daemon" && args[1] === "status") {
  let port = "0";
  try { port = fs.readFileSync(portFile(), "utf8").trim() || "0"; } catch {}
  if (!port || port === "0") { console.log(JSON.stringify({ home, localDaemon: "stopped", listen: null })); process.exit(0); }
  console.log(JSON.stringify({ home, localDaemon: "running", listen: "127.0.0.1:" + port, configuredListen: "127.0.0.1:" + port }));
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "stop") {
  try { fs.unlinkSync(portFile()); } catch {}
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "ls") { console.log("[]"); process.exit(0); }
if (args[0] === "workspace" && args[1] === "ls") { console.log("[]"); process.exit(0); }
console.log(""); process.exit(0);
`;
}

test("C3: single PORT_TIMEOUT is retried and transient slowness self-heals", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-c3-retry-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch { /* best-effort */ }
  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_SESSION_ID;
  // Hang the FIRST discovery only; subsequent discoveries use the real stack.
  const origCreate = net.createServer;
  let createCount = 0;
  net.createServer = function (...args) {
    createCount += 1;
    if (createCount === 1) return { once() {}, listen() {}, close() {} };
    return origCreate(...args);
  };
  t.after(async () => {
    net.createServer = origCreate;
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
    try { mod.__resetIsolationAbortManagerForTests(); } catch { /* best-effort */ }
  });
  let handle;
  try {
    handle = await mod.setupIsolatedPaseoHome({
      prefix: "aeh-c3-transient-",
      portDiscoveryTimeoutMs: 200,
      startTimeoutMs: 8000,
      maxPortAttempts: 5,
    });
    assert.ok(handle.port, "retried setup must carry the bound port");
    assert.ok(createCount >= 2, `timeout must be retried (discoveries=${createCount})`);
    mod.assertIsolatedPaseoEnv(handle);
  } finally {
    if (handle) {
      try { await mod.teardownIsolatedPaseoHome(handle); } catch { /* best-effort */ }
      if (handle.home) await fs.rm(handle.home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

test("C3: sustained PORT_TIMEOUT exhausts the bounded budget and throws UNAVAILABLE loudly", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-c3-exhaust-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch { /* best-effort */ }
  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_SESSION_ID;
  const origCreate = net.createServer;
  let createCount = 0;
  net.createServer = function () {
    createCount += 1;
    return { once() {}, listen() {}, close() {} }; // hang every discovery
  };
  t.after(async () => {
    net.createServer = origCreate;
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
    try {
      const { readdir, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      for (const entry of await readdir(tmpdir())) {
        if (entry.startsWith("aeh-c3-exhaust-home-")) await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch { /* best-effort */ }
    try { mod.__resetIsolationAbortManagerForTests(); } catch { /* best-effort */ }
  });
  const start = Date.now();
  await assert.rejects(
    mod.setupIsolatedPaseoHome({
      prefix: "aeh-c3-exhaust-home-",
      portDiscoveryTimeoutMs: 200,
      maxPortAttempts: 3,
    }),
    (err) => {
      assert.match(String(err?.message ?? err), /PASEO_ISOLATION_UNAVAILABLE/);
      assert.match(String(err?.message ?? err), /PASEO_ISOLATION_PORT_TIMEOUT/);
      return true;
    },
    "sustained timeout must still throw UNAVAILABLE + PORT_TIMEOUT (loud, no live fallback)"
  );
  const elapsed = Date.now() - start;
  assert.ok(createCount >= 3, `exhaustion must consume the bounded budget (discoveries=${createCount}, budget=3)`);
  assert.ok(elapsed < 10000, `exhaustion must stay bounded (elapsed=${elapsed}ms)`);
});
