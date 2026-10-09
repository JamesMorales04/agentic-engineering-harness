import http from "node:http";
import { describe, expect, it } from "vitest";
import { LocalControlCenterV1, remoteOptionsFromEnvironment } from "../src/control-center/server.js";

const REMOTE_HOST = "workstation-test.tail12345.ts.net";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;

function remoteOptions() {
  return { mode: "trusted-proxy" as const, allowedOrigins: [REMOTE_ORIGIN], allowedHosts: [REMOTE_HOST] };
}

function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: Number(target.port), path: `${target.pathname}${target.search}`, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("Control Center trusted-proxy remote access", () => {
  it("keeps default loopback behavior unchanged", async () => {
    const center = new LocalControlCenterV1();
    expect(center.isRemoteEnabled()).toBe(false);
    const started = await center.start();
    try {
      const session = await (await import("./helpers/controlCenterSession.js")).pairControlCenter(started);
      const overview = await (await fetch(`${started.url}api/v1/overview`, { headers: session.headers() })).json() as { security: Record<string, unknown> };
      expect(overview.security).toMatchObject({ loopbackOnly: true, remoteMode: "disabled", authenticated: true, csrfForMutations: true });
      // Remote Host is rejected when remote mode is disabled.
      const forged = await rawRequest(`${started.url}health`, { headers: { Host: REMOTE_HOST } });
      expect(forged.status).toBe(403);
    } finally {
      await center.close();
    }
  });

  it("rejects invalid remote configuration fail-closed", () => {
    expect(() => new LocalControlCenterV1({ remote: { mode: "trusted-proxy", allowedOrigins: [], allowedHosts: [] } })).toThrow();
    expect(() => new LocalControlCenterV1({ remote: { mode: "trusted-proxy", allowedOrigins: ["http://insecure.example"], allowedHosts: ["insecure.example"] } })).toThrow();
    expect(() => remoteOptionsFromEnvironment({ AEH_CONTROL_CENTER_REMOTE_MODE: "funnel" })).toThrow();
    expect(remoteOptionsFromEnvironment({})).toBeUndefined();
  });

  it("trusted remote HTTPS access succeeds with pairing and Secure cookie", async () => {
    const center = new LocalControlCenterV1({ remote: remoteOptions(), onDecision: () => ({ accepted: true }) });
    expect(center.isRemoteEnabled()).toBe(true);
    const started = await center.start();
    try {
      const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
      const loopbackOrigin = new URL(started.url).origin;
      // Pairing over the trusted proxy origin succeeds.
      const pair = await rawRequest(`${started.url}api/v1/pair`, {
        method: "POST",
        headers: { Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ nonce })).toString() },
        body: JSON.stringify({ nonce }),
      });
      expect(pair.status).toBe(200);
      const setCookie = Array.isArray(pair.headers["set-cookie"]) ? pair.headers["set-cookie"].join(";") : String(pair.headers["set-cookie"] ?? "");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Secure");
      const { csrfToken } = JSON.parse(pair.text) as { csrfToken: string };
      const cookie = setCookie.split(";", 1)[0]!;
      // Authenticated overview over the private connection.
      const overviewRes = await rawRequest(`${started.url}api/v1/overview`, {
        headers: { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", Cookie: cookie },
      });
      expect(overviewRes.status).toBe(200);
      const overview = JSON.parse(overviewRes.text) as { security: Record<string, unknown> };
      expect(overview.security).toMatchObject({ loopbackOnly: false, remoteMode: "trusted-proxy" });
      // Legitimate Owner decision can be submitted remotely.
      const decisionBody = JSON.stringify({ operationId: "OP", requestId: "request:x", choiceId: "x" });
      const decision = await rawRequest(`${started.url}api/v1/decisions`, {
        method: "POST",
        headers: {
          Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https",
          Cookie: cookie, "X-AEH-CSRF": csrfToken, "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(decisionBody).toString(),
        },
        body: decisionBody,
      });
      expect(decision.status).toBe(200);
      // Loopback origin still works alongside remote.
      const loopbackHealth = await rawRequest(`${started.url}health`, { headers: { Host: "127.0.0.1" } });
      expect(loopbackHealth.status).toBe(200);
      void loopbackOrigin;
    } finally {
      await center.close();
    }
  });

  it("rejects forged Host, Origin, and forwarding headers", async () => {
    const center = new LocalControlCenterV1({ remote: remoteOptions() });
    const started = await center.start();
    try {
      // Forged Host.
      expect((await rawRequest(`${started.url}health`, { headers: { Host: "attacker.example" } })).status).toBe(403);
      // Remote Host without https forwarding marker fails closed (proxy misconfiguration).
      expect((await rawRequest(`${started.url}health`, { headers: { Host: REMOTE_HOST } })).status).toBe(403);
      // Untrusted proxy headers fail closed.
      expect((await rawRequest(`${started.url}health`, { headers: { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example" } })).status).toBe(403);
      expect((await rawRequest(`${started.url}health`, { headers: { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", Forwarded: "for=1.2.3.4" } })).status).toBe(403);
      expect((await rawRequest(`${started.url}health`, { headers: { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", "X-Forwarded-For": "a, b" } })).status).toBe(403);
      // Wrong Origin on pairing fails.
      const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
      const badOrigin = await rawRequest(`${started.url}api/v1/pair`, {
        method: "POST",
        headers: { Host: REMOTE_HOST, Origin: "https://attacker.example", "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": "2" },
        body: JSON.stringify({ nonce }),
      });
      expect(badOrigin.status).toBe(403);
    } finally {
      await center.close();
    }
  });

  it("rejects unauthenticated mutation, CSRF, and replay", async () => {
    const center = new LocalControlCenterV1({ remote: remoteOptions(), onDecision: () => ({ accepted: true }) });
    const started = await center.start();
    try {
      const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
      const pair = await rawRequest(`${started.url}api/v1/pair`, {
        method: "POST",
        headers: { Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ nonce })).toString() },
        body: JSON.stringify({ nonce }),
      });
      expect(pair.status).toBe(200);
      const setCookie = (Array.isArray(pair.headers["set-cookie"]) ? pair.headers["set-cookie"].join(";") : String(pair.headers["set-cookie"] ?? ""));
      const cookie = setCookie.split(";", 1)[0]!;
      const { csrfToken } = JSON.parse(pair.text) as { csrfToken: string };
      const body = JSON.stringify({ operationId: "OP", requestId: "r", choiceId: "c" });
      const base = { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", Cookie: cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() };
      // No session cookie.
      expect((await rawRequest(`${started.url}api/v1/decisions`, { method: "POST", headers: { Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https", "X-AEH-CSRF": csrfToken, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() }, body })).status).toBe(401);
      // Missing CSRF.
      expect((await rawRequest(`${started.url}api/v1/decisions`, { method: "POST", headers: { ...base, Origin: REMOTE_ORIGIN }, body })).status).toBe(403);
      // Wrong CSRF.
      expect((await rawRequest(`${started.url}api/v1/decisions`, { method: "POST", headers: { ...base, Origin: REMOTE_ORIGIN, "X-AEH-CSRF": "0".repeat(csrfToken.length) }, body })).status).toBe(403);
      // Replay of pairing nonce fails.
      const replay = await rawRequest(`${started.url}api/v1/pair`, {
        method: "POST",
        headers: { Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ nonce })).toString() },
        body: JSON.stringify({ nonce }),
      });
      expect(replay.status).toBe(403);
    } finally {
      await center.close();
    }
  });

  it("serves SSE over the private connection and revokes on disable", async () => {
    const center = new LocalControlCenterV1({ remote: remoteOptions() });
    const started = await center.start();
    try {
      const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
      const pair = await rawRequest(`${started.url}api/v1/pair`, {
        method: "POST",
        headers: { Host: REMOTE_HOST, Origin: REMOTE_ORIGIN, "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ nonce })).toString() },
        body: JSON.stringify({ nonce }),
      });
      expect(pair.status).toBe(200);
      const cookie = (Array.isArray(pair.headers["set-cookie"]) ? pair.headers["set-cookie"].join(";") : String(pair.headers["set-cookie"] ?? "")).split(";", 1)[0]!;
      const events = await rawRequest(`${started.url}api/v1/events/history`, { headers: { Host: REMOTE_HOST, "X-Forwarded-Proto": "https", Cookie: cookie } });
      expect(events.status).toBe(200);
    } finally {
      await center.close();
    }
    // Disabling remote access revokes the external entry point.
    const loopbackOnly = new LocalControlCenterV1();
    const restarted = await loopbackOnly.start();
    try {
      expect((await rawRequest(`${restarted.url}health`, { headers: { Host: REMOTE_HOST } })).status).toBe(403);
    } finally {
      await loopbackOnly.close();
    }
  });
});
