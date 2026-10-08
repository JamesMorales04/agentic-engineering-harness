import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertIsolatedPaseoEnv, LIVE_PASEO_LISTEN_PORT, LIVE_PASEO_WS_URL, livePaseoHome } from "./paseoIsolatedHome.mjs";

function fakeHandle(overrides = {}) {
  return {
    home: path.join(os.tmpdir(), "aeh-test-iso-home"),
    host: "127.0.0.1",
    port: 16767,
    daemonUrl: "ws://127.0.0.1:16767/ws",
    previous: {},
    cleaned: false,
    ...overrides,
  };
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("P-NEW-4: live daemon constants identify the shared live endpoint", () => {
  assert.equal(LIVE_PASEO_LISTEN_PORT, 6767);
  assert.equal(LIVE_PASEO_WS_URL, "ws://127.0.0.1:6767/ws");
  assert.equal(livePaseoHome(), path.join(os.homedir(), ".paseo"));
});

test("P-NEW-4: guard accepts a matching isolated environment", () => {
  const handle = fakeHandle();
  withEnv({ PASEO_HOME: handle.home, PASEO_DAEMON_URL: handle.daemonUrl }, () => {
    assertIsolatedPaseoEnv(handle);
  });
});

test("P-NEW-4: guard refuses the live home and the live daemon URL", () => {
  const handle = fakeHandle();
  withEnv({ PASEO_HOME: livePaseoHome(), PASEO_DAEMON_URL: handle.daemonUrl }, () => {
    assert.throws(() => assertIsolatedPaseoEnv(handle), /PASEO_ISOLATION_UNVERIFIED/);
  });
  withEnv({ PASEO_HOME: handle.home, PASEO_DAEMON_URL: LIVE_PASEO_WS_URL }, () => {
    assert.throws(() => assertIsolatedPaseoEnv(handle), /PASEO_ISOLATION_UNVERIFIED/);
  });
  withEnv({ PASEO_HOME: undefined, PASEO_DAEMON_URL: undefined }, () => {
    assert.throws(() => assertIsolatedPaseoEnv(handle), /PASEO_ISOLATION_UNVERIFIED/);
  });
});

test("P-NEW-4: guard refuses a missing handle and a live-port collision", () => {
  assert.throws(() => assertIsolatedPaseoEnv(undefined), /PASEO_ISOLATION_UNVERIFIED/);
  const colliding = fakeHandle({ port: LIVE_PASEO_LISTEN_PORT, daemonUrl: LIVE_PASEO_WS_URL });
  withEnv({ PASEO_HOME: colliding.home, PASEO_DAEMON_URL: colliding.daemonUrl }, () => {
    assert.throws(() => assertIsolatedPaseoEnv(colliding), /PASEO_ISOLATION_UNVERIFIED/);
  });
});

test("P-NEW-4: laneEnvironment preserves isolation pointers while stripping the deterministic runtime", () => {
  // Mirrors the campaign laneEnvironment() contract: AEH_DETERMINISTIC_* and
  // foreign caller identity are stripped, PASEO_HOME/PASEO_DAEMON_URL flow through.
  const handle = fakeHandle();
  withEnv(
    {
      PASEO_HOME: handle.home,
      PASEO_DAEMON_URL: handle.daemonUrl,
      PASEO_AGENT_ID: "live-caller",
      AEH_DETERMINISTIC_PASEO_RUNTIME: "1",
      AEH_OPERATION_ID: "OP-1",
    },
    () => {
      const env = { ...process.env };
      for (const key of ["AEH_DETERMINISTIC_PASEO_RUNTIME", "AEH_DETERMINISTIC_PASEO", "PASEO_AGENT_ID", "PASEO_SESSION_ID"]) delete env[key];
      for (const key of Object.keys(env)) if (key.startsWith("AEH_")) delete env[key];
      assert.equal(env.PASEO_HOME, handle.home);
      assert.equal(env.PASEO_DAEMON_URL, handle.daemonUrl);
      assert.ok(!("AEH_DETERMINISTIC_PASEO_RUNTIME" in env));
      assert.ok(!("PASEO_AGENT_ID" in env));
      assert.ok(!Object.keys(env).some((key) => key.startsWith("AEH_")));
    }
  );
});
