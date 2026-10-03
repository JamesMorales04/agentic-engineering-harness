import readline from "node:readline";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../core/digest.js";
import { dispatchManagedPaseoAgent, inspectManagedPaseoAgent, stopManagedPaseoAgent } from "../paseo/runtime.js";
import { activeOperationSupervisor, loadOperation } from "./state.js";
import { decideParticipantRecoveryV1, recordParticipantExecutionActivityV1, supervisorRecoveryActionValuesV1 } from "./executionLiveness.js";
import { recordOperationWakeAccepted } from "./wakeBudget.js";
import { assertSameSessionResumeCompatibleV1 } from "./recoveryIdentity.js";
import { loadOperationCapabilityRegistryV1 } from "../capabilities/registry.js";
import { projectOperationalSkillsV1, type ProjectedOperationalSkillV1 } from "../capabilities/operationalSkills.js";
import { canonicalRoleValues, type CanonicalRole } from "../participants/index.js";
import { createManagedRuntime, runtimeProjectId } from "../runtime/managed.js";

export interface SupervisorMcpRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
export interface SupervisorMcpDeps {
  dispatch?: typeof dispatchManagedPaseoAgent;
  inspect?: typeof inspectManagedPaseoAgent;
  stop?: typeof stopManagedPaseoAgent;
  awaitProviderLeaseRelease?: (root: string, operationId: string, participantId: string, sessionId: string) => Promise<boolean>;
}

const tools = [{
  name: "aeh_supervisor_recovery_decide",
  description: "Record one evidence-bound recovery decision for a stalled participant. The controller validates current Supervisor authority, frozen binding, cited activity evidence, and delegated budgets. It can retrieve relevant skill guidance, resume the exact same compatible Paseo session, or perform the one bounded same-session participant retry. This tool cannot alter policy, acceptance, delivery, or authority.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["participantId", "executionBindingDigest", "action", "evidenceIds", "reason"],
    properties: {
      participantId: { type: "string", minLength: 1 },
      executionBindingDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      action: { enum: supervisorRecoveryActionValuesV1 },
      evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
      observedFailure: { type: "object", additionalProperties: false, required: ["capabilityId", "failureClass"], properties: { capabilityId: { type: "string", minLength: 1 }, failureClass: { type: "string", minLength: 1 } } },
      skillId: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1, maxLength: 2000 }
    }
  }
}];

export async function serveSupervisorMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: SupervisorMcpRequest;
    try { request = JSON.parse(line) as SupervisorMcpRequest; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handleSupervisorMcpRequest(request) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

export async function handleSupervisorMcpRequest(
  request: SupervisorMcpRequest,
  env: NodeJS.ProcessEnv = process.env,
  deps: SupervisorMcpDeps = {}
): Promise<Record<string, unknown>> {
  if (request.method === "initialize") return { protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aeh-operation-supervisor", version: "1" } };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw new Error(`Unsupported Supervisor MCP method: ${request.method ?? "<missing>"}.`);
  const params = request.params ?? {};
  if (params.name !== "aeh_supervisor_recovery_decide") throw new Error(`Unknown Supervisor recovery tool '${String(params.name ?? "")}'.`);
  const args = asRecord(params.arguments);
  const root = required(env.AEH_CONTROL_ROOT, "AEH_CONTROL_ROOT");
  const operationId = required(env.AEH_OPERATION_ID, "AEH_OPERATION_ID");
  if (env.AEH_OPERATION_SUPERVISOR !== "1") throw new Error("SUPERVISOR_RECOVERY_AUTHORITY_DENIED: this MCP server is scoped to an operation Supervisor session.");
  const boundSessionId = required(env.AEH_SUPERVISOR_SESSION_ID, "AEH_SUPERVISOR_SESSION_ID");
  const hostSessionId = env.PASEO_AGENT_ID?.trim();
  if (hostSessionId && hostSessionId !== boundSessionId) throw new Error("SUPERVISOR_RECOVERY_SESSION_MISMATCH: MCP host session differs from the controller-bound Supervisor session.");
  const operation = await loadOperation(root, operationId);
  const active = activeOperationSupervisor(operation);
  if (!active || active.agentId !== boundSessionId) throw new Error("SUPERVISOR_RECOVERY_AUTHORITY_STALE: the bound session is no longer the active Supervisor generation.");
  const action = required(args.action, "action");
  if (!supervisorRecoveryActionValuesV1.includes(action as (typeof supervisorRecoveryActionValuesV1)[number])) throw new Error("SUPERVISOR_RECOVERY_ACTION_INVALID: action is not in the bounded Supervisor decision contract.");
  const participantId = required(args.participantId, "participantId");
  if (Object.hasOwn(args, "recipientRole")) throw new Error("SUPERVISOR_SKILL_ROLE_OVERRIDE_FORBIDDEN: recovery skills are projected only for the participant's frozen role.");
  const participant = operation.participants[participantId];
  if (!participant) throw new Error("SUPERVISOR_RECOVERY_REJECTED: participant does not exist in the current operation.");
  if (action === "RESUME_SAME_SESSION" || action === "RETRY_PARTICIPANT") await assertSameSessionResumeCompatibleV1(root, operation, participantId);
  const skillProjection = await projectRecoverySkill(root, operationId, participant.role, args.observedFailure, optionalString(args.skillId));
  if (action === "RETRIEVE_SKILL" && !skillProjection.requested) throw new Error("SUPERVISOR_SKILL_FAILURE_EVIDENCE_REQUIRED: retrieve an operational skill only for a classified observed failure.");
  const result = await decideParticipantRecoveryV1(root, {
    operationId,
    participantId,
    actorRole: "SUPERVISOR",
    expectedBindingDigest: required(args.executionBindingDigest, "executionBindingDigest"),
    actorSessionId: boundSessionId,
    action: action as (typeof supervisorRecoveryActionValuesV1)[number],
    evidenceIds: stringList(args.evidenceIds),
    reason: required(args.reason, "reason"),
    ...(skillProjection.skill?.id ? { skillId: skillProjection.skill.id } : {}),
    ...(skillProjection.projectionDigest ? { skillProjectionDigest: skillProjection.projectionDigest } : {})
  });
  let leadWake: "NOT_REQUESTED" | "ACCEPTED" | "UNAVAILABLE" | "DEFERRED_TO_CONTROLLER" = "NOT_REQUESTED";
  const controllerBoundaryActions = ["ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN"] as const;
  if (result.application === "ESCALATE_TO_LEAD" && controllerBoundaryActions.includes(result.action as (typeof controllerBoundaryActions)[number])) {
    leadWake = "DEFERRED_TO_CONTROLLER";
  } else if (result.application === "ESCALATE_TO_LEAD") {
    const current = await loadOperation(root, operationId);
    const lead = current.lead?.agentId;
    if (lead) {
      const prompt = [
        "[AEH_SUPERVISOR_ESCALATION]",
        `Operation ${operationId} participant ${result.participantId} requires Lead authority.`,
        `Supervisor decision: ${result.action}; reason: ${result.reason}`,
        `Evidence ids: ${result.evidenceIds.join(", ")}`,
        "Resolve only decisions within Lead authority and the frozen Owner policy. Continue automatically where authority permits. Request the human Owner only for a concrete HumanDecisionRequirement that lower authorities cannot resolve."
      ].join("\n");
      const dispatched = await (deps.dispatch ?? dispatchManagedPaseoAgent)(root, lead, prompt, 60).catch(() => undefined);
      if (dispatched?.exitCode === 0) {
        await recordOperationWakeAccepted(root, operationId, current.revision, "lead", "stalled");
        leadWake = "ACCEPTED";
      } else leadWake = "UNAVAILABLE";
    } else leadWake = "UNAVAILABLE";
  }
  let participantTurn: "NOT_REQUESTED" | "ACCEPTED" | "UNAVAILABLE" = "NOT_REQUESTED";
  if (result.action === "RESUME_SAME_SESSION" || result.action === "RETRY_PARTICIPANT") participantTurn = await dispatchSameSessionResumeV1(root, operationId, participantId, result.executionBindingDigest, skillProjection.skills, deps, result.action, { role: "SUPERVISOR", sessionId: boundSessionId });
  return { content: [{ type: "text", text: `Supervisor recovery decision recorded: ${result.action} for ${result.participantId}.` }], structuredContent: { decision: result, leadWake, participantTurn, skillProjection: skillProjection.status, skills: skillProjection.skills, authority: "SUPERVISOR_WITHIN_FROZEN_POLICY" } };
}

async function projectRecoverySkill(root: string, operationId: string, participantRole: string | undefined, failureValue: unknown, requestedSkillId?: string): Promise<{ requested: boolean; status: "NOT_REQUESTED" | "PROJECTED" | "UNAVAILABLE" | "NO_MATCH"; projectionDigest?: string; skill?: ProjectedOperationalSkillV1; skills: ProjectedOperationalSkillV1[] }> {
  if (failureValue === undefined) return { requested: false, status: "NOT_REQUESTED", skills: [] };
  const failure = asRecord(failureValue);
  const capabilityId = required(failure.capabilityId, "observedFailure.capabilityId");
  const failureClass = required(failure.failureClass, "observedFailure.failureClass");
  const registry = await loadOperationCapabilityRegistryV1(root, operationId).catch(() => undefined);
  const operation = await loadOperation(root, operationId);
  if (!registry || registry.digest !== operation.resolvedOperationPolicy?.capabilityRegistryDigest) return { requested: true, status: "UNAVAILABLE", skills: [] };
  if (!participantRole || !canonicalRoleValues.includes(participantRole as CanonicalRole)) return { requested: true, status: "NO_MATCH", skills: [] };
  const role = participantRole as CanonicalRole;
  const projection = projectOperationalSkillsV1({ role, observedFailure: { capabilityId, failureClass }, capabilityRegistry: registry });
  const matches = projection.skills.filter((item) => !requestedSkillId || item.id === requestedSkillId);
  if (!matches.length) return { requested: true, status: "NO_MATCH", projectionDigest: projection.digest, skills: [] };
  return { requested: true, status: "PROJECTED", projectionDigest: projection.digest, ...(matches.length === 1 ? { skill: matches[0] } : {}), skills: matches };
}

export async function dispatchSameSessionResumeV1(root: string, operationId: string, participantId: string, expectedBindingDigest: string, skills: ProjectedOperationalSkillV1[] = [], deps: SupervisorMcpDeps = {}, action: "RESUME_SAME_SESSION" | "RETRY_PARTICIPANT" = "RESUME_SAME_SESSION", authority?: { role: "SUPERVISOR" | "LEAD"; sessionId: string }): Promise<"ACCEPTED" | "UNAVAILABLE"> {
  let operation = await loadOperation(root, operationId);
  assertRecoveryActor(operation, authority);
  const participant = operation.participants[participantId];
  const binding = participant?.executionBinding;
  if (!participant || !binding || binding.digest !== expectedBindingDigest || !participant.transport?.startsWith("paseo")) throw new Error("SAME_SESSION_RESUME_UNAVAILABLE: only the exact current bound Paseo participant session can be resumed through this Supervisor capability.");
  await assertSameSessionResumeCompatibleV1(root, operation, participantId);
  const inspect = deps.inspect ?? inspectManagedPaseoAgent;
  const observed = await inspect(root, binding.runtime.sessionId).catch(() => undefined);
  let status = observed?.status?.toLowerCase();
  if (status && ["running", "working", "streaming", "initializing"].includes(status)) {
    const stopped = await (deps.stop ?? stopManagedPaseoAgent)(root, binding.runtime.sessionId);
    if (stopped.exitCode !== 0) return "UNAVAILABLE";
    status = (await inspect(root, binding.runtime.sessionId).catch(() => undefined))?.status?.toLowerCase();
  }
  if (status !== "idle" && status !== "stopped") return "UNAVAILABLE";
  const released = await (deps.awaitProviderLeaseRelease ?? waitForProviderLeaseRelease)(root, operation.id, participantId, binding.runtime.sessionId);
  if (!released) return "UNAVAILABLE";
  operation = await loadOperation(root, operationId);
  assertRecoveryActor(operation, authority);
  const latestParticipant = operation.participants[participantId];
  const latestBinding = latestParticipant?.executionBinding;
  if (!latestParticipant || !latestBinding || latestBinding.digest !== expectedBindingDigest) throw new Error("SAME_SESSION_RESUME_REJECTED: participant identity changed while waiting for prior provider lease release.");
  await assertSameSessionResumeCompatibleV1(root, operation, participantId);
  status = (await inspect(root, latestBinding.runtime.sessionId).catch(() => undefined))?.status?.toLowerCase();
  if (status !== "idle" && status !== "stopped") return "UNAVAILABLE";
  const prompt = [
    action === "RETRY_PARTICIPANT" ? "[AEH_SUPERVISOR_BOUNDED_PARTICIPANT_RETRY]" : "[AEH_SUPERVISOR_SAME_SESSION_RESUME]",
    `Continue only your existing frozen WorkUnit in operation ${operation.id}, participant ${participantId}, generation ${binding.participantGeneration}.`,
    `Candidate ${latestBinding.candidateDigest}, execution binding ${latestBinding.digest}, session ${latestBinding.runtime.sessionId} remain authoritative.`,
    "Use your existing session context and only the tools already projected to you. Do not expand scope, change policy, repeat equivalent calls without cause, or claim validation that has not run.",
    skills.length ? `Just-in-time recovery guidance (guidance only; no tools or authority): ${JSON.stringify(skills)}` : "No operational skill matched this observed failure; continue using the tools already projected to you.",
    "When complete, submit the existing bound structured result."
  ].join("\n");
  const startEvent = await recordParticipantExecutionActivityV1(root, operation.id, participantId, {
    kind: "PROVIDER_TURN_STARTED",
    evidenceId: `supervisor-recovery-turn:${randomUUID()}`,
    evidenceDigest: sha256Canonical({ action, operationId: operation.id, participantId, generation: latestBinding.participantGeneration, sessionId: latestBinding.runtime.sessionId })
  });
  if (!startEvent) throw new Error("SAME_SESSION_RESUME_REJECTED: controller refused the provider-turn start under a stale or terminal binding.");
  operation = await loadOperation(root, operationId);
  assertRecoveryActor(operation, authority);
  const dispatchParticipant = operation.participants[participantId];
  if (dispatchParticipant?.executionBinding?.digest !== expectedBindingDigest || dispatchParticipant.executionBinding.runtime.sessionId !== latestBinding.runtime.sessionId) throw new Error("SAME_SESSION_RESUME_REJECTED: participant binding changed immediately before dispatch.");
  await assertSameSessionResumeCompatibleV1(root, operation, participantId);
  const dispatched = await (deps.dispatch ?? dispatchManagedPaseoAgent)(root, latestBinding.runtime.sessionId, prompt, 60).catch(() => undefined);
  return dispatched?.exitCode === 0 ? "ACCEPTED" : "UNAVAILABLE";
}

function assertRecoveryActor(operation: Awaited<ReturnType<typeof loadOperation>>, authority?: { role: "SUPERVISOR" | "LEAD"; sessionId: string }): void {
  if (!authority) return;
  const authorized = authority.role === "LEAD"
    ? operation.lead?.agentId === authority.sessionId
    : activeOperationSupervisor(operation)?.agentId === authority.sessionId;
  if (!authorized) throw new Error("SAME_SESSION_RESUME_REJECTED: recovery actor is no longer the current bound Lead or active Supervisor.");
}

async function waitForProviderLeaseRelease(root: string, operationId: string, participantId: string, sessionId: string): Promise<boolean> {
  const runtime = await createManagedRuntime({ root, projectId: runtimeProjectId(root), ownerId: `aeh-recovery-observer:${process.pid}:${operationId}` });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await runtime.snapshot();
    const active = snapshot.providerLeases.some((lease) => lease.mode === "write"
      && lease.lifecycle?.operationId === operationId
      && lease.lifecycle.participantId === participantId
      && lease.lifecycle.sessionId === sessionId);
    if (!active) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}


function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SUPERVISOR_RECOVERY_ARGUMENTS_INVALID: expected an object.");
  return value as Record<string, unknown>;
}
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SUPERVISOR_RECOVERY_ARGUMENT_INVALID: ${name} is required.`);
  return value.trim();
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || value.length > 12) throw new Error("SUPERVISOR_RECOVERY_ARGUMENT_INVALID: evidenceIds must contain 1 to 12 strings.");
  return [...new Set(value as string[])];
}
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
