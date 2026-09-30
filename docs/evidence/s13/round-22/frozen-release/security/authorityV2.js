import { assertCandidateRevisionV1, candidateRevisionsEqual, } from "../operations/v2Contracts.js";
const MAX_ROOT_AUTHORITY_LEVEL = 100;
const CAPABILITY_NAMES = new Set(["read", "write", "execute", "network", "spawn", "delegate"]);
function nowIso(value) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    if (Number.isNaN(date.getTime()))
        throw new Error("V2_AUTHORITY_INVALID: now must be a valid instant.");
    return date.toISOString();
}
function capabilityName(value) {
    const name = typeof value === "string" ? value : value && typeof value === "object" ? value.capability : undefined;
    return CAPABILITY_NAMES.has(name) ? name : undefined;
}
function capabilityScope(value) {
    if (typeof value === "string")
        return undefined;
    if ("paths" in value)
        return value.paths;
    if ("commands" in value)
        return value.commands;
    if ("hosts" in value)
        return value.hosts;
    if ("roles" in value)
        return value.roles;
    return undefined;
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function scopeWithin(child, parent) {
    if (!parent)
        return true;
    if (!child)
        return false;
    const allowed = new Set(parent);
    return child.every((item) => allowed.has(item));
}
function validEnvelope(value) {
    if (!value || typeof value !== "object")
        return false;
    const envelope = value;
    return envelope.version === 1 && Number.isSafeInteger(envelope.level) && envelope.level >= 0 && envelope.level <= MAX_ROOT_AUTHORITY_LEVEL && Array.isArray(envelope.capabilities) && envelope.capabilities.length > 0 && envelope.capabilities.every((item) => CAPABILITY_NAMES.has(item));
}
function envelopeWithin(child, parent, requestedCapability, requestedScope) {
    if (child.level > parent.level)
        return "AUTHORITY_ESCALATION";
    const parentCapabilities = new Set(parent.capabilities);
    if (!parentCapabilities.has(requestedCapability) || child.capabilities.some((capability) => !parentCapabilities.has(capability)))
        return "CAPABILITY_ESCALATION";
    if (!scopeWithin(requestedScope ?? child.scope, parent.scope))
        return "SCOPE_ESCALATION";
    return undefined;
}
function invalidRequest(value) {
    if (!value || typeof value !== "object")
        return true;
    const request = value;
    const capability = request.capability;
    const validCapability = typeof capability === "string"
        ? CAPABILITY_NAMES.has(capability)
        : Boolean(capability && typeof capability === "object" && capabilityName(capability) && ("paths" in capability ? Array.isArray(capability.paths) : "commands" in capability ? Array.isArray(capability.commands) : "hosts" in capability ? Array.isArray(capability.hosts) : "roles" in capability ? Array.isArray(capability.roles) : true));
    return request.version !== 1 || !request.requestId || !request.operationId || !request.participantId || !request.candidate || !validEnvelope(request.requestedEnvelope) || !validCapability || !request.requestedAt || !request.expiresAt;
}
export function assertAuthorityEnvelopeV1(value) {
    if (!validEnvelope(value))
        throw new Error("V2_AUTHORITY_INVALID: authority envelope is malformed.");
}
export function assertPermissionRequestV1(value) {
    if (invalidRequest(value))
        throw new Error("V2_AUTHORITY_INVALID: permission request is malformed.");
    assertCandidateRevisionV1(value.candidate);
}
export function isMonotonicEnvelope(child, parent, requestedCapability, requestedScope) {
    return envelopeWithin(child, parent, requestedCapability, requestedScope) === undefined;
}
export function evaluatePermissionRequest(request, context) {
    const failures = [];
    if (invalidRequest(request))
        return { allowed: false, reasons: [{ code: "INVALID_REQUEST", message: "permission request is malformed." }] };
    const value = request;
    try {
        assertCandidateRevisionV1(value.candidate);
        assertCandidateRevisionV1(context.candidate);
    }
    catch {
        failures.push({ code: "CANDIDATE_MISMATCH", message: "request or context has an invalid candidate binding." });
    }
    if (value.operationId !== context.operationId)
        failures.push({ code: "OPERATION_MISMATCH", message: "permission request belongs to a different operation." });
    if (context.projectId && value.projectId && value.projectId !== context.projectId)
        failures.push({ code: "PROJECT_MISMATCH", message: "permission request belongs to a different project." });
    if (value.candidate.projectId && context.projectId && value.candidate.projectId !== context.projectId)
        failures.push({ code: "PROJECT_MISMATCH", message: "candidate project identity does not match the authority context." });
    if (!candidateRevisionsEqual(value.candidate, context.candidate))
        failures.push({ code: "CANDIDATE_MISMATCH", message: "permission request is bound to a stale or different candidate." });
    const now = nowIso(context.now);
    const expiresAt = new Date(value.expiresAt);
    const requestedAt = new Date(value.requestedAt);
    if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(requestedAt.getTime()) || expiresAt.getTime() <= new Date(now).getTime() || expiresAt.getTime() <= requestedAt.getTime())
        failures.push({ code: "EXPIRED", message: "permission request is expired or has an invalid interval." });
    const name = capabilityName(value.capability);
    const scope = capabilityScope(value.capability);
    if (!name || !value.requestedEnvelope.capabilities.includes(name))
        failures.push({ code: "CAPABILITY_ESCALATION", message: "requested capability is not represented by the requested envelope." });
    const parent = context.parentLease;
    if (value.parentLeaseId && (!parent || parent.leaseId !== value.parentLeaseId))
        failures.push({ code: "PARENT_LEASE_MISMATCH", message: "parent lease identity does not match the authority context." });
    if (parent) {
        if (parent.operationId !== context.operationId || !candidateRevisionsEqual(parent.candidate, context.candidate))
            failures.push({ code: "PARENT_LEASE_MISMATCH", message: "parent lease belongs to a different operation or candidate." });
        if (new Date(parent.expiresAt).getTime() <= new Date(now).getTime())
            failures.push({ code: "EXPIRED", message: "parent capability lease has expired." });
        if (name && envelopeWithin(value.requestedEnvelope, parent.envelope, name, scope)) {
            const code = envelopeWithin(value.requestedEnvelope, parent.envelope, name, scope);
            failures.push({ code, message: `requested authority is not monotonic within the parent lease (${code}).` });
        }
        if (new Date(value.expiresAt).getTime() > new Date(parent.expiresAt).getTime())
            failures.push({ code: "EXPIRED", message: "child lease cannot outlive its parent lease." });
    }
    else if (value.parentLeaseId) {
        failures.push({ code: "PARENT_LEASE_REQUIRED", message: "a referenced parent lease must be supplied." });
    }
    else if (value.requestedEnvelope.level > MAX_ROOT_AUTHORITY_LEVEL) {
        failures.push({ code: "AUTHORITY_ESCALATION", message: "root authority exceeds the configured envelope ceiling." });
    }
    if (failures.length > 0)
        return { allowed: false, reasons: failures };
    return { allowed: true, reasons: [] };
}
export const evaluatePermissionRequestV1 = evaluatePermissionRequest;
export function issueCapabilityLease(request, context) {
    const decision = evaluatePermissionRequest(request, context);
    if (!decision.allowed)
        return decision;
    const name = capabilityName(request.capability);
    const scope = capabilityScope(request.capability);
    const envelope = {
        ...request.requestedEnvelope,
        capabilities: uniqueSorted(request.requestedEnvelope.capabilities),
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
export function createCapabilityLease(request, context) {
    const decision = issueCapabilityLease(request, context);
    if (!decision.allowed || !decision.lease)
        throw new Error(`V2_AUTHORITY_DENIED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
    return decision.lease;
}
//# sourceMappingURL=authorityV2.js.map