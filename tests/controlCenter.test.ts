import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalControlCenterV1, createProjectHome } from "../src/control-center/index.js";
import { recordControlCenterDecision } from "../src/control-center/decision.js";
import { ProjectRegistryV1 } from "../src/projects/index.js";
import { HumanDecisionLedgerV1 } from "../src/security/humanDecision.js";
import { patchOperation, saveOperation } from "../src/operations/state.js";
import { pairControlCenter } from "./helpers/controlCenterSession.js";
import { getBuildIdentity } from "../src/build/identity.js";

describe("LocalControlCenterV1", () => {
  it("serves the separately built frontend with a strict static boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-ui-"));
    const uiRoot = path.join(root, "dist");
    await fs.mkdir(path.join(uiRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><html><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>");
    await fs.writeFile(path.join(uiRoot, "assets", "app.js"), "console.log('react bundle');");
    await fs.writeFile(path.join(root, "outside-secret.js"), "outside-control-center-root");
    await fs.symlink(path.join(root, "outside-secret.js"), path.join(uiRoot, "assets", "linked.js"));
    const center = new LocalControlCenterV1({ uiRoot });
    const started = await center.start();
    try {
      const document = await fetch(started.url);
      expect(document.status).toBe(200);
      expect(document.headers.get("content-type")).toContain("text/html");
      expect(document.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(document.headers.get("content-security-policy")).not.toContain("unsafe-inline");
      expect(await document.text()).toContain("/assets/app.js");

      const asset = await fetch(`${started.url}assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("react bundle");

      const traversal = await fetch(`${started.url}%2e%2e%2fpackage.json`);
      expect(traversal.status).toBe(400);
      expect(await traversal.text()).not.toContain("agentic-engineering-harness");

      const linked = await fetch(`${started.url}assets/linked.js`);
      expect(linked.status).toBe(400);
      expect(await linked.text()).not.toContain("outside-control-center-root");

      const malformed = await fetch(`${started.url}%E0%A4%A`);
      expect(malformed.status).toBe(400);
    } finally {
      await center.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails explicitly when the frontend build is unavailable", async () => {
    const center = new LocalControlCenterV1({ uiRoot: path.join(os.tmpdir(), "aeh-control-ui-missing") });
    const started = await center.start();
    try {
      const response = await fetch(started.url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("frontend") });
    } finally {
      await center.close();
    }
  });

  it("serves a loopback health endpoint and paired-session overview", async () => {
    const center = new LocalControlCenterV1({ snapshot: () => ({ quality: { status: "ready" } }) });
    const started = await center.start();
    try {
      expect((await fetch(`${started.url}health`)).status).toBe(200);
      expect((await fetch(`${started.url}api/v1/overview`)).status).toBe(401);
      const session = await pairControlCenter(started);
      const response = await fetch(`${started.url}api/v1/overview`, { headers: session.headers() });
      expect(response.status).toBe(200);
      expect((await response.json())).toMatchObject({ version: 1, pairing: { mode: "single-use-pairing-session" }, buildIdentity: getBuildIdentity() });
    } finally {
      await center.close();
    }
  });

  it("uses a one-use fragment nonce to establish a separate HttpOnly session and CSRF token", async () => {
    const center = new LocalControlCenterV1();
    const started = await center.start();
    try {
      const nonce = new URL(started.pairingUrl).hash.slice("#pair=".length);
      const origin = new URL(started.url).origin;
      const first = await fetch(`${started.url}api/v1/pair`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });
      expect(first.status).toBe(200);
      const cookie = first.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const body = await first.json() as { csrfToken: string };
      expect(body.csrfToken).not.toBe(cookie.split("=", 2)[1]?.split(";", 1)[0]);
      const replay = await fetch(`${started.url}api/v1/pair`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });
      expect(replay.status).toBe(403);
      const crossOrigin = await fetch(`${started.url}api/v1/pair`, { method: "POST", headers: { Origin: "http://localhost:1", "Content-Type": "application/json" }, body: JSON.stringify({ nonce: "x".repeat(nonce.length) }) });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await center.close();
    }
  });

  it("requires a session CSRF token and same-origin checks for decision writes", async () => {
    let received: unknown;
    const center = new LocalControlCenterV1({ onDecision: (value) => { received = value; return { accepted: true }; } });
    const started = await center.start();
    try {
      const session = await pairControlCenter(started);
      const missingCsrf = await fetch(`${started.url}api/v1/decisions`, { method: "POST", headers: { Cookie: session.cookie, Origin: session.origin, "content-type": "application/json" }, body: "{}" });
      expect(missingCsrf.status).toBe(403);
      const noOrigin = await fetch(`${started.url}api/v1/decisions`, { method: "POST", headers: { Cookie: session.cookie, "content-type": "application/json", "x-aeh-csrf": session.csrfToken }, body: JSON.stringify({ decision: "approve" }) });
      expect(noOrigin.status).toBe(403);
      const response = await fetch(`${started.url}api/v1/decisions`, { method: "POST", headers: { ...session.headers(true), "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
      expect(response.status).toBe(200);
      expect(received).toEqual({ decision: "approve" });
    } finally {
      await center.close();
    }
  });

  it("records a human decision through the current candidate binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-decision-"));
    try {
      const now = new Date().toISOString();
      await saveOperation(root, { version: 1, id: "OP-DECISION", kind: "audit", status: "RUNNING", phase: "review", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
      const ledger = new HumanDecisionLedgerV1(path.join(root, "decisions.json"));
      const result = await recordControlCenterDecision(root, ledger, { operationId: "OP-DECISION", kind: "APPROVE", actorId: "human:james", reason: "reviewed the bounded evidence" });
      expect(result).toMatchObject({ accepted: true, operationId: "OP-DECISION", candidateRevision: 1 });
      expect(await ledger.list()).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("replays durable operation events across Control Center restart using the SSE cursor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-events-"));
    const now = new Date().toISOString();
    await saveOperation(root, { version: 1, id: "OP-EVENTS", kind: "audit", status: "RUNNING", phase: "planning", root, payload: { request: "review event replay" }, createdAt: now, updatedAt: now });
    let center = new LocalControlCenterV1({ operationRoots: () => [root] });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const started = await center.start();
      const session = await pairControlCenter(started);
      const stream = await fetch(`${started.url}api/v1/events`, { headers: session.headers() });
      expect(stream.status).toBe(200);
      reader = stream.body!.getReader();
      const first = parseSseFrame(await readSseEventFrame(reader));
      expect(first.event).toMatchObject({ type: "operation.created", data: { operationId: "OP-EVENTS", phase: "planning" } });
      expect(first.id).toBeTruthy();

      await patchOperation(root, "OP-EVENTS", { phase: "review" });
      const second = parseSseFrame(await readSseEventFrame(reader));
      expect(second.event).toMatchObject({ type: "operation.updated", data: { operationId: "OP-EVENTS", phase: "review" } });
      await reader.cancel();
      reader = undefined;
      await center.close();

      center = new LocalControlCenterV1({ operationRoots: () => [root] });
      const restarted = await center.start();
      const newSession = await pairControlCenter(restarted);
      const history = await fetch(`${restarted.url}api/v1/events/history`, { headers: newSession.headers() }).then((response) => response.json()) as { items: Array<{ type: string }> };
      expect(history.items.map((event) => event.type)).toEqual(["operation.created", "operation.updated"]);

      const replay = await fetch(`${restarted.url}api/v1/events`, { headers: { ...newSession.headers(), "Last-Event-ID": first.id } });
      expect(replay.status).toBe(200);
      const replayReader = replay.body!.getReader();
      const replayed = parseSseFrame(await readSseEventFrame(replayReader));
      expect(replayed.event).toMatchObject({ type: "operation.updated", data: { phase: "review" } });
      await replayReader.cancel();
    } finally {
      await reader?.cancel().catch(() => undefined);
      await center.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("selects and auto-opens a registered project only through authenticated CSRF-protected Home requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-home-"));
    try {
      const firstRoot = path.join(root, "first");
      const secondRoot = path.join(root, "second");
      await fs.mkdir(firstRoot);
      await fs.mkdir(secondRoot);
      const registry = new ProjectRegistryV1(path.join(root, "registry.json"));
      await registry.register({ projectId: "project-one", rootPath: firstRoot, repositoryIdentity: "acme/one", configDigest: "one" });
      await registry.register({ projectId: "project-two", rootPath: secondRoot, repositoryIdentity: "acme/two", configDigest: "two" });
      const center = await createProjectHome({ registry, projectId: "project-one" });
      const started = await center.start();
      try {
        const session = await pairControlCenter(started);
        const initial = await fetch(`${started.url}api/v1/overview`, { headers: session.headers() });
        expect((await initial.json())).toMatchObject({ project: { projectId: "project-one" }, projectSelection: { projectId: "project-one", autoOpen: true } });

        const selectionUrl = `${started.url}api/v1/projects/project-two/select`;
        expect((await fetch(selectionUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
        const selected = await fetch(selectionUrl, {
          method: "POST",
          headers: { ...session.headers(true), "content-type": "application/json" },
          body: JSON.stringify({ autoOpen: true })
        });
        expect(selected.status).toBe(200);
        expect(await selected.json()).toMatchObject({ selection: { projectId: "project-two", autoOpen: true }, project: { projectId: "project-two" } });
      } finally {
        await center.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports selected-project availability and bounded runtime health without exposing credentials", async () => {
    const healthServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", credential: "should-not-leak" }));
    });
    await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    const address = healthServer.address();
    if (!address || typeof address === "string") throw new Error("health server did not start");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-health-"));
    try {
      const projectRoot = path.join(root, "project");
      await fs.mkdir(projectRoot);
      const registry = new ProjectRegistryV1(path.join(root, "registry.json"));
      await registry.register({
        projectId: "project-health",
        rootPath: projectRoot,
        repositoryIdentity: "acme/health",
        configDigest: "health",
        health: { healthUrl: `http://127.0.0.1:${address.port}/health`, nonce: "runtime-secret", pid: process.pid }
      });
      const center = await createProjectHome({ registry, healthProbeTimeoutMs: 100 });
      const started = await center.start();
      try {
        const session = await pairControlCenter(started);
        const response = await fetch(`${started.url}api/v1/overview`, { headers: session.headers() });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(JSON.parse(body)).toMatchObject({ projectHealth: { availability: "available", runtime: { status: "healthy" } } });
        expect(body).not.toContain("runtime-secret");
        expect(body).not.toContain("should-not-leak");
      } finally {
        await center.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not probe a non-loopback health URL from a legacy registry record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-ssrf-"));
    try {
      const projectRoot = path.join(root, "project");
      await fs.mkdir(projectRoot);
      const registryPath = path.join(root, "registry.json");
      const registry = new ProjectRegistryV1(registryPath);
      const project = await registry.register({ rootPath: projectRoot, repositoryIdentity: "acme/ssrf", configDigest: "ssrf" });
      await fs.writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ ...project, health: { status: "healthy", healthUrl: "http://169.254.169.254/latest/meta-data", nonceDigest: "0".repeat(64), registeredAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() } }] }));
      const center = await createProjectHome({ registry, projectId: project.projectId });
      const started = await center.start();
      try {
        const session = await pairControlCenter(started);
        const response = await fetch(`${started.url}api/v1/overview`, { headers: session.headers() });
        expect(response.status).toBe(200);
        expect((await response.json()).projectHealth.runtime.status).toBe("unreachable");
      } finally {
        await center.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function readSseEventFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream ended before the next durable event.");
    buffer += decoder.decode(next.value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.split("\n").some((line) => line.startsWith("data: "))) return frame;
    }
  }
}

function parseSseFrame(frame: string): { id: string; event: Record<string, unknown> } {
  const id = /^id: (.+)$/m.exec(frame)?.[1];
  const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  if (!id || !data) throw new Error("SSE event did not include its durable cursor and event payload.");
  return { id, event: JSON.parse(data) as Record<string, unknown> };
}
