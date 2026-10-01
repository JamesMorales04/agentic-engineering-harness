import { createHash } from "node:crypto";
import type { AgentExecutionSelection } from "../agents/types.js";
import { currentOperationContext, currentControllerEpoch, loadOperation, registerOperationAgent } from "../operations/state.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { isCanonicalRole, roleProfile } from "../participants/index.js";
import { createCapabilityLease, type CapabilityLeaseV1, type CapabilityNameV1, type PermissionRequestV1 } from "./authorityV2.js";

export interface ExecutionAuthorityV1 {
  version: 1;
  operationId: string;
  participantId: string;
  projectId?: string;
  candidateRevision: CandidateRevisionV1;
  candidateDigest: string;
  /** Durable monotonic controller epoch this authority was compiled under. */
  controllerEpoch: number;
  leases: CapabilityLeaseV1[];
}

export interface ExecutionAuthorityOptions {
  participantId?: string;
  phase?: string;
  now?: Date;
  leaseSeconds?: number;
  required?: boolean;
}

/** Compile short-lived launch authority from the current operation state. */
export async function prepareExecutionAuthority(
  root: string,
  selection: AgentExecutionSelection,
  options: ExecutionAuthorityOptions = {}
): Promise<ExecutionAuthorityV1 | undefined> {
  const selectedRole: unknown = selection.role;
  if (!isCanonicalRole(selectedRole)) {
    throw new Error(`V2_AUTHORITY_DENIED: selected role '${String(selectedRole)}' has no registered canonical RoleProfile.`);
  }
  const profile = roleProfile(selectedRole);
  const capabilities = requestedCapabilities(selection);
  assertRoleCapabilityCeiling(profile, capabilities);
  if (selection.permissions.gitWrite === "allow") {
    // Git mutation permission is projected as command-specific shell access by
    // some runtimes, so it must fit the same profile ceiling as source writes
    // and command execution even though the legacy lease taxonomy has no
    // dedicated Git capability.
    assertRoleCapabilityCeiling(profile, ["write", "execute"]);
  }
  if (!capabilities.length) {
    throw new Error(`V2_AUTHORITY_DENIED: role '${profile.role}' has no granted execution capabilities.`);
  }
  const context = currentOperationContext();
  if (!context.id) {
    if (options.required) throw new Error("V2_AUTHORITY_REQUIRED: bounded worker execution requires a managed operation.");
    return undefined;
  }
  const stateRoot = context.controlRoot ?? root;
  const operation = await loadOperation(stateRoot, context.id);
  if (!operation.candidateRevision) {
    if (options.required) throw new Error(`V2_AUTHORITY_REQUIRED: operation '${context.id}' has no managed candidate revision.`);
    return undefined;
  }
  const candidate = operation.candidateRevision;
  const participantId = options.participantId?.trim() || deterministicParticipantId(context.id, selection.logicalAgent, options.phase);
  const priorAgent = operation.agents?.find((agent) => agent.id === participantId);
  const priorRole = operation.participants[participantId]?.role ?? priorAgent?.role;
  if ((operation.participants[participantId] || priorAgent) && priorRole !== selection.role) {
    throw new Error(`V2_AUTHORITY_DENIED: participant '${participantId}' is not registered for selected role '${selection.role}'.`);
  }
  if (!operation.participants[participantId] && !priorAgent) {
    await registerOperationAgent(stateRoot, context.id, { id: participantId, logicalAgent: selection.logicalAgent, role: selection.role, phase: options.phase, transport: selection.transport });
  }
  const current = await loadOperation(stateRoot, context.id);
  const participantRole = current.participants[participantId]?.role ?? current.agents?.find((agent) => agent.id === participantId)?.role;
  if (participantRole !== selection.role) {
    throw new Error(`V2_AUTHORITY_DENIED: participant '${participantId}' is not registered for selected role '${selection.role}'.`);
  }
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, options.leaseSeconds ?? 30 * 60) * 1000).toISOString();
  const envelope = { version: 1 as const, level: 50, capabilities };
  const leases = capabilities.map((capability) => {
    const request: PermissionRequestV1 = {
      version: 1,
      requestId: `request:${context.id}:${participantId}:${capability}:${options.phase ?? "work"}`,
      operationId: context.id!,
      participantId,
      ...(current.candidateRevision?.projectId ? { projectId: current.candidateRevision.projectId } : {}),
      candidate,
      capability,
      requestedEnvelope: envelope,
      requestedAt: now.toISOString(),
      expiresAt
    };
    return createCapabilityLease(request, { operationId: context.id!, projectId: candidate.projectId, candidate, now });
  });
  return { version: 1, operationId: context.id, participantId, projectId: candidate.projectId, candidateRevision: candidate, candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(current), leases };
}

export function requestedCapabilities(selection: AgentExecutionSelection): CapabilityNameV1[] {
  const capabilities: CapabilityNameV1[] = selection.permissions.read === "deny" ? [] : ["read"];
  if (selection.permissions.write === "allow") capabilities.push("write");
  if (selection.permissions.shell === "allow") capabilities.push("execute");
  if (selection.permissions.network === "allow") capabilities.push("network");
  if (selection.permissions.delegate === "allow") capabilities.push("delegate");
  return capabilities;
}

function assertRoleCapabilityCeiling(
  profile: ReturnType<typeof roleProfile>,
  capabilities: ReadonlyArray<CapabilityNameV1>
): void {
  const maximum = new Set(profile.maxCapabilities);
  const withinCeiling = (capability: CapabilityNameV1): boolean => {
    switch (capability) {
      case "read": return profile.authority.canRead && maximum.has("read");
      case "write": return profile.authority.canWrite && maximum.has("write");
      case "execute": return profile.authority.canExecute && maximum.has("execute");
      // The legacy network permission exposes read-only research tools. It is
      // bounded by the role's research capability until network actions get a
      // separate precise capability in the ToolActionGate.
      case "network": return maximum.has("research");
      case "delegate": return maximum.has("delegate") && profile.delegation.allowed;
      case "spawn": return maximum.has("delegate") && profile.delegation.allowed;
    }
  };
  const denied = capabilities.filter((capability) => !withinCeiling(capability));
  if (denied.length) {
    throw new Error(`V2_AUTHORITY_DENIED: role '${profile.role}' cannot receive capabilities outside its compiled RoleProfile ceiling: ${denied.join(", ")}.`);
  }
}

export function assertExecutionAuthority(value: unknown, now = new Date()): asserts value is ExecutionAuthorityV1 {
  if (!value || typeof value !== "object") throw new Error("V2_AUTHORITY_REQUIRED: execution authority is missing.");
  const authority = value as Partial<ExecutionAuthorityV1>;
  if (authority.version !== 1 || !authority.operationId || !authority.participantId || !authority.candidateDigest || !authority.candidateDigest.match(/^[a-f0-9]{64}$/) || !Array.isArray(authority.leases) || authority.leases.length === 0) {
    throw new Error("V2_AUTHORITY_INVALID: execution authority is malformed.");
  }
  if (!Number.isSafeInteger(authority.controllerEpoch) || (authority.controllerEpoch ?? -1) < 0) throw new Error("V2_AUTHORITY_INVALID: execution authority has no controller epoch.");
  const candidate = authority.leases[0]?.candidate as CandidateRevisionV1 | undefined;
  if (!candidate) throw new Error("V2_AUTHORITY_INVALID: execution authority has no candidate-bound lease.");
  if (candidate.identityDigest !== authority.candidateDigest) throw new Error("V2_AUTHORITY_INVALID: authority candidate digest does not match its candidate.");
  for (const lease of authority.leases) {
    if (lease.version !== 1 || lease.operationId !== authority.operationId || lease.participantId !== authority.participantId || !candidateRevisionsEqual(lease.candidate, candidate)) {
      throw new Error("V2_AUTHORITY_INVALID: capability lease is not bound to the execution authority.");
    }
    if (new Date(lease.expiresAt).getTime() <= now.getTime()) throw new Error("V2_AUTHORITY_EXPIRED: capability lease has expired.");
  }
}

export function deterministicParticipantId(operationId: string, logicalAgent: string, phase = "work"): string {
  const digest = createHash("sha256").update(`${operationId}\0${logicalAgent}\0${phase}`).digest("hex").slice(0, 16);
  return `participant:${digest}`;
}
