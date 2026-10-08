import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import test from "node:test";

// RED (Luna round-8): findFreePort promise has no timeout/cancellation —
// setup awaits it unbounded (~L650) so a never-settling discovery hangs
// setup in `setting-up` forever (never reconciled). Setup must bound port
// discovery with Promise.race + a documented timeout constant and fail with
// PASEO_ISOLATION_UNAVAILABLE on timeout (throws -> phase `failed` ->
// reconcilable). Port discovery is fast locally; the bound stays generous.

function installHangingCreateServer() {
  const original = net.createServer;
  const fake = () => ({
    once() {},
    // Never invoke the listen callback and never emit error: the
    // findFreePort promise never settles.
    listen() {},
    close() {},
  });
  net.createServer = fake;
  return () => {
    net.createServer = original;
  };
}

test("RED: port discovery is bounded by a documented timeout constant", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  assert.ok(
    src.includes("ISOLATION_PORT_DISCOVERY_TIMEOUT_MS"),
    "module must export a documented ISOLATION_PORT_DISCOVERY_TIMEOUT_MS constant"
  );
  assert.ok(
    src.includes("Promise.race"),
    "port discovery must be bounded via Promise.race"
  );
  assert.match(
    src,
    /PASEO_ISOLATION_UNAVAILABLE[^;]*timed out|timed out[^;]*PASEO_ISOLATION_UNAVAILABLE|PASEO_ISOLATION_PORT_TIMEOUT/,
    "timeout error must be distinguishable in traces and carry PASEO_ISOLATION_UNAVAILABLE"
  );
});

test("RED: never-settling discovery rejects bounded with PASEO_ISOLATION_UNAVAILABLE", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  assert.ok(
    typeof mod.findFreePortWithTimeout === "function",
    "module must export findFreePortWithTimeout(host, timeoutMs)"
  );
  const restore = installHangingCreateServer();
  t.after(restore);
  const start = Date.now();
  await assert.rejects(
    mod.findFreePortWithTimeout("127.0.0.1", 200),
    /PASEO_ISOLATION_UNAVAILABLE/,
    "hanging discovery must reject with PASEO_ISOLATION_UNAVAILABLE, not hang"
  );
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 5000,
    `bounded discovery must reject quickly (elapsed=${elapsed}ms)`
  );
});

test("RED: setup with hanging discovery throws bounded (reconcilable failure)", async (t) => {
  const mod = await import("./paseoIsolatedHome.mjs");
  const restore = installHangingCreateServer();
  t.after(restore);
  const savedHome = process.env.PASEO_HOME;
  const savedUrl = process.env.PASEO_DAEMON_URL;
  const savedAgent = process.env.PASEO_AGENT_ID;
  const savedSession = process.env.PASEO_SESSION_ID;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_SESSION_ID;
  let leakedHome;
  try {
    const start = Date.now();
    // Guard: before the fix setup hangs forever; the test itself must not.
    let guardTimer;
    const guard = new Promise((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error("HUNG: setup hung past bounded discovery")), 8000);
    });
    const attempt = mod.setupIsolatedPaseoHome({
      prefix: "aeh-red-port-timeout-",
      portDiscoveryTimeoutMs: 200,
    });
    // Capture the temp home for cleanup even though setup throws.
    attempt.catch(() => undefined);
    try {
      await assert.rejects(
        Promise.race([attempt, guard]),
        /PASEO_ISOLATION_UNAVAILABLE/,
        "setup with hanging port discovery must throw PASEO_ISOLATION_UNAVAILABLE (phase failed -> reconcilable)"
      );
    } finally {
      clearTimeout(guardTimer);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 8000, `setup must throw bounded (elapsed=${elapsed}ms)`);
    try {
      const err = await attempt.catch((e) => e);
      assert.match(String(err?.message ?? err), /PASEO_ISOLATION_UNAVAILABLE/);
    } catch {}
  } finally {
    process.env.PATH = process.env.PATH;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
    if (savedUrl === undefined) delete process.env.PASEO_DAEMON_URL;
    else process.env.PASEO_DAEMON_URL = savedUrl;
    if (savedAgent === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = savedAgent;
    if (savedSession === undefined) delete process.env.PASEO_SESSION_ID;
    else process.env.PASEO_SESSION_ID = savedSession;
    if (leakedHome) await fs.rm(leakedHome, { recursive: true, force: true }).catch(() => undefined);
    // Best-effort: remove any temp home this attempt created.
    try {
      const { readdir } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      for (const entry of await readdir(tmpdir())) {
        if (entry.startsWith("aeh-red-port-timeout-")) {
          const { join } = await import("node:path");
          await fs.rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {}
  }
});
