import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// RED B2: free-port bind race — setup must retry on EADDRINUSE with the next
// port (bounded attempts) instead of single-shot failure. Deterministic
// simulation via a fake `paseo` on PATH: the first `daemon start` fails with
// `listen EADDRINUSE`, subsequent starts succeed. The fake persists the
// configured port per-PASEO_HOME so `daemon status --json` reports healthy.

function makeFakePaseoBin(stateDir) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.PASEO_HOME ?? "";
const stateDir = ${JSON.stringify(stateDir)};
function counter(name) {
  const f = path.join(stateDir, name);
  let n = 0;
  try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}
  fs.writeFileSync(f, String(n + 1));
  return n + 1;
}
function portFile() {
  return path.join(stateDir, "port-" + Buffer.from(home).toString("hex"));
}
if (args[0] === "daemon" && args[1] === "config") {
  const listen = args[args.length - 1] ?? "";
  const m = /:(\\d+)$/.exec(listen);
  if (m) fs.writeFileSync(portFile(), m[1]);
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "start") {
  const attempt = counter("daemon-start-count");
  let port = "0";
  try { port = fs.readFileSync(portFile(), "utf8").trim() || "0"; } catch {}
  if (attempt === 1) {
    console.error("listen EADDRINUSE: address already in use 127.0.0.1:" + port);
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "status") {
  let port = "0";
  try { port = fs.readFileSync(portFile(), "utf8").trim() || "0"; } catch {}
  if (!port || port === "0") {
    console.log(JSON.stringify({ home, localDaemon: "stopped", listen: null }));
    process.exit(0);
  }
  console.log(JSON.stringify({ home, localDaemon: "running", listen: "127.0.0.1:" + port, configuredListen: "127.0.0.1:" + port }));
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "stop") {
  counter("daemon-stop-count");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "ls") { console.log("[]"); process.exit(0); }
if (args[0] === "workspace" && args[1] === "ls") { console.log("[]"); process.exit(0); }
console.log("");
process.exit(0);
`;
}

test("RED B2: setup retries on EADDRINUSE with the next port instead of failing", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const { setupIsolatedPaseoHome, teardownIsolatedPaseoHome, assertIsolatedPaseoEnv } = mod;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-red-b2-"));
  const binDir = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "paseo"), makeFakePaseoBin(stateDir), { mode: 0o755 });
  try { await fs.chmod(path.join(binDir, "paseo"), 0o755); } catch {}

  const savedPath = process.env.PATH ?? "";
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_SESSION_ID;
  let handle;
  try {
    handle = await setupIsolatedPaseoHome({ prefix: "aeh-red-b2-", startTimeoutMs: 10_000 });
    assertIsolatedPaseoEnv(handle);
    assert.ok(handle.port, "handle must carry the bound port after retry");

    let startCount = 0;
    try { startCount = Number(await fs.readFile(path.join(stateDir, "daemon-start-count"), "utf8")) || 0; } catch { startCount = 0; }
    assert.ok(startCount >= 2, `setup must retry spawn on EADDRINUSE (daemon start attempts=${startCount})`);
  } finally {
    if (handle) {
      try { await teardownIsolatedPaseoHome(handle); } catch {}
    }
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
    if (handle?.home) await fs.rm(handle.home, { recursive: true, force: true }).catch(() => undefined);
  }
});
