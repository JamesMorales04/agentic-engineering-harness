import type {
  ControlCenterCandidateProjectionV1,
  ControlCenterCertificationProjectionV1,
  ControlCenterContextProjectionV1,
  ControlCenterDecisionRequestV1,
  ControlCenterKnowledgeProjectionV1,
  ControlCenterOperationDetailProjectionV1,
  ControlCenterOperationProjectionV1,
  ControlCenterOverviewV1,
  ControlCenterPairedSessionV1,
  ControlCenterParticipantProjectionV1,
  ControlCenterProjectProjectionV1,
  ControlCenterServicesProjectionV1,
} from "../../../src/control-center/contracts.js";

export type KnowledgeStatus = ControlCenterKnowledgeProjectionV1["status"];
export type Project = ControlCenterProjectProjectionV1;
export type Participant = ControlCenterParticipantProjectionV1;
export type Candidate = ControlCenterCandidateProjectionV1;
export type Context = ControlCenterContextProjectionV1;
export type Knowledge = ControlCenterKnowledgeProjectionV1;
export type Services = ControlCenterServicesProjectionV1;

export type DecisionRequest = ControlCenterDecisionRequestV1;

export interface DecisionSubmissionInputV1 {
  operationId: string;
  requestId: string;
  choiceId: string;
  reason?: string;
}

export interface DecisionSubmissionResultV1 {
  version: 1;
  accepted: boolean;
  operationId: string;
  requestId: string;
  choiceId: string;
}

export type Operation = ControlCenterOperationProjectionV1;
export type OperationDetail = ControlCenterOperationDetailProjectionV1;
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

function asStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`Invalid Control Center response for ${path}: expected an array of strings.`);
  return value as string[];
}

function asRecords(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Control Center response for ${path}: expected an array.`);
  return value.map((entry, index) => asRecord(entry, `${path}[${index}]`));
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in record));
  if (extras.length || missing.length) throw new Error(`Invalid Control Center response for ${path}: unsupported or missing fields (extra: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`);
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`Invalid Control Center response for ${path}: expected non-empty text up to ${maxLength} characters.`);
  return value;
}

function parseDecisionRequest(value: unknown, path: string, operationId: string, candidateDigest?: string): DecisionRequest | undefined {
  if (value === undefined || value === null) return undefined;
  const request = asRecord(value, `${path}.decisionRequest`);
  const fields = ["version", "requestId", "operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch", "issue", "authoritativeEvidence", "whatTried", "whyUnresolvable", "choices", "workThatCanContinue", "resumeTarget", "createdAt", "expiresAt"] as const;
  assertKeys(request, fields, fields, `${path}.decisionRequest`);
  if (request.version !== 1) throw new Error(`Invalid Control Center response for ${path}: unsupported decisionRequest contract version.`);
  const requestId = boundedString(request.requestId, `${path}.decisionRequest.requestId`, 200);
  if (!requestId.startsWith("request:")) throw new Error(`Invalid Control Center response for ${path}: decisionRequest.requestId is malformed.`);
  if (request.operationId !== operationId) throw new Error(`Invalid Control Center response for ${path}: decisionRequest belongs to another operation.`);
  const candidate = boundedString(request.candidate, `${path}.decisionRequest.candidate`, 128);
  if (!/^[a-f0-9]{64}$/.test(candidate) || (candidateDigest !== undefined && candidateDigest !== candidate)) throw new Error(`Invalid Control Center response for ${path}: decisionRequest candidate does not match the operation.`);
  if (!Number.isSafeInteger(request.operationExecutionRevision) || (request.operationExecutionRevision as number) < 1) throw new Error(`Invalid Control Center response for ${path}: operationExecutionRevision must be a positive safe integer.`);
  if (typeof request.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.policyDigest)) throw new Error(`Invalid Control Center response for ${path}: policyDigest must be a lowercase SHA-256 digest.`);
  if (!Number.isSafeInteger(request.controllerEpoch) || (request.controllerEpoch as number) < 0) throw new Error(`Invalid Control Center response for ${path}: controllerEpoch must be a non-negative safe integer.`);
  if (request.resumeTarget !== "SPEC_AUTHORING") throw new Error(`Invalid Control Center response for ${path}: unsupported decisionRequest resume target.`);
  const issue = boundedString(request.issue, `${path}.decisionRequest.issue`, 4_000);
  const whyUnresolvable = boundedString(request.whyUnresolvable, `${path}.decisionRequest.whyUnresolvable`, 4_000);
  const createdAt = boundedString(request.createdAt, `${path}.decisionRequest.createdAt`, 100);
  const expiresAt = boundedString(request.expiresAt, `${path}.decisionRequest.expiresAt`, 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error(`Invalid Control Center response for ${path}: decisionRequest expiry is malformed.`);
  const authoritativeEvidence = asRecords(request.authoritativeEvidence, `${path}.decisionRequest.authoritativeEvidence`).map((evidence, index) => {
    const evidencePath = `${path}.decisionRequest.authoritativeEvidence[${index}]`;
    assertKeys(evidence, ["artifact", "sha256", "description"], ["artifact", "sha256", "description"], evidencePath);
    if (typeof evidence.artifact !== "string" || typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256) || typeof evidence.description !== "string") {
      throw new Error(`Invalid Control Center response for ${evidencePath}: evidence must carry artifact, a SHA-256 digest and description.`);
    }
    return { artifact: evidence.artifact, sha256: evidence.sha256, description: evidence.description };
  });
  if (authoritativeEvidence.length < 1 || authoritativeEvidence.length > 32 || authoritativeEvidence.some((item) => !item.artifact.startsWith(".harness/"))) throw new Error(`Invalid Control Center response for ${path}: authoritative evidence references are malformed.`);
  const choices = asRecords(request.choices, `${path}.decisionRequest.choices`).map((choice, index) => {
    const choicePath = `${path}.decisionRequest.choices[${index}]`;
    assertKeys(choice, ["choiceId", "label", "description", "consequences"], ["choiceId", "label", "description", "consequences"], choicePath);
    return { choiceId: boundedString(choice.choiceId, `${choicePath}.choiceId`, 120), label: boundedString(choice.label, `${choicePath}.label`, 200), description: boundedString(choice.description, `${choicePath}.description`, 2_000), consequences: asStrings(choice.consequences, `${choicePath}.consequences`) };
  });
  if (choices.length < 1 || choices.length > 12 || new Set(choices.map((item) => item.choiceId)).size !== choices.length || choices.some((item) => item.consequences.length < 1 || item.consequences.length > 8)) throw new Error(`Invalid Control Center response for ${path}: decision choices are malformed.`);
  const whatTried = asStrings(request.whatTried, `${path}.decisionRequest.whatTried`);
  const workThatCanContinue = asStrings(request.workThatCanContinue, `${path}.decisionRequest.workThatCanContinue`);
  if (!whatTried.length || whatTried.length > 16 || workThatCanContinue.length > 32) throw new Error(`Invalid Control Center response for ${path}: decision lists are malformed.`);
  return {
    version: 1,
    requestId,
    operationId,
    candidate,
    operationExecutionRevision: request.operationExecutionRevision as number,
    policyDigest: request.policyDigest as string,
    controllerEpoch: request.controllerEpoch as number,
    issue,
    authoritativeEvidence,
    whatTried,
    whyUnresolvable,
    choices,
    workThatCanContinue,
    resumeTarget: "SPEC_AUTHORING",
    createdAt,
    expiresAt,
  };
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
  async overview(): Promise<Overview> {
    const body = await this.request<Overview>("/api/v1/overview", undefined, undefined, ["version", "generatedAt", "buildIdentity", "projects", "operations", "participants", "candidates", "context", "authority", "evidence", "services", "knowledge", "quality", "certification", "security", "pairing"]);
    return { ...body, operations: body.operations.map((operation) => ({ ...operation, decisionRequest: parseDecisionRequest(operation.decisionRequest, "/api/v1/overview", operation.operationId, operation.candidateDigest) })) };
  }
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
  submitDecision(csrfToken: string, input: DecisionSubmissionInputV1): Promise<DecisionSubmissionResultV1> {
    return this.request<DecisionSubmissionResultV1>("/api/v1/decisions", { method: "POST", body: JSON.stringify({ operationId: input.operationId, requestId: input.requestId, choiceId: input.choiceId, ...(input.reason ? { reason: input.reason } : {}) }) }, csrfToken, ["version", "accepted", "operationId", "requestId", "choiceId"]).then((result) => {
      if (result.accepted !== true) throw new Error("The Control Center did not accept the decision choice.");
      return result;
    });
  }
}
