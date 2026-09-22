import {
  assertCandidateRevisionV1,
  candidateRevisionsEqual,
  type CandidateRevisionV1,
} from "../operations/v2Contracts.js";

export type CapabilityNameV1 = "read" | "write" | "execute" | "network" | "spawn" | "delegate";

export type ReadCapabilityV1 = { capability: "read"; paths: ReadonlyArray<string> };
export type WriteCapabilityV1 = { capability: "write"; paths: ReadonlyArray<string> };
export type ExecuteCapabilityV1 = { capability: "execute"; commands: ReadonlyArray<string> };
export type NetworkCapabilityV1 = { capability: "network"; hosts: ReadonlyArray<string> };
export type SpawnCapabilityV1 = { capability: "spawn"; roles: ReadonlyArray<string>; maxChildren: number };
export type DelegateCapabilityV1 = { capability: "delegate"; roles: ReadonlyArray<string> };
export type CapabilityV1 = ReadCapabilityV1 | WriteCapabilityV1 | ExecuteCapabilityV1 | NetworkCapabilityV1 | SpawnCapabilityV1 | DelegateCapabilityV1;

export type AuthorityEnvelopeV1 = {
  version: 1;
  level: number;
  capabilities: ReadonlyArray<CapabilityNameV1>;
  scope?: ReadonlyArray<string>;
};

export type PermissionRequestV1 = {
  version: 1;
  requestId: string;
  operationId: string;
  participantId: string;
  projectId?: string;
  candidate: CandidateRevisionV1;
  capability: CapabilityNameV1 | CapabilityV1;
  requestedEnvelope: AuthorityEnvelopeV1;
  requestedAt: string;
  expiresAt: string;
  parentLeaseId?: string;
};

export type CapabilityLeaseV1 = {
  version: 1;
  leaseId: string;
  requestId: string;
  operationId: string;
  participantId: string;
  projectId?: string;
  candidate: CandidateRevisionV1;
  capability: CapabilityNameV1;
  envelope: AuthorityEnvelopeV1;
  issuedAt: string;
  expiresAt: string;
  parentLeaseId?: string;
};

export type AuthorityDecisionCodeV1 =
  | "INVALID_REQUEST"
  | "EXPIRED"
  | "OPERATION_MISMATCH"
  | "CANDIDATE_MISMATCH"
  | "PROJECT_MISMATCH"
  | "PARENT_LEASE_REQUIRED"
  | "PARENT_LEASE_MISMATCH"
  | "AUTHORITY_ESCALATION"
  | "CAPABILITY_ESCALATION"
  | "SCOPE_ESCALATION";

export type AuthorityDecisionV1 = {
  allowed: boolean;
  reasons: ReadonlyArray<{ code: AuthorityDecisionCodeV1; message: string }>;
  lease?: CapabilityLeaseV1;
};

export type AuthorityEvaluationContextV1 = {
  operationId: string;
  projectId?: string;
  candidate: CandidateRevisionV1;
  now?: string | Date;
  parentLease?: CapabilityLeaseV1;
};

const MAX_ROOT_AUTHORITY_LEVEL = 100;
const CAPABILITY_NAMES: ReadonlySet<CapabilityNameV1> = new Set(["read", "write", "execute", "network", "spawn", "delegate"]);

function nowIso(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("V2_AUTHORITY_INVALID: now must be a valid instant.");
  return date.toISOString();
}

function capabilityName(value: PermissionRequestV1["capability"]): CapabilityNameV1 | undefined {
  const name = typeof value === "string" ? value : value && typeof value === "object" ? value.capability : undefined;
  return CAPABILITY_NAMES.has(name as CapabilityNameV1) ? name as CapabilityNameV1 : undefined;
}

function capabilityScope(value: PermissionRequestV1["capability"]): ReadonlyArray<string> | undefined {
  if (typeof value === "string") return undefined;
  if ("paths" in value) return value.paths;
  if ("commands" in value) return value.commands;
  if ("hosts" in value) return value.hosts;
  if ("roles" in value) return value.roles;
  return undefined;
}

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function scopeWithin(child: ReadonlyArray<string> | undefined, parent: ReadonlyArray<string> | undefined): boolean {
  if (!parent) return true;
  if (!child) return false;
  const allowed = new Set(parent);
  return child.every((item) => allowed.has(item));
}

function validEnvelope(value: unknown): value is AuthorityEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const envelope = value as AuthorityEnvelopeV1;
  return envelope.version === 1 && Number.isSafeInteger(envelope.level) && envelope.level >= 0 && envelope.level <= MAX_ROOT_AUTHORITY_LEVEL && Array.isArray(envelope.capabilities) && envelope.capabilities.length > 0 && envelope.capabilities.every((item) => CAPABILITY_NAMES.has(item));
}

function envelopeWithin(child: AuthorityEnvelopeV1, parent: AuthorityEnvelopeV1, requestedCapability: CapabilityNameV1, requestedScope: ReadonlyArray<string> | undefined): AuthorityDecisionCodeV1 | undefined {
  if (child.level > parent.level) return "AUTHORITY_ESCALATION";
  const parentCapabilities = new Set(parent.capabilities);
  if (!parentCapabilities.has(requestedCapability) || child.capabilities.some((capability) => !parentCapabilities.has(capability))) return "CAPABILITY_ESCALATION";
  if (!scopeWithin(requestedScope ?? child.scope, parent.scope)) return "SCOPE_ESCALATION";
  return undefined;
}

function invalidRequest(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const request = value as PermissionRequestV1;
  const capability = request.capability;
  const validCapability = typeof capability === "string"
    ? CAPABILITY_NAMES.has(capability)
    : Boolean(capability && typeof capability === "object" && capabilityName(capability) && ("paths" in capability ? Array.isArray(capability.paths) : "commands" in capability ? Array.isArray(capability.commands) : "hosts" in capability ? Array.isArray(capability.hosts) : "roles" in capability ? Array.isArray(capability.roles) : true));
  return request.version !== 1 || !request.requestId || !request.operationId || !request.participantId || !request.candidate || !validEnvelope(request.requestedEnvelope) || !validCapability || !request.requestedAt || !request.expiresAt;
}

export function assertAuthorityEnvelopeV1(value: unknown): asserts value is AuthorityEnvelopeV1 {
  if (!validEnvelope(value)) throw new Error("V2_AUTHORITY_INVALID: authority envelope is malformed.");
}

export function assertPermissionRequestV1(value: unknown): asserts value is PermissionRequestV1 {
  if (invalidRequest(value)) throw new Error("V2_AUTHORITY_INVALID: permission request is malformed.");
  assertCandidateRevisionV1((value as PermissionRequestV1).candidate);
}

export function isMonotonicEnvelope(child: AuthorityEnvelopeV1, parent: AuthorityEnvelopeV1, requestedCapability: CapabilityNameV1, requestedScope?: ReadonlyArray<string>): boolean {
  return envelopeWithin(child, parent, requestedCapability, requestedScope) === undefined;
}

export function evaluatePermissionRequest(request: unknown, context: AuthorityEvaluationContextV1): AuthorityDecisionV1 {
  const failures: Array<{ code: AuthorityDecisionCodeV1; message: string }> = [];
  if (invalidRequest(request)) return { allowed: false, reasons: [{ code: "INVALID_REQUEST", message: "permission request is malformed." }] };
  const value = request as PermissionRequestV1;
  try {
    assertCandidateRevisionV1(value.candidate);
    assertCandidateRevisionV1(context.candidate);
  } catch {
    failures.push({ code: "CANDIDATE_MISMATCH", message: "request or context has an invalid candidate binding." });
  }
  if (value.operationId !== context.operationId) failures.push({ code: "OPERATION_MISMATCH", message: "permission request belongs to a different operation." });
  if (context.projectId && value.projectId && value.projectId !== context.projectId) failures.push({ code: "PROJECT_MISMATCH", message: "permission request belongs to a different project." });
  if (value.candidate.projectId && context.projectId && value.candidate.projectId !== context.projectId) failures.push({ code: "PROJECT_MISMATCH", message: "candidate project identity does not match the authority context." });
  if (!candidateRevisionsEqual(value.candidate, context.candidate)) failures.push({ code: "CANDIDATE_MISMATCH", message: "permission request is bound to a stale or different candidate." });

  const now = nowIso(context.now);
  const expiresAt = new Date(value.expiresAt);
  const requestedAt = new Date(value.requestedAt);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(requestedAt.getTime()) || expiresAt.getTime() <= new Date(now).getTime() || expiresAt.getTime() <= requestedAt.getTime()) failures.push({ code: "EXPIRED", message: "permission request is expired or has an invalid interval." });

  const name = capabilityName(value.capability);
  const scope = capabilityScope(value.capability);
  if (!name || !value.requestedEnvelope.capabilities.includes(name)) failures.push({ code: "CAPABILITY_ESCALATION", message: "requested capability is not represented by the requested envelope." });
  const parent = context.parentLease;
  if (value.parentLeaseId && (!parent || parent.leaseId !== value.parentLeaseId)) failures.push({ code: "PARENT_LEASE_MISMATCH", message: "parent lease identity does not match the authority context." });
  if (parent) {
    if (parent.operationId !== context.operationId || !candidateRevisionsEqual(parent.candidate, context.candidate)) failures.push({ code: "PARENT_LEASE_MISMATCH", message: "parent lease belongs to a different operation or candidate." });
    if (new Date(parent.expiresAt).getTime() <= new Date(now).getTime()) failures.push({ code: "EXPIRED", message: "parent capability lease has expired." });
    if (name && envelopeWithin(value.requestedEnvelope, parent.envelope, name, scope)) {
      const code = envelopeWithin(value.requestedEnvelope, parent.envelope, name, scope)!;
      failures.push({ code, message: `requested authority is not monotonic within the parent lease (${code}).` });
    }
    if (new Date(value.expiresAt).getTime() > new Date(parent.expiresAt).getTime()) failures.push({ code: "EXPIRED", message: "child lease cannot outlive its parent lease." });
  } else if (value.parentLeaseId) {
    failures.push({ code: "PARENT_LEASE_REQUIRED", message: "a referenced parent lease must be supplied." });
  } else if (value.requestedEnvelope.level > MAX_ROOT_AUTHORITY_LEVEL) {
    failures.push({ code: "AUTHORITY_ESCALATION", message: "root authority exceeds the configured envelope ceiling." });
  }

  if (failures.length > 0) return { allowed: false, reasons: failures };
  return { allowed: true, reasons: [] };
}

export const evaluatePermissionRequestV1 = evaluatePermissionRequest;

export function issueCapabilityLease(request: PermissionRequestV1, context: AuthorityEvaluationContextV1): AuthorityDecisionV1 {
  const decision = evaluatePermissionRequest(request, context);
  if (!decision.allowed) return decision;
  const name = capabilityName(request.capability)!;
  const scope = capabilityScope(request.capability);
  const envelope: AuthorityEnvelopeV1 = {
    ...request.requestedEnvelope,
    capabilities: uniqueSorted(request.requestedEnvelope.capabilities) as CapabilityNameV1[],
    ...(scope ? { scope: uniqueSorted(scope) } : {}),
  };
  return {
    allowed: true,
    reasons: [],
    lease: {
      version: 1,
      leaseId: `lease:${request.operationId}:${request.requestId}`,
      requestId: request.requestId,
      operationId: request.operationId,
      participantId: request.participantId,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      candidate: request.candidate,
      capability: name,
      envelope,
      issuedAt: nowIso(context.now),
      expiresAt: new Date(request.expiresAt).toISOString(),
      ...(request.parentLeaseId ? { parentLeaseId: request.parentLeaseId } : {}),
    },
  };
}

export const issueCapabilityLeaseV1 = issueCapabilityLease;

export function createCapabilityLease(request: PermissionRequestV1, context: AuthorityEvaluationContextV1): CapabilityLeaseV1 {
  const decision = issueCapabilityLease(request, context);
  if (!decision.allowed || !decision.lease) throw new Error(`V2_AUTHORITY_DENIED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
  return decision.lease;
}
