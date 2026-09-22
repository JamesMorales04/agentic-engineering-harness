import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProjectRegistryV1, ProjectRecordV1 } from "../projects/index.js";
import { loadOperation, operationEventsFile, type OperationEvent } from "../operations/state.js";
import { sha256Utf8 } from "../core/digest.js";
import { getBuildIdentity } from "../build/identity.js";
import { PaseoGatewayV1, type PaseoGatewaySnapshotV1 } from "../paseo/gateway.js";
import {
  CONTROL_CENTER_CONTRACT_VERSION,
  controlCenterResourceId,
  type ControlCenterActionResultV1,
  type ControlCenterAuthorityProjectionV1,
  type ControlCenterCandidateProjectionV1,
  type ControlCenterContextProjectionV1,
  type ControlCenterDecisionInputV1,
  type ControlCenterEventIdV1,
  type ControlCenterEventTypeV1,
  type ControlCenterEventV1,
  type ControlCenterEvidenceProjectionV1,
  type ControlCenterKnowledgeProjectionV1,
  type ControlCenterOperationDetailProjectionV1,
  type ControlCenterOperationIdV1,
  type ControlCenterOperationProjectionV1,
  type ControlCenterOverviewV1,
  type ControlCenterParticipantProjectionV1,
  type ControlCenterProjectHealthProjectionV1,
  type ControlCenterProjectIdV1,
  type ControlCenterProjectProjectionV1,
  type ControlCenterProjectSelectionV1,
  type ControlCenterResourceCollectionV1,
  type ControlCenterResourceDetailV1,
  type ControlCenterSecurityProjectionV1,
  type ControlCenterServicesProjectionV1,
  type ControlCenterSnapshotInputV1,
} from "./contracts.js";

export type { ControlCenterEventV1, ControlCenterOverviewV1 } from "./contracts.js";
export type ProjectRuntimeHealthStatusV1 = ControlCenterProjectHealthProjectionV1["runtime"]["status"];
export type ProjectSelectionV1 = ControlCenterProjectSelectionV1;
export type ProjectHealthProbeV1 = ControlCenterProjectHealthProjectionV1;

export interface LocalControlCenterOptionsV1 {
  host?: "127.0.0.1" | "localhost";
  port?: number;
  snapshot?: () => Promise<ControlCenterSnapshotInputV1> | ControlCenterSnapshotInputV1;
  onDecision?: (decision: ControlCenterDecisionInputV1) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
  onCancelOperation?: (operationId: string) => Promise<ControlCenterActionResultV1> | ControlCenterActionResultV1;
  healthProbeTimeoutMs?: number;
  paseoGateway?: PaseoGatewayV1;
  paseo?: { root: string; leadId?: string; participantLabels?: Record<string, string>; provider?: string; model?: string };
  uiRoot?: string;
  operationRoots?: () => Promise<readonly string[]> | readonly string[];
}

export interface StartedControlCenterV1 {
  url: string;
  pairingUrl: string;
  host: string;
  port: number;
}

export class ControlCenterSecurityError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "ControlCenterSecurityError";
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const CONTROL_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CONTROL_SESSION_COOKIE = "aeh_control_session";

interface ControlSessionV1 { csrfToken: string; expiresAt: number; }

interface ProjectHomeBindingV1 {
  registry: ProjectRegistryV1;
  selectedProjectId?: string;
  autoOpen: boolean;
}

interface ProjectSelectionBodyV1 {
  autoOpen?: boolean;
}

interface LeadMessageBodyV1 {
  prompt?: unknown;
}

interface PairBodyV1 { nonce?: unknown; }
type EventCursorV1 = Record<string, number>;
interface DurableControlCenterEventV1 {
  event: ControlCenterEventV1;
  cursorKey: string;
  sequence: number;
}

export class LocalControlCenterV1 {
  private readonly server: Server;
  private readonly host: "127.0.0.1" | "localhost";
  private readonly requestedPort: number;
  private pairingNonce?: string;
  private readonly snapshotProvider: LocalControlCenterOptionsV1["snapshot"];
  private readonly onDecision?: LocalControlCenterOptionsV1["onDecision"];
  private readonly onCancelOperation?: LocalControlCenterOptionsV1["onCancelOperation"];
  private readonly healthProbeTimeoutMs: number;
  private readonly projectHome?: ProjectHomeBindingV1;
  private readonly paseoGateway?: PaseoGatewayV1;
  private readonly paseo?: LocalControlCenterOptionsV1["paseo"];
  private readonly uiRoot?: string;
  private readonly operationRootsProvider?: LocalControlCenterOptionsV1["operationRoots"];
  private readonly subscribers = new Map<ServerResponse, EventCursorV1>();
  private eventPollTimer?: NodeJS.Timeout;
  private eventPoll?: Promise<void>;
  private readonly sessions = new Map<string, ControlSessionV1>();
  private started?: StartedControlCenterV1;

  constructor(options: LocalControlCenterOptionsV1 & { projectHome?: ProjectHomeBindingV1 } = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.pairingNonce = randomBytes(32).toString("base64url");
    this.snapshotProvider = options.snapshot;
    this.onDecision = options.onDecision;
    this.onCancelOperation = options.onCancelOperation;
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    if (!Number.isInteger(this.healthProbeTimeoutMs) || this.healthProbeTimeoutMs < 1 || this.healthProbeTimeoutMs > 30_000) {
      throw new Error("Control Center health probe timeout must be an integer between 1 and 30000 milliseconds.");
    }
    this.projectHome = options.projectHome;
    this.paseoGateway = options.paseoGateway;
    this.paseo = options.paseo;
    this.uiRoot = options.uiRoot ?? findBundledControlCenterUiRoot();
    this.operationRootsProvider = options.operationRoots;
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async start(): Promise<StartedControlCenterV1> {
    if (this.started) return this.started;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.requestedPort, this.host);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Control Center did not expose a TCP address.");
    const url = `http://${this.host}:${address.port}/`;
    this.started = { host: this.host, port: address.port, url, pairingUrl: `${url}#pair=${this.pairingNonce}` };
    return this.started;
  }

  async close(): Promise<void> {
    if (this.eventPollTimer) clearInterval(this.eventPollTimer);
    this.eventPollTimer = undefined;
    for (const subscriber of this.subscribers.keys()) subscriber.end();
    this.subscribers.clear();
    this.sessions.clear();
    this.pairingNonce = undefined;
    if (!this.started) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.started = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.assertLoopbackRequest(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${this.host}:${this.requestedPort}`}`);
      if (request.method === "GET" && url.pathname === "/health") return this.json(response, 200, { status: "ok", version: 1 });
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) return this.frontend(response, url.pathname, request.headers.accept);
      if (request.method === "POST") this.assertSameOrigin(request);
      if (request.method === "POST" && url.pathname === "/api/v1/pair") return this.pair(request, response);
      const session = this.sessionFor(request);
      if (!session) return this.json(response, 401, { error: "Control Center session authentication required." });
      if (request.method === "GET" && url.pathname === "/api/v1/session") return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, csrfToken: session.csrfToken });
      if (request.method === "GET" && url.pathname === "/api/v1/overview") return this.json(response, 200, await this.overview());
      if (request.method === "GET" && url.pathname === "/api/v1/events") return this.eventsStream(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/events/history") return this.json(response, 200, this.collection("event", await this.durableEvents()));
      if (request.method === "GET" && url.pathname === "/api/v1/projects") return this.json(response, 200, this.collection("project", (await this.snapshot()).projects));
      if (request.method === "GET" && url.pathname === "/api/v1/operations") return this.json(response, 200, this.collection("operation", (await this.snapshot()).operations.map(({ participants: _participants, payloadSummary: _payloadSummary, ...operation }) => operation)));
      if (request.method === "GET" && url.pathname === "/api/v1/participants") return this.json(response, 200, this.collection("participant", (await this.snapshot()).participants));
      if (request.method === "GET" && url.pathname === "/api/v1/candidates") return this.json(response, 200, this.collection("candidate", (await this.snapshot()).candidates));
      if (request.method === "GET" && url.pathname === "/api/v1/context") return this.json(response, 200, this.detail("context", (await this.snapshot()).context));
      if (request.method === "GET" && url.pathname === "/api/v1/authority") return this.json(response, 200, this.detail("authority", (await this.snapshot()).authority));
      if (request.method === "GET" && url.pathname === "/api/v1/evidence") return this.json(response, 200, this.collection("evidence", (await this.snapshot()).evidence));
      if (request.method === "GET" && url.pathname === "/api/v1/services") return this.json(response, 200, this.detail("services", (await this.snapshot()).services));
      if (request.method === "GET" && url.pathname === "/api/v1/knowledge") return this.json(response, 200, this.detail("knowledge", (await this.snapshot()).knowledge));
      if (request.method === "GET" && url.pathname === "/api/v1/paseo") return this.json(response, 200, await this.paseoSnapshot());
      const paseoTimeline = /^\/api\/v1\/paseo\/participants\/([^/]+)\/timeline$/.exec(url.pathname);
      if (request.method === "GET" && paseoTimeline) return this.paseoParticipantTimeline(response, decodeURIComponent(paseoTimeline[1]));
      if (request.method === "POST" && url.pathname === "/api/v1/paseo/lead/messages") {
        this.assertCsrf(request);
        const body = await this.body(request) as LeadMessageBodyV1;
        if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt must be a non-empty string.");
        if (body.prompt.length > 32_000) throw new Error("prompt exceeds the 32000 character limit.");
        if (!this.paseoGateway || !this.paseo?.root || !this.paseo.leadId) return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, leadId: this.paseo?.leadId ?? "", status: "DEGRADED", error: "Paseo lead conversation is not configured." });
        return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, ...await this.paseoGateway.leadConversation({ root: this.paseo.root, leadId: this.paseo.leadId, prompt: body.prompt }) });
      }
      const projectResource = /^\/api\/v1\/projects\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && projectResource) return this.projectResource(response, decodeURIComponent(projectResource[1]));
      const operationResource = /^\/api\/v1\/operations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && operationResource) return this.operationResource(response, decodeURIComponent(operationResource[1]));
      const projectSelection = /^\/api\/v1\/projects\/([^/]+)\/select$/.exec(url.pathname);
      if (request.method === "POST" && projectSelection && this.projectHome) {
        this.assertCsrf(request);
        const projectId = decodeURIComponent(projectSelection[1]);
        const project = await this.projectHome.registry.find(projectId);
        if (!project) return this.json(response, 404, { error: `project not found: ${projectId}` });
        const body = await this.body(request) as ProjectSelectionBodyV1;
        if (body.autoOpen !== undefined && typeof body.autoOpen !== "boolean") throw new Error("autoOpen must be a boolean.");
        this.projectHome.selectedProjectId = project.projectId;
        this.projectHome.autoOpen = body.autoOpen ?? true;
        const selection = this.projectSelection();
        return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, selection, project: this.publicProject(project) });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/decisions") {
        this.assertCsrf(request);
        const result = this.onDecision ? await this.onDecision(await this.body(request) as ControlCenterDecisionInputV1) : { accepted: false, reason: "no decision handler configured" };
        return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, ...result });
      }
      const cancel = /^\/api\/v1\/operations\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancel) {
        this.assertCsrf(request);
        const operationId = decodeURIComponent(cancel[1]);
        const result = this.onCancelOperation ? await this.onCancelOperation(operationId) : { accepted: false, reason: "no cancellation handler configured" };
        return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, ...result });
      }
      this.json(response, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof ControlCenterSecurityError ? error.statusCode : 400;
      this.json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async overview(): Promise<ControlCenterOverviewV1> {
    const snapshot = await this.snapshot();
    const home = this.projectHome ? await this.projectOverview() : {};
    return {
      version: CONTROL_CENTER_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      buildIdentity: getBuildIdentity(),
      ...snapshot,
      agents: snapshot.participants,
      permissions: snapshot.authority.leases,
      security: { version: CONTROL_CENTER_CONTRACT_VERSION, loopbackOnly: true, authenticated: true, csrfForMutations: true },
      pairing: { mode: "single-use-pairing-session", host: this.host },
      ...home
    };
  }

  private async snapshot(): Promise<import("./contracts.js").ControlCenterSnapshotV1> {
    const supplied = this.snapshotProvider ? await this.snapshotProvider() : {};
    const defaults: import("./contracts.js").ControlCenterSnapshotV1 = {
      projects: [],
      operations: [],
      participants: [],
      candidates: [],
      context: { version: CONTROL_CENTER_CONTRACT_VERSION, continuationCount: 0, authorizedReferenceCount: 0 },
      authority: { version: CONTROL_CENTER_CONTRACT_VERSION, leases: [] },
      evidence: [],
      services: { version: CONTROL_CENTER_CONTRACT_VERSION, capturedAt: new Date().toISOString(), services: [], providerLeases: [] },
      knowledge: { version: CONTROL_CENTER_CONTRACT_VERSION, mode: "OFFLINE", gate: "GAP", status: "MISSING", missingCompetencies: [], trustedSourceCount: 0, librarianRequired: false },
      quality: { version: CONTROL_CENTER_CONTRACT_VERSION, status: "unknown", rounds: 0, findingCount: 0, unresolvedFindingCount: 0 },
      certification: { version: CONTROL_CENTER_CONTRACT_VERSION, status: "unknown", checks: 0, passedChecks: 0, failedChecks: 0 }
    };
    const merged: import("./contracts.js").ControlCenterSnapshotV1 = {
      ...defaults,
      ...supplied,
      context: { ...defaults.context, ...supplied.context },
      authority: { ...defaults.authority, ...supplied.authority },
      knowledge: { ...defaults.knowledge, ...supplied.knowledge },
      quality: { ...defaults.quality, ...supplied.quality },
      certification: { ...defaults.certification, ...supplied.certification }
    };
    if (this.projectHome) return { ...merged, ...(await this.projectOverview()) };
    return merged;
  }

  private async projectOverview(): Promise<Pick<ControlCenterOverviewV1, "projects" | "project" | "projectSelection" | "projectHealth">> {
    const projects = await this.projectHome!.registry.list();
    const selected = this.projectHome!.selectedProjectId ? projects.find((item) => item.projectId === this.projectHome!.selectedProjectId) : undefined;
    return {
      projects: projects.map((project) => this.publicProject(project)),
      ...(selected ? { project: this.publicProject(selected), projectHealth: await this.probeProjectHealth(selected) } : {}),
      projectSelection: this.projectSelection()
    };
  }

  private collection<K extends import("./contracts.js").ControlCenterResourceKindV1, T>(resource: K, items: readonly T[]): ControlCenterResourceCollectionV1<K, T> {
    return { version: CONTROL_CENTER_CONTRACT_VERSION, resource, generatedAt: new Date().toISOString(), items: [...items] };
  }

  private detail<K extends import("./contracts.js").ControlCenterResourceKindV1, T>(resource: K, item: T): ControlCenterResourceDetailV1<K, T> {
    return { version: CONTROL_CENTER_CONTRACT_VERSION, resource, generatedAt: new Date().toISOString(), item };
  }

  private async projectResource(response: ServerResponse, requestedId: string): Promise<void> {
    const rawId = stripResourcePrefix(requestedId, "project");
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((item) => stripResourcePrefix(item.projectId, "project") === rawId);
    if (!project) return this.json(response, 404, { error: `project not found: ${rawId}` });
    this.json(response, 200, this.detail("project", project));
  }

  private async operationResource(response: ServerResponse, requestedId: string): Promise<void> {
    const rawId = stripResourcePrefix(requestedId, "operation");
    const snapshot = await this.snapshot();
    const operation = snapshot.operations.find((item) => stripResourcePrefix(item.operationId, "operation") === rawId);
    if (!operation) return this.json(response, 404, { error: `operation not found: ${rawId}` });
    this.json(response, 200, this.detail("operation", operation));
  }

  private projectSelection(): ProjectSelectionV1 {
    return {
      ...(this.projectHome?.selectedProjectId ? { projectId: controlCenterResourceId("project", this.projectHome.selectedProjectId) } : {}),
      autoOpen: this.projectHome?.autoOpen ?? false
    };
  }

  private publicProject(project: ProjectRecordV1): ControlCenterProjectProjectionV1 {
    let healthUrl: string | undefined;
    if (project.health) try {
      const url = new URL(project.health.healthUrl);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      healthUrl = url.toString();
    } catch {
      // The registry rejects unsafe URLs; never echo malformed data defensively.
      healthUrl = "redacted";
    }
    return {
      version: CONTROL_CENTER_CONTRACT_VERSION,
      projectId: controlCenterResourceId("project", project.projectId),
      repositoryIdentity: project.repositoryIdentity,
      displayName: project.displayName,
      configDigest: project.configDigest,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      availability: project.availability,
      ...(project.health ? { health: { status: project.health.status, healthUrl: healthUrl ?? "redacted", registeredAt: project.health.registeredAt, lastCheckedAt: project.health.lastCheckedAt } } : {})
    };
  }

  private async probeProjectHealth(project: ProjectRecordV1): Promise<ProjectHealthProbeV1> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    if (project.availability !== "available") return { availability: project.availability, runtime: { status: "unavailable" }, checkedAt, durationMs: Date.now() - startedAt };
    if (!project.health) return { availability: project.availability, runtime: { status: "unregistered" }, checkedAt, durationMs: Date.now() - startedAt };

    let healthUrl: URL;
    try {
      healthUrl = new URL(project.health.healthUrl);
      if (!["http:", "https:"].includes(healthUrl.protocol) || healthUrl.username || healthUrl.password || healthUrl.search || healthUrl.hash || !isLoopbackHealthHost(healthUrl.hostname)) {
        throw new Error("unsafe health URL");
      }
    } catch {
      return { availability: project.availability, runtime: { status: "unreachable" }, checkedAt, durationMs: Date.now() - startedAt };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.healthProbeTimeoutMs);
    try {
      const response = await fetch(healthUrl, { method: "GET", redirect: "error", signal: controller.signal });
      return { availability: project.availability, runtime: { status: response.ok ? "healthy" : "unhealthy" }, checkedAt, durationMs: Date.now() - startedAt };
    } catch {
      return { availability: project.availability, runtime: { status: "unreachable" }, checkedAt, durationMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertLoopbackRequest(request: IncomingMessage): void {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) throw new ControlCenterSecurityError("forwarded requests are not accepted by the loopback Control Center.");
    const host = (request.headers.host ?? "").split(":")[0].replace(/\[|\]/g, "").toLowerCase();
    if (host && host !== this.host && host !== "127.0.0.1" && host !== "localhost") throw new ControlCenterSecurityError("Control Center accepts loopback hosts only.");
  }

  private sessionFor(request: IncomingMessage): ControlSessionV1 | undefined {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${CONTROL_SESSION_COOKIE}=`));
    const sessionId = cookie?.slice(CONTROL_SESSION_COOKIE.length + 1);
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  private assertSameOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    const expectedOrigin = this.started ? new URL(this.started.url).origin : undefined;
    if (!origin || !expectedOrigin || origin !== expectedOrigin) throw new ControlCenterSecurityError("Control Center mutations require the current loopback Origin.");
  }

  private assertCsrf(request: IncomingMessage): void {
    const session = this.sessionFor(request);
    const supplied = request.headers["x-aeh-csrf"];
    if (!session || typeof supplied !== "string" || supplied.length !== session.csrfToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))) {
      throw new ControlCenterSecurityError("mutating Control Center requests require the paired session CSRF token.");
    }
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.pairingNonce) return this.json(response, 403, { error: "Control Center pairing nonce is unavailable or has already been used." });
    const body = await this.body(request) as PairBodyV1;
    if (typeof body.nonce !== "string" || body.nonce.length !== this.pairingNonce.length || !timingSafeEqual(Buffer.from(body.nonce), Buffer.from(this.pairingNonce))) {
      return this.json(response, 403, { error: "Control Center pairing nonce is invalid." });
    }
    this.pairingNonce = undefined;
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, { csrfToken, expiresAt: Date.now() + CONTROL_SESSION_TTL_SECONDS * 1_000 });
    response.setHeader("Set-Cookie", `${CONTROL_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${CONTROL_SESSION_TTL_SECONDS}`);
    this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, csrfToken });
  }

  private async paseoSnapshot(): Promise<PaseoGatewaySnapshotV1> {
    if (!this.paseoGateway || !this.paseo?.root) return { version: 1, status: "DEGRADED", capturedAt: new Date().toISOString(), message: "Paseo gateway is not configured.", participants: [] };
    return this.paseoGateway.snapshot(this.paseo);
  }

  private async paseoParticipantTimeline(response: ServerResponse, participantId: string): Promise<void> {
    if (!this.paseoGateway || !this.paseo?.root) return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, participantId, entries: [], source: "unavailable" });
    return this.json(response, 200, { version: CONTROL_CENTER_CONTRACT_VERSION, ...await this.paseoGateway.participantTimeline({ root: this.paseo.root, participantId }) });
  }

  private async body(request: IncomingMessage): Promise<ControlCenterDecisionInputV1 & ProjectSelectionBodyV1 & LeadMessageBodyV1 & PairBodyV1> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new Error("request body exceeds the Control Center limit.");
      chunks.push(buffer);
    }
    if (!size) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
      return parsed as ControlCenterDecisionInputV1 & ProjectSelectionBodyV1 & LeadMessageBodyV1 & PairBodyV1;
    }
    catch { throw new Error("request body must be valid JSON."); }
  }

  private async operationRoots(): Promise<readonly string[]> {
    if (this.operationRootsProvider) return [...new Set((await this.operationRootsProvider()).map((root) => path.resolve(root)))];
    if (this.projectHome) return [...new Set((await this.projectHome.registry.list()).map((project) => path.resolve(project.canonicalRealpath)))];
    return [];
  }

  private async durableEvents(): Promise<ControlCenterEventV1[]> {
    const grouped = new Map<string, DurableControlCenterEventV1[]>();
    for (const root of await this.operationRoots()) {
      const operationsDirectory = path.join(root, ".harness", "operations");
      let entries: import("node:fs").Dirent[];
      try { entries = await readdir(operationsDirectory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
        const operationId = entry.name.slice(0, -".json".length);
        await loadOperation(root, operationId);
        const eventsPath = operationEventsFile(root, operationId);
        let raw: string;
        try { raw = await readFile(eventsPath, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const completeText = raw.endsWith("\n") ? raw.slice(0, -1) : raw.slice(0, raw.lastIndexOf("\n"));
        if (!completeText) continue;
        const cursorKey = sha256Utf8(`${path.resolve(root)}\0${operationId}`).slice(0, 24);
        const records: DurableControlCenterEventV1[] = [];
        for (const [index, line] of completeText.split("\n").entries()) {
          let record: unknown;
          try { record = JSON.parse(line); }
          catch { throw new Error(`Invalid durable operation event at ${eventsPath}:${index + 1}.`); }
          if (!isOperationEvent(record) || record.operationId !== operationId) throw new Error(`Invalid durable operation event at ${eventsPath}:${index + 1}.`);
          const event: ControlCenterEventV1 = {
            version: CONTROL_CENTER_CONTRACT_VERSION,
            eventId: controlCenterResourceId("event", `operation:${cursorKey}:${index + 1}`) as ControlCenterEventIdV1,
            type: record.type as ControlCenterEventTypeV1,
            at: record.at,
            data: {
              operationId: controlCenterResourceId("operation", operationId),
              revision: record.revision,
              status: record.status,
              phase: record.phase,
              ...(record.changed ? { changed: record.changed } : {}),
              ...(record.details ? { details: record.details } : {})
            }
          };
          records.push({ event, cursorKey, sequence: index + 1 });
        }
        if (records.length) grouped.set(cursorKey, records);
      }
    }

    // Merge each operation's append-only sequence while preserving sequence order
    // within a source. The encoded SSE cursor tracks each source independently.
    const offsets = new Map<string, number>();
    const merged: DurableControlCenterEventV1[] = [];
    for (;;) {
      let next: DurableControlCenterEventV1 | undefined;
      let nextKey: string | undefined;
      let nextOffset = 0;
      for (const [key, records] of grouped) {
        const offset = offsets.get(key) ?? 0;
        const candidate = records[offset];
        if (!candidate) continue;
        if (!next || compareDurableEvents(candidate, next) < 0) {
          next = candidate;
          nextKey = key;
          nextOffset = offset;
        }
      }
      if (!next || nextKey === undefined) break;
      merged.push(next);
      offsets.set(nextKey, nextOffset + 1);
    }
    return merged.map(({ event }) => event);
  }

  private async eventsStream(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cursor = decodeEventCursor(request.headers["last-event-id"]);
    const events = await this.readDurableEventRecords();
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.write(": connected\n\n");
    this.subscribers.set(response, cursor);
    response.once("close", () => {
      this.subscribers.delete(response);
      if (this.subscribers.size === 0 && this.eventPollTimer) {
        clearInterval(this.eventPollTimer);
        this.eventPollTimer = undefined;
      }
    });
    this.deliverDurableEvents(response, cursor, events);
    if (!this.eventPollTimer) {
      this.eventPollTimer = setInterval(() => {
        if (!this.eventPoll) this.eventPoll = this.flushDurableEvents().catch(() => {
          for (const subscriber of this.subscribers.keys()) subscriber.destroy();
          this.subscribers.clear();
        }).finally(() => { this.eventPoll = undefined; });
      }, 1_000);
      this.eventPollTimer.unref();
    }
  }

  private async flushDurableEvents(): Promise<void> {
    if (this.subscribers.size === 0) return;
    const events = await this.readDurableEventRecords();
    for (const [response, cursor] of this.subscribers) {
      this.deliverDurableEvents(response, cursor, events);
    }
  }

  private deliverDurableEvents(response: ServerResponse, cursor: EventCursorV1, events: readonly DurableControlCenterEventV1[]): void {
    for (const { event, cursorKey, sequence } of events) {
      if (sequence <= (cursor[cursorKey] ?? 0)) continue;
      cursor[cursorKey] = sequence;
      const encodedCursor = encodeEventCursor(cursor);
      try { response.write(`id: ${encodedCursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
      catch { this.subscribers.delete(response); response.destroy(); }
    }
  }

  private async readDurableEventRecords(): Promise<DurableControlCenterEventV1[]> {
    const history = await this.durableEvents();
    const records: DurableControlCenterEventV1[] = [];
    for (const event of history) {
      const match = /^operation:([a-f0-9]{24}):(\d+)$/.exec(event.eventId);
      if (!match || !Number.isSafeInteger(Number(match[2]))) continue;
      records.push({ event, cursorKey: match[1], sequence: Number(match[2]) });
    }
    return records.sort(compareDurableEvents);
  }

  private json(response: ServerResponse, statusCode: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(body);
  }

  private async frontend(response: ServerResponse, pathname: string, accept?: string): Promise<void> {
    if (!this.uiRoot) return this.json(response, 503, { error: "Control Center frontend is not built. Run npm --prefix ui/control-center run build or configure uiRoot." });
    let relativePath: string;
    try { relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, "")); }
    catch { return this.json(response, 400, { error: "invalid frontend path" }); }
    if (relativePath.includes("\0") || relativePath.split("/").includes("..")) return this.json(response, 400, { error: "invalid frontend path" });
    const requested = path.resolve(this.uiRoot, relativePath);
    const root = path.resolve(this.uiRoot);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) return this.json(response, 400, { error: "invalid frontend path" });
    let realRoot: string;
    try { realRoot = await realpath(root); }
    catch { return this.json(response, 503, { error: "Control Center frontend is unavailable." }); }

    let filePath = requested;
    let contentType = contentTypeFor(path.extname(filePath));
    const requestedStatus = await safeStaticFile(requested, realRoot);
    if (requestedStatus === "invalid") return this.json(response, 400, { error: "invalid frontend path" });
    if (requestedStatus === "missing") {
      const isDocumentNavigation = pathname === "/" || (!path.extname(pathname) && (accept ?? "").includes("text/html"));
      if (!isDocumentNavigation) return this.json(response, 404, { error: "frontend asset not found" });
      filePath = path.join(root, "index.html");
      contentType = "text/html; charset=utf-8";
      if (await safeStaticFile(filePath, realRoot) !== "ok") return this.json(response, 503, { error: "Control Center frontend is unavailable." });
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": contentType.startsWith("text/html") ? "no-cache" : "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:"
      });
      response.end(body);
    } catch {
      this.json(response, 503, { error: "Control Center frontend is unavailable." });
    }
  }
}

export async function createProjectHome(options: LocalControlCenterOptionsV1 & { registry: ProjectRegistryV1; projectId?: string; autoOpen?: boolean }): Promise<LocalControlCenterV1> {
  const { registry, projectId, autoOpen = true, ...serverOptions } = options;
  const projects = await registry.list();
  if (projectId && !projects.some((project) => project.projectId === projectId)) throw new Error(`project not found: ${projectId}`);
  const selectedProjectId = projectId ?? (autoOpen && projects.length === 1 ? projects[0]?.projectId : undefined);
  return new LocalControlCenterV1({
    ...serverOptions,
    projectHome: { registry, selectedProjectId, autoOpen: Boolean(selectedProjectId) && autoOpen }
  });
}

function stripResourcePrefix(value: string, kind: "project" | "operation"): string {
  const prefix = `${kind}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function findBundledControlCenterUiRoot(): string | undefined {
  const configured = process.env.AEH_CONTROL_CENTER_UI_DIR;
  if (configured) return configured;
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "ui", "control-center", "dist");
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
    try {
      const dist = path.join(current, "dist");
      const releaseId = requireReleaseId(path.join(dist, "current"));
      if (releaseId) {
        const releaseUi = path.join(dist, "releases", releaseId, "ui", "control-center", "dist");
        if (existsSync(path.join(releaseUi, "index.html"))) return releaseUi;
      }
    } catch {
      // Source-tree development resolves the most recent complete release below.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function requireReleaseId(pointerPath: string): string | undefined {
  if (!existsSync(pointerPath)) return undefined;
  const releaseId = readFileSync(pointerPath, "utf8").trim();
  return /^[A-Za-z0-9._-]+$/.test(releaseId) ? releaseId : undefined;
}

function contentTypeFor(extension: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  } as Record<string, string>)[extension.toLowerCase()] ?? "application/octet-stream";
}

const OPERATION_EVENT_TYPES = new Set<ControlCenterEventTypeV1>([
  "operation.created", "operation.updated", "operation.metadata", "operation.terminal", "operation.stage",
  "operation.candidate.bound", "operation.lead.bound", "operation.participant.registered", "operation.participant.updated",
  "operation.participant.receipt", "operation.supervisor.registered", "operation.supervisor.updated"
]);

function isOperationEvent(value: unknown): value is OperationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<OperationEvent>;
  return event.version === 1
    && typeof event.operationId === "string"
    && Number.isSafeInteger(event.revision) && (event.revision ?? 0) > 0
    && typeof event.at === "string" && Number.isFinite(Date.parse(event.at))
    && typeof event.type === "string" && OPERATION_EVENT_TYPES.has(event.type as ControlCenterEventTypeV1)
    && (event.status === "QUEUED" || event.status === "RUNNING" || event.status === "SUCCEEDED" || event.status === "FAILED" || event.status === "CANCELLED")
    && typeof event.phase === "string"
    && (event.changed === undefined || (Array.isArray(event.changed) && event.changed.every((item) => typeof item === "string")))
    && (event.details === undefined || (typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)));
}

function compareDurableEvents(left: DurableControlCenterEventV1, right: DurableControlCenterEventV1): number {
  return left.event.at.localeCompare(right.event.at)
    || left.event.data.operationId.localeCompare(right.event.data.operationId)
    || left.cursorKey.localeCompare(right.cursorKey)
    || left.sequence - right.sequence;
}

function encodeEventCursor(cursor: EventCursorV1): string {
  const ordered = Object.fromEntries(Object.entries(cursor).sort(([left], [right]) => left.localeCompare(right)));
  return Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
}

function decodeEventCursor(value: string | string[] | undefined): EventCursorV1 {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Last-Event-ID is not a valid durable event cursor.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Last-Event-ID is not a valid durable event cursor."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Last-Event-ID is not a valid durable event cursor.");
  const cursor: EventCursorV1 = {};
  for (const [key, sequence] of Object.entries(parsed)) {
    if (!/^[a-f0-9]{24}$/.test(key) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new Error("Last-Event-ID is not a valid durable event cursor.");
    cursor[key] = sequence as number;
  }
  return cursor;
}

async function safeStaticFile(filePath: string, realRoot: string): Promise<"ok" | "missing" | "invalid"> {
  let fileStat: import("node:fs").Stats;
  try { fileStat = await lstat(filePath); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid"; }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return "invalid";
  try {
    const actual = await realpath(filePath);
    return actual === realRoot || actual.startsWith(`${realRoot}${path.sep}`) ? "ok" : "invalid";
  } catch { return "invalid"; }
}

function isLoopbackHealthHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}
