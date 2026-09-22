import type {
  ControlCenterCandidateProjectionV1,
  ControlCenterCertificationProjectionV1,
  ControlCenterContextProjectionV1,
  ControlCenterKnowledgeProjectionV1,
  ControlCenterOperationDetailProjectionV1,
  ControlCenterOperationProjectionV1,
  ControlCenterOverviewV1,
  ControlCenterPairedSessionV1,
  ControlCenterParticipantProjectionV1,
  ControlCenterProjectProjectionV1,
  ControlCenterServicesProjectionV1,
} from "../../../src/control-center/contracts.js";

export type Status = ControlCenterOperationProjectionV1["status"];
export type KnowledgeStatus = ControlCenterKnowledgeProjectionV1["status"];
export type Project = ControlCenterProjectProjectionV1;
export type Operation = ControlCenterOperationProjectionV1;
export type OperationDetail = ControlCenterOperationDetailProjectionV1;
export type Participant = ControlCenterParticipantProjectionV1;
export type Candidate = ControlCenterCandidateProjectionV1;
export type Context = ControlCenterContextProjectionV1;
export type Knowledge = ControlCenterKnowledgeProjectionV1;
export type Services = ControlCenterServicesProjectionV1;
export type Overview = ControlCenterOverviewV1;

export class ControlCenterApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ControlCenterApiError";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Control Center response for ${path}: expected an object.`);
  return value as Record<string, unknown>;
}

function parseResponse<T>(path: string, value: unknown, required: string[]): T {
  const body = asRecord(value, path);
  if (("version" in body && body.version !== 1) || (required.includes("version") && body.version !== 1)) throw new Error(`Invalid Control Center response for ${path}: unsupported contract version.`);
  for (const key of required) if (!(key in body)) throw new Error(`Invalid Control Center response for ${path}: missing ${key}.`);
  if ("items" in body && !Array.isArray(body.items)) throw new Error(`Invalid Control Center response for ${path}: items must be an array.`);
  if ("generatedAt" in body && typeof body.generatedAt !== "string") throw new Error(`Invalid Control Center response for ${path}: generatedAt must be a string.`);
  if ("buildIdentity" in body) {
    const identity = asRecord(body.buildIdentity, `${path}.buildIdentity`);
    if (identity.version !== 1 || typeof identity.packageVersion !== "string" || typeof identity.gitSha !== "string" || typeof identity.releaseId !== "string" || typeof identity.buildDigest !== "string" || !/^[a-f0-9]{64}$/.test(identity.buildDigest) || typeof identity.dirty !== "boolean") {
      throw new Error(`Invalid Control Center response for ${path}: buildIdentity is malformed.`);
    }
  }
  return body as T;
}

export class ControlCenterApi {
  constructor(private readonly baseUrl = "") {}

  private async request<T>(path: string, init?: RequestInit, csrfToken?: string, required: string[] = ["version"]): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(csrfToken && init?.method === "POST" ? { "X-AEH-CSRF": csrfToken } : {}),
        ...init?.headers,
      }
    });
    const body: unknown = await response.json().catch(() => undefined);
    const error = body && typeof body === "object" && !Array.isArray(body) && "error" in body ? (body as { error?: unknown }).error : undefined;
    if (!response.ok) throw new ControlCenterApiError(response.status, typeof error === "string" ? error : response.statusText);
    return parseResponse<T>(path, body, required);
  }

  pair(nonce: string): Promise<ControlCenterPairedSessionV1> {
    return this.request("/api/v1/pair", { method: "POST", body: JSON.stringify({ nonce }) }, undefined, ["version", "csrfToken"]);
  }

  session(): Promise<ControlCenterPairedSessionV1> { return this.request("/api/v1/session", undefined, undefined, ["version", "csrfToken"]); }
  overview(): Promise<Overview> { return this.request("/api/v1/overview", undefined, undefined, ["version", "generatedAt", "buildIdentity", "projects", "operations", "participants", "candidates", "context", "authority", "evidence", "services", "knowledge", "quality", "certification", "security", "pairing"]); }
  projects(): Promise<{ version: 1; items: Project[] }> { return this.request("/api/v1/projects", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  operations(): Promise<{ version: 1; items: Operation[] }> { return this.request("/api/v1/operations", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  operation(id: string): Promise<{ version: 1; item: OperationDetail }> { return this.request(`/api/v1/operations/${encodeURIComponent(id)}`, undefined, undefined, ["version", "resource", "generatedAt", "item"]); }
  participants(): Promise<{ version: 1; items: Participant[] }> { return this.request("/api/v1/participants", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  candidates(): Promise<{ version: 1; items: Candidate[] }> { return this.request("/api/v1/candidates", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  context(): Promise<{ version: 1; item: Context }> { return this.request("/api/v1/context", undefined, undefined, ["version", "resource", "generatedAt", "item"]); }
  authority(): Promise<{ version: 1; item: Overview["authority"] }> { return this.request("/api/v1/authority", undefined, undefined, ["version", "resource", "generatedAt", "item"]); }
  evidence(): Promise<{ version: 1; items: Overview["evidence"] }> { return this.request("/api/v1/evidence", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  services(): Promise<{ version: 1; item: Services }> { return this.request("/api/v1/services", undefined, undefined, ["version", "resource", "generatedAt", "item"]); }
  knowledge(): Promise<{ version: 1; item: Knowledge }> { return this.request("/api/v1/knowledge", undefined, undefined, ["version", "resource", "generatedAt", "item"]); }
  events(): Promise<{ version: 1; items: Array<{ eventId: string; type: string; at: string; data: Record<string, unknown> }> }> { return this.request("/api/v1/events/history", undefined, undefined, ["version", "resource", "generatedAt", "items"]); }
  paseo(): Promise<{ version: 1; status: "AVAILABLE" | "DEGRADED"; capturedAt: string; message?: string; participants: Array<{ agentId?: string; status?: string }> }> { return this.request("/api/v1/paseo", undefined, undefined, ["version", "status", "capturedAt", "participants"]); }
  paseoTimeline(participantId: string): Promise<{ version: 1; participantId: string; entries: unknown[]; status?: string; source: "paseo-sdk" | "unavailable" }> { return this.request(`/api/v1/paseo/participants/${encodeURIComponent(participantId)}/timeline`, undefined, undefined, ["version", "participantId", "entries", "source"]); }
  leadMessage(csrfToken: string, prompt: string): Promise<{ version: 1; leadId: string; status?: string; lastMessage?: string; error?: string }> { return this.request("/api/v1/paseo/lead/messages", { method: "POST", body: JSON.stringify({ prompt }) }, csrfToken, ["version", "leadId"]); }
  selectProject(csrfToken: string, id: string): Promise<{ version: 1; selection: Overview["projectSelection"]; project: Project }> { return this.request(`/api/v1/projects/${encodeURIComponent(id)}/select`, { method: "POST", body: JSON.stringify({ autoOpen: true }) }, csrfToken, ["version", "selection", "project"]); }
  recordDecision(csrfToken: string, input: { decision: string; actorId: string; operationId?: string }): Promise<{ accepted?: boolean; reason?: string; decisionId?: string; operationId?: string; status?: Status; phase?: string }> { return this.request("/api/v1/decisions", { method: "POST", body: JSON.stringify(input) }, csrfToken, []); }
}
