import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { currentOperationContext, currentControllerEpoch, loadOperation, registerOperationAgent } from "../operations/state.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { isCanonicalRole, roleProfile } from "../participants/index.js";
import { createCapabilityLease, type CapabilityLeaseV1, type CapabilityNameV1, type PermissionRequestV1 } from "./authorityV2.js";
import { assertParticipantScratchLeaseV1, compileParticipantScratchLease, participantScratchResourceName, type ParticipantScratchLeaseV1 } from "../architecture/executionIdentity.js";
import { operationResourceRegistryFile, registerOperationResource } from "../runtime/operationResources.js";
import { sha256Canonical } from "../core/digest.js";

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
  scratchLease?: ParticipantScratchLeaseV1;
}

export interface ExecutionAuthorityOptions {
  participantId?: string;
  phase?: string;
  now?: Date;
  leaseSeconds?: number;
  required?: boolean;
}

/**
 * Materialize one private temp directory only for a role whose frozen ToolPack
 * includes repository writes and command execution. The path is registered as
 * an operation-owned staging resource before it is projected into a provider.
 */
export async function provisionParticipantScratch(
  root: string,
  selection: AgentExecutionSelection,
  authority: ExecutionAuthorityV1,
  participantGeneration: string,
  options: { now?: Date; leaseSeconds?: number } = {}
): Promise<{ authority: ExecutionAuthorityV1; scratchLease: ParticipantScratchLeaseV1 } | undefined> {
  assertExecutionAuthority(authority);
  if (selection.role === "Semantic Assessor") return undefined;
  const scratchResource = participantScratchResourceName(selection.role, authority.participantId);
  if (!scratchResource) return undefined;
  const profile = roleProfile(selection.role);
  if (!profile.authority.canWrite || !profile.toolPack.required.includes("repository-write") || !profile.toolPack.required.includes("command-execute") || selection.permissions.write !== "allow" || selection.permissions.shell !== "allow") {
    throw new Error("PARTICIPANT_SCRATCH_AUTHORITY_DENIED: the frozen role and effective write/execute permissions do not authorize private scratch.");
  }
  if (!participantGeneration?.trim()) throw new Error("PARTICIPANT_SCRATCH_IDENTITY_REQUIRED: participant generation is required before scratch creation.");

  const context = currentOperationContext();
  if (context.id !== authority.operationId) throw new Error("PARTICIPANT_SCRATCH_OPERATION_MISMATCH: scratch can be materialized only for the active authorized operation.");
  const stateRoot = context.controlRoot ?? root;
  const operation = await loadOperation(stateRoot, authority.operationId);
  const candidate = operation.candidateRevision;
  const controllerEpoch = currentControllerEpoch(operation);
  if (!candidate || candidate.identityDigest !== authority.candidateDigest || !candidateRevisionsEqual(candidate, authority.candidateRevision) || controllerEpoch !== authority.controllerEpoch || !operation.operationExecutionRevision) {
    throw new Error("PARTICIPANT_SCRATCH_IDENTITY_STALE: scratch request does not match the current operation, candidate, or controller epoch.");
  }

  const identityDigest = sha256Canonical({
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    participantId: authority.participantId,
    participantGeneration
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-scratch-${identityDigest.slice(0, 20)}-`));
  await fs.chmod(directory, 0o700);
  let resourceId: string;
  try {
    const resource = await registerOperationResource(stateRoot, operation.id, {
      kind: "staging-root",
      identity: directory,
      path: directory,
      label: `private participant scratch for ${authority.participantId}`,
      reclaim: "REMOVE_ON_TERMINAL",
      owner: {
        source: "controller-registration",
        candidateDigest: candidate.identityDigest,
        operationExecutionRevision: operation.operationExecutionRevision,
        controllerEpoch,
        participantId: authority.participantId,
        participantGeneration
      }
    });
    resourceId = resource.resourceId;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const scope = [directory, `${directory}/*`, `${directory}/**`];
  const now = options.now ?? new Date();
  const hardDeadlineMs = operation.resolvedOperationPolicy?.executionLiveness.hardDeadlineMs ?? 8 * 60 * 60_000;
  const createdAtMs = Date.parse(operation.createdAt);
  const inheritedDeadlineAt = operation.origin ? Date.parse(operation.origin.rootHardDeadlineAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(inheritedDeadlineAt) && inheritedDeadlineAt !== Number.POSITIVE_INFINITY) throw new Error("PARTICIPANT_SCRATCH_DEADLINE_INVALID: operation creation or inherited hard-deadline timestamp is invalid.");
  const hardDeadlineAt = Math.min(createdAtMs + hardDeadlineMs, inheritedDeadlineAt);
  const hardRemainingMs = hardDeadlineAt - now.getTime();
  if (hardRemainingMs <= 0) throw new Error("OPERATION_HARD_DEADLINE_REACHED: participant scratch authority cannot be issued beyond the frozen Owner deadline.");
  const hardRemainingSeconds = Math.max(1, Math.floor(hardRemainingMs / 1000));
  const leaseSeconds = Math.min(Math.max(1, options.leaseSeconds ?? hardRemainingSeconds), hardRemainingSeconds);
  const expiresAt = new Date(Math.min(now.getTime() + leaseSeconds * 1000, hardDeadlineAt)).toISOString();
  const scratchLeases = (["read", "write"] as const).map((capability) => {
    const request: PermissionRequestV1 = {
      version: 1,
      requestId: `request:${operation.id}:${authority.participantId}:${capability}:scratch:${identityDigest.slice(0, 20)}`,
      operationId: operation.id,
      participantId: authority.participantId,
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
      candidate,
      capability: { capability, paths: scope },
      requestedEnvelope: { version: 1, level: 50, capabilities: [capability], scope },
      requestedAt: now.toISOString(),
      expiresAt
    };
    return createCapabilityLease(request, { operationId: operation.id, projectId: candidate.projectId, candidate, now });
  });
  const scratchLease = compileParticipantScratchLease({
    resourceId,
    path: directory,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    participantId: authority.participantId,
    participantGeneration,
    capabilityLeases: scratchLeases
  });
  const nextAuthority: ExecutionAuthorityV1 = {
    ...authority,
    leases: [...authority.leases, ...scratchLeases],
    scratchLease
  };
  assertExecutionAuthority(nextAuthority);
  return { authority: nextAuthority, scratchLease };
}

/** Reattach only the same generation's durable scratch lease after a controller recovery. */
export async function attachParticipantScratchAuthority(
  root: string,
  authority: ExecutionAuthorityV1,
  scratchLease: ParticipantScratchLeaseV1
): Promise<ExecutionAuthorityV1> {
  assertExecutionAuthority(authority);
  assertParticipantScratchLeaseV1(scratchLease);
  const context = currentOperationContext();
  if (context.id !== authority.operationId || scratchLease.operationId !== authority.operationId || scratchLease.participantId !== authority.participantId || scratchLease.candidateDigest !== authority.candidateDigest || scratchLease.controllerEpoch !== authority.controllerEpoch) throw new Error("PARTICIPANT_SCRATCH_IDENTITY_MISMATCH: recovered scratch does not belong to the current participant authority.");
  const stateRoot = context.controlRoot ?? root;
  const operation = await loadOperation(stateRoot, authority.operationId);
  if (!operation.candidateRevision || operation.candidateRevision.identityDigest !== scratchLease.candidateDigest || operation.candidateRevision.revision !== scratchLease.candidateRevision || operation.operationExecutionRevision !== scratchLease.operationExecutionRevision || currentControllerEpoch(operation) !== scratchLease.controllerEpoch) throw new Error("PARTICIPANT_SCRATCH_IDENTITY_STALE: recovered scratch belongs to an earlier operation execution identity.");
  if (operation.participants[authority.participantId]?.executionBinding?.scratchLease?.digest !== scratchLease.digest) throw new Error("PARTICIPANT_SCRATCH_OWNERSHIP_REJECTED: durable operation state does not bind this scratch lease to the participant generation.");
  const registry = JSON.parse(await fs.readFile(operationResourceRegistryFile(stateRoot, authority.operationId), "utf8")) as { resources?: Array<Record<string, unknown>> };
  const resource = registry.resources?.find((entry) => entry.resourceId === scratchLease.resourceId);
  if (!resource || resource.kind !== "staging-root" || resource.identity !== scratchLease.path || resource.path !== scratchLease.path || resource.operationId !== authority.operationId || (resource.owner as Record<string, unknown> | undefined)?.participantId !== authority.participantId || (resource.owner as Record<string, unknown> | undefined)?.participantGeneration !== scratchLease.participantGeneration || resource.state !== "OWNED") throw new Error("PARTICIPANT_SCRATCH_OWNERSHIP_REJECTED: resource ledger does not prove exact participant ownership of the recovered directory.");
  const resolved = await fs.realpath(scratchLease.path);
  const rootPath = path.resolve(os.tmpdir());
  const relative = path.relative(rootPath, resolved);
  if (resolved !== path.resolve(scratchLease.path) || relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("aeh-scratch-")) throw new Error("PARTICIPANT_SCRATCH_PATH_REJECTED: recovered path is not the exact AEH-owned temp directory.");
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("PARTICIPANT_SCRATCH_PATH_REJECTED: recovered directory permissions or filesystem identity changed.");
  const next: ExecutionAuthorityV1 = {
    ...authority,
    leases: [...authority.leases, ...scratchLease.capabilityLeases],
    scratchLease
  };
  assertExecutionAuthority(next);
  return next;
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
  const hardDeadlineMs = current.resolvedOperationPolicy?.executionLiveness.hardDeadlineMs ?? 8 * 60 * 60_000;
  const createdAtMs = Date.parse(current.createdAt);
  const inheritedDeadlineAt = current.origin ? Date.parse(current.origin.rootHardDeadlineAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(inheritedDeadlineAt) && inheritedDeadlineAt !== Number.POSITIVE_INFINITY) throw new Error("EXECUTION_AUTHORITY_DEADLINE_INVALID: operation creation or inherited hard-deadline timestamp is invalid.");
  const hardDeadlineAt = Math.min(createdAtMs + hardDeadlineMs, inheritedDeadlineAt);
  const hardRemainingMs = hardDeadlineAt - now.getTime();
  if (hardRemainingMs <= 0) throw new Error("OPERATION_HARD_DEADLINE_REACHED: no participant authority may be issued beyond the frozen Owner deadline.");
  const hardRemainingSeconds = Math.max(1, Math.floor(hardRemainingMs / 1000));
  const leaseSeconds = Math.min(Math.max(1, options.leaseSeconds ?? hardRemainingSeconds), hardRemainingSeconds);
  const expiresAt = new Date(Math.min(now.getTime() + leaseSeconds * 1000, hardDeadlineAt)).toISOString();
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
  if (authority.scratchLease) {
    const scratch = authority.scratchLease;
    assertParticipantScratchLeaseV1(scratch);
    if (scratch.operationId !== authority.operationId || scratch.participantId !== authority.participantId || scratch.candidateDigest !== authority.candidateDigest || scratch.controllerEpoch !== authority.controllerEpoch) throw new Error("V2_AUTHORITY_INVALID: scratch lease is outside the operation, participant, candidate, or controller epoch.");
    const paths = [scratch.path, `${scratch.path}/*`, `${scratch.path}/**`].sort();
    for (const capability of ["read", "write"] as const) {
      const lease = authority.leases.find((candidateLease) => candidateLease.capability === capability && scratch.capabilityLeases.some((scratchCapabilityLease) => scratchCapabilityLease.leaseId === candidateLease.leaseId));
      if (!lease || lease.envelope.scope?.join("\0") !== paths.join("\0")) throw new Error(`V2_AUTHORITY_INVALID: scratch ${capability} lease is missing or not limited to the owned scratch path.`);
    }
  }
}

export function deterministicParticipantId(operationId: string, logicalAgent: string, phase = "work"): string {
  const digest = createHash("sha256").update(`${operationId}\0${logicalAgent}\0${phase}`).digest("hex").slice(0, 16);
  return `participant:${digest}`;
}
