import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgentOutput } from "../agents/outputContracts.js";
import { extractMarkedJson, StructuredOutputError } from "../agents/structuredOutput.js";
import { currentControllerEpoch, loadOperation, operationArtifactDir, resolveOperationStateRoot, updateOperationParticipant } from "../operations/state.js";
import { sha256Canonical } from "../core/digest.js";
import { assertCandidateRevisionV1, candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { assertExecutionBindingV2, type ExecutionBindingV2 } from "../architecture/executionIdentity.js";

export interface StructuredResultProvenanceV1 {
  version: 1;
  status: "BOUND" | "PARTIAL" | "UNSUPPORTED";
  projectId?: string;
  operationId: string;
  operationRevision?: number;
  operationExecutionRevision?: number;
  participantId?: string;
  /** Unique controller-issued identity for this participant execution generation. */
  participantGeneration?: string;
  logicalAgent: string;
  role?: string;
  taskId?: string;
  candidate?: CandidateRevisionV1;
  controllerEpoch?: number;
  runtime?: { provider: string; model?: string; runtimeId?: string; sessionId?: string };
  outputContract: string;
  outputSchemaDigest?: string;
  executionBinding?: ExecutionBindingV2;
  skillManifestDigest?: string;
  contextManifestDigest?: string;
  promptManifestDigest?: string;
  executionBlueprintDigest?: string;
  resolvedOperationPolicyDigest?: string;
  unsupported: string[];
  provenanceDigest: string;
}

export type StructuredResultSource = "mcp" | "captured";
export type StructuredResultTurnStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CONFLICT";

export interface StructuredResultTurn {
  id: string;
  sequence: number;
  revision: number;
  contract: string;
  phase?: string;
  status: StructuredResultTurnStatus;
  attempts: number;
  activatedAt: string;
  acceptedAt?: string;
  artifact?: string;
  sha256?: string;
  source?: StructuredResultSource;
  error?: string;
}

export interface StructuredResultChannel {
  version: 1;
  operationId: string;
  channelId: string;
  logicalAgent: string;
  role?: string;
  taskId?: string;
  operationRevision?: number;
  supervisorGeneration?: number;
  contract: string;
  provenance: StructuredResultProvenanceV1;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  activeTurn?: StructuredResultTurn;
}

export interface StructuredResultArtifact<T = unknown> {
  version: 1;
  kind: "agent-result";
  operationId: string;
  channelId: string;
  turnId: string;
  sequence: number;
  revision: number;
  attempt: number;
  logicalAgent: string;
  role?: string;
  taskId?: string;
  operationRevision?: number;
  supervisorGeneration?: number;
  agentId?: string;
  contract: string;
  provenance: StructuredResultProvenanceV1;
  source: StructuredResultSource;
  createdAt: string;
  payloadSha256: string;
  payload: T;
}

export interface AcceptedStructuredResult<T = unknown> {
  artifact: string;
  sha256: string;
  payload: T;
  source: StructuredResultSource;
  turnId: string;
  channelId: string;
  provenance: StructuredResultProvenanceV1;
}

export interface StructuredResultResolution<T = unknown> {
  ok: boolean;
  accepted?: AcceptedStructuredResult<T>;
  failure?: string;
}

export interface StructuredResultExpectation {
  operationId?: string;
  logicalAgent?: string;
  role?: string;
  contract?: string;
  phase?: string;
  participantId?: string;
  taskId?: string;
  attempt?: number;
  revision?: number;
  operationRevision?: number;
  supervisorGeneration?: number;
  provenance?: Partial<Omit<StructuredResultProvenanceV1, "version" | "status" | "unsupported" | "provenanceDigest">> & { status?: StructuredResultProvenanceV1["status"]; unsupported?: string[]; provenanceDigest?: string };
  requireBoundProvenance?: boolean;
  verifyCurrentCandidate?: boolean;
}

const CHANNELS_DIR = "result-channels";
const RESULTS_DIR = "results";
const GLOBAL_INDEX_DIR = path.join(".harness", "result-channels", "agents");
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

export async function provisionStructuredResultChannel(
  root: string,
  input: { operationId: string; logicalAgent: string; role?: string; taskId?: string; operationRevision?: number; supervisorGeneration?: number; contract: string; provenance?: StructuredResultProvenanceV1; channelId?: string }
): Promise<StructuredResultChannel> {
  const stateRoot = resolveOperationStateRoot(root);
  const channelId = input.channelId ?? crypto.randomUUID();
  const file = channelFile(stateRoot, input.operationId, channelId);
  try {
    const existing = await readJson<StructuredResultChannel>(file);
    if (existing.operationId !== input.operationId || existing.channelId !== channelId || existing.logicalAgent !== input.logicalAgent || existing.role !== input.role || existing.taskId !== input.taskId || existing.contract !== input.contract) {
      throw new Error("AEH_RESULT_PROVENANCE: existing result channel does not match its requested immutable identity.");
    }
    if (input.operationRevision !== undefined && existing.operationRevision !== input.operationRevision) throw new Error("AEH_RESULT_PROVENANCE: existing result channel belongs to another operation revision.");
    if (input.provenance && !provenanceMatches(existing.provenance, input.provenance)) throw new Error("AEH_RESULT_PROVENANCE: existing result channel belongs to another candidate, participant generation, or execution parent.");
    assertStructuredResultProvenance(existing.provenance, { operationId: input.operationId, logicalAgent: input.logicalAgent, role: input.role, taskId: input.taskId, contract: input.contract });
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    const provenance = input.provenance ?? createStructuredResultProvenance({
      operationId: input.operationId,
      logicalAgent: input.logicalAgent,
      role: input.role,
      taskId: input.taskId,
      outputContract: input.contract,
      unsupported: ["projectId", "operationRevision", "participantId", "participantGeneration", "candidate", "controllerEpoch", "runtime", "outputSchemaDigest", "executionBlueprintDigest", "resolvedOperationPolicyDigest"]
    });
    assertStructuredResultProvenance(provenance, { operationId: input.operationId, logicalAgent: input.logicalAgent, role: input.role, taskId: input.taskId, contract: input.contract });
    if (input.operationRevision !== undefined && provenance.operationRevision !== undefined && provenance.operationRevision !== input.operationRevision) {
      throw new Error("AEH_RESULT_PROVENANCE: channel operation revision does not match immutable result provenance.");
    }
    const channel: StructuredResultChannel = {
      version: 1,
      operationId: input.operationId,
      channelId,
      logicalAgent: input.logicalAgent,
      role: input.role,
      taskId: input.taskId,
      operationRevision: provenance.operationRevision ?? input.operationRevision,
      supervisorGeneration: input.supervisorGeneration,
      contract: input.contract,
      provenance,
      createdAt: now,
      updatedAt: now,
      sequence: 0
    };
    await writeJsonAtomic(file, channel);
    return channel;
  }
}

export async function bindStructuredResultChannel(
  root: string,
  operationId: string,
  channelId: string,
  agentId: string
): Promise<StructuredResultChannel> {
  const stateRoot = resolveOperationStateRoot(root);
  const channel = await mutateChannel(stateRoot, operationId, channelId, (current) => {
    if (current.agentId && current.agentId !== agentId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: result channel is already bound to a different runtime session.");
    return { ...current, agentId, updatedAt: new Date().toISOString() };
  });
  const index = agentIndexFile(stateRoot, agentId);
  await writeJsonAtomic(index, { version: 1, operationId, channelId, agentId });
  return channel;
}

/** Finalize an inert Paseo result channel after its idle provider session returns
 * an actual id and the controller has durably compiled the complete binding. */
export async function finalizeStructuredResultChannelForAgent(
  root: string,
  agentId: string,
  provenance: StructuredResultProvenanceV1
): Promise<StructuredResultChannel> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding || binding.operationId !== provenance.operationId) {
    throw new Error("AEH_RESULT_PROVENANCE: no pending result channel is bound to the materialized runtime session.");
  }
  assertStructuredResultProvenance(provenance, {
    operationId: provenance.operationId,
    logicalAgent: provenance.logicalAgent,
    role: provenance.role,
    taskId: provenance.taskId,
    contract: provenance.outputContract
  });
  if (provenance.executionBinding?.runtime.sessionId !== agentId) {
    throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: pending result channel cannot be finalized for a different runtime session.");
  }
  if (provenance.status !== "BOUND" || provenance.unsupported.length) {
    throw new Error("AEH_RESULT_PROVENANCE_INCOMPLETE: pending channel finalization requires complete binding for the exact materialized runtime session.");
  }
  const stateRoot = resolveOperationStateRoot(root);
  return mutateChannel(stateRoot, binding.operationId, binding.channelId, (current) => {
    if (current.operationId !== provenance.operationId || current.logicalAgent !== provenance.logicalAgent || current.role !== provenance.role || current.taskId !== provenance.taskId || current.contract !== provenance.outputContract) {
      throw new Error("AEH_RESULT_PROVENANCE: pending channel identity does not match the finalized binding.");
    }
    if (current.agentId !== agentId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: pending channel is bound to a different runtime session.");
    if (current.provenance.status === "BOUND") {
      if (current.provenance.provenanceDigest === provenance.provenanceDigest) return current;
      throw new Error("AEH_RESULT_CHANNEL_REPLAYED: a finalized result channel cannot be rebound to another execution identity.");
    }
    if (current.provenance.status !== "UNSUPPORTED" || current.activeTurn) {
      throw new Error("AEH_RESULT_CHANNEL_STATE: only an inert unsupported channel can be finalized.");
    }
    return {
      ...current,
      operationRevision: provenance.operationRevision,
      provenance,
      updatedAt: new Date().toISOString()
    };
  });
}

export async function activateStructuredResultTurn(
  root: string,
  operationId: string,
  channelId: string,
  phase?: string
): Promise<StructuredResultTurn> {
  const stateRoot = resolveOperationStateRoot(root);
  const channel = await mutateChannel(stateRoot, operationId, channelId, (current) => {
    const sequence = current.sequence + 1;
    const now = new Date().toISOString();
    return {
      ...current,
      sequence,
      updatedAt: now,
      activeTurn: {
        id: `${String(sequence).padStart(4, "0")}-${crypto.randomUUID()}`,
        sequence,
        revision: sequence,
        contract: current.contract,
        phase,
        status: "PENDING",
        attempts: 0,
        activatedAt: now
      }
    };
  });
  if (!channel.activeTurn) throw new Error("AEH_RESULT_CHANNEL_STATE: active result turn was not created.");
  return channel.activeTurn;
}

export async function activateStructuredResultTurnForAgent(
  root: string,
  agentId: string,
  phase?: string
): Promise<StructuredResultTurn> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding) throw new Error(`AEH_RESULT_CHANNEL_STATE: no structured result channel is bound to agent '${agentId}'.`);
  return activateStructuredResultTurn(root, binding.operationId, binding.channelId, phase);
}

export function createStructuredResultProvenance(input: Omit<StructuredResultProvenanceV1, "version" | "status" | "unsupported" | "provenanceDigest"> & { unsupported?: string[] }): StructuredResultProvenanceV1 {
  if (!input.operationId.trim() || !input.logicalAgent.trim() || !input.outputContract.trim()) throw new Error("AEH_RESULT_PROVENANCE: operation, logical participant, and output contract are required.");
  const missing = [
    ...(!input.projectId ? ["projectId"] : []),
    ...(input.operationRevision === undefined ? ["operationRevision"] : []),
    ...(input.operationExecutionRevision === undefined ? ["operationExecutionRevision"] : []),
    ...(!input.participantId ? ["participantId"] : []),
    ...(!input.participantGeneration ? ["participantGeneration"] : []),
    ...(!input.candidate ? ["candidate"] : []),
    ...(input.controllerEpoch === undefined ? ["controllerEpoch"] : []),
    ...(!input.runtime?.provider ? ["runtime"] : []),
    ...(!input.runtime?.sessionId ? ["runtime.sessionId"] : []),
    ...(!input.outputSchemaDigest ? ["outputSchemaDigest"] : []),
    ...(!input.executionBlueprintDigest ? ["executionBlueprintDigest"] : []),
    ...(!input.resolvedOperationPolicyDigest ? ["resolvedOperationPolicyDigest"] : []),
    ...(!input.executionBinding ? ["executionBinding"] : []),
    ...(!input.skillManifestDigest ? ["skillManifestDigest"] : []),
    ...(!input.contextManifestDigest ? ["contextManifestDigest"] : []),
    ...(!input.promptManifestDigest ? ["promptManifestDigest"] : [])
  ];
  const unsupported = [...new Set([...(input.unsupported ?? []), ...missing])].sort();
  const hasCoreBinding = Boolean(input.projectId && input.operationRevision !== undefined && input.operationExecutionRevision !== undefined && input.participantId && input.participantGeneration && input.candidate && input.controllerEpoch !== undefined && input.runtime?.provider && input.runtime?.sessionId && input.outputSchemaDigest);
  const base = {
    version: 1 as const,
    status: hasCoreBinding ? unsupported.length ? "PARTIAL" as const : "BOUND" as const : "UNSUPPORTED" as const,
    ...input,
    unsupported
  };
  return { ...base, provenanceDigest: sha256Canonical(base) };
}

export function assertStructuredResultProvenance(
  provenance: StructuredResultProvenanceV1,
  expected: { operationId: string; logicalAgent: string; role?: string; taskId?: string; contract: string }
): void {
  if (!provenance || provenance.version !== 1 || !["BOUND", "PARTIAL", "UNSUPPORTED"].includes(provenance.status) || provenance.operationId !== expected.operationId || provenance.logicalAgent !== expected.logicalAgent || provenance.role !== expected.role || provenance.taskId !== expected.taskId || provenance.outputContract !== expected.contract) {
    throw new Error("AEH_RESULT_PROVENANCE: immutable result provenance does not match its channel identity.");
  }
  if (provenance.candidate) {
    assertCandidateRevisionV1(provenance.candidate);
    if (provenance.candidate.operationId !== expected.operationId) throw new Error("AEH_RESULT_PROVENANCE: candidate belongs to another operation.");
    if (provenance.projectId && provenance.candidate.projectId && provenance.projectId !== provenance.candidate.projectId) throw new Error("AEH_RESULT_PROVENANCE: project identity does not match the candidate.");
    if (provenance.taskId && provenance.candidate.taskId && provenance.taskId !== provenance.candidate.taskId) throw new Error("AEH_RESULT_PROVENANCE: task identity does not match the candidate.");
  }
  if (!Array.isArray(provenance.unsupported) || provenance.unsupported.some((item) => typeof item !== "string" || !item.trim())) throw new Error("AEH_RESULT_PROVENANCE: unsupported identity list is malformed.");
  for (const digest of [provenance.outputSchemaDigest, provenance.executionBlueprintDigest, provenance.resolvedOperationPolicyDigest]) {
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw new Error("AEH_RESULT_PROVENANCE: a content identity digest is malformed.");
  }
  for (const digest of [provenance.skillManifestDigest, provenance.contextManifestDigest, provenance.promptManifestDigest]) if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw new Error("AEH_RESULT_PROVENANCE: an execution manifest digest is malformed.");
  if (provenance.executionBinding) {
    assertExecutionBindingV2(provenance.executionBinding);
    if (provenance.executionBinding.operationId !== provenance.operationId || provenance.executionBinding.operationExecutionRevision !== provenance.operationExecutionRevision || provenance.executionBinding.candidateRevision !== provenance.candidate?.revision || provenance.executionBinding.candidateDigest !== provenance.candidate?.identityDigest || provenance.executionBinding.controllerEpoch !== provenance.controllerEpoch || provenance.executionBinding.participantId !== provenance.participantId || provenance.executionBinding.participantGeneration !== provenance.participantGeneration || provenance.executionBinding.executionBlueprintDigest !== provenance.executionBlueprintDigest || provenance.executionBinding.operationPolicyDigest !== provenance.resolvedOperationPolicyDigest || provenance.executionBinding.outputContract !== provenance.outputContract || provenance.executionBinding.skillManifestDigest !== provenance.skillManifestDigest || provenance.executionBinding.contextManifestDigest !== provenance.contextManifestDigest || provenance.executionBinding.promptManifestDigest !== provenance.promptManifestDigest || provenance.executionBinding.runtime.provider !== provenance.runtime?.provider || provenance.executionBinding.runtime.modelId !== provenance.runtime?.model || provenance.executionBinding.runtime.runtimeId !== provenance.runtime?.runtimeId || provenance.executionBinding.runtime.sessionId !== provenance.runtime?.sessionId) throw new Error("AEH_RESULT_PROVENANCE: complete binding does not match structured result identity.");
  }
  const { provenanceDigest, ...base } = provenance;
  if (!/^[a-f0-9]{64}$/.test(provenanceDigest) || sha256Canonical(base) !== provenanceDigest) throw new Error("AEH_RESULT_PROVENANCE: immutable result provenance digest is inconsistent.");
  if (provenance.status !== "UNSUPPORTED" && (!provenance.projectId || provenance.operationRevision === undefined || provenance.operationExecutionRevision === undefined || !provenance.participantId || !provenance.participantGeneration || !provenance.candidate || provenance.controllerEpoch === undefined || !provenance.runtime?.provider || !provenance.runtime?.sessionId || !provenance.outputSchemaDigest || !provenance.executionBinding || !provenance.skillManifestDigest || !provenance.contextManifestDigest || !provenance.promptManifestDigest)) {
    throw new Error("AEH_RESULT_PROVENANCE: candidate-bound result provenance is incomplete.");
  }
  const expectedStatus = provenance.status === "UNSUPPORTED"
    ? "UNSUPPORTED"
    : provenance.unsupported.length ? "PARTIAL" : "BOUND";
  if (provenance.status !== expectedStatus) {
    throw new Error("AEH_RESULT_PROVENANCE: result provenance status does not match its supported identity fields.");
  }
  if (provenance.operationRevision !== undefined && (!Number.isSafeInteger(provenance.operationRevision) || provenance.operationRevision < 0)) throw new Error("AEH_RESULT_PROVENANCE: operation record revision is invalid.");
  if (provenance.operationExecutionRevision !== undefined && (!Number.isSafeInteger(provenance.operationExecutionRevision) || provenance.operationExecutionRevision < 1)) throw new Error("AEH_RESULT_PROVENANCE: operation execution revision is invalid.");
  if (provenance.controllerEpoch !== undefined && (!Number.isSafeInteger(provenance.controllerEpoch) || provenance.controllerEpoch < 0)) throw new Error("AEH_RESULT_PROVENANCE: controller epoch is invalid.");
}

export async function acceptStructuredResult<T = unknown>(
  root: string,
  operationId: string,
  channelId: string,
  payload: unknown,
  source: StructuredResultSource
): Promise<AcceptedStructuredResult<T>> {
  const stateRoot = resolveOperationStateRoot(root);
  const file = channelFile(stateRoot, operationId, channelId);
  return withFileLock(file, async () => {
    const channel = await readJson<StructuredResultChannel>(file);
    assertStructuredResultProvenance(channel.provenance, { operationId, logicalAgent: channel.logicalAgent, role: channel.role, taskId: channel.taskId, contract: channel.contract });
    if (channel.provenance.status !== "BOUND" || !channel.provenance.executionBinding) throw new Error(`AEH_RESULT_PROVENANCE_INCOMPLETE: full versioned ExecutionBinding is required: ${channel.provenance.unsupported.join(", ")}.`);
    if (channel.provenance.candidate) {
      const operation = await loadOperation(stateRoot, operationId).catch((error) => { throw new Error(`AEH_RESULT_PROVENANCE: current operation identity is unavailable: ${String(error)}`); });
      if (!operation.candidateRevision || !candidateRevisionsEqual(operation.candidateRevision, channel.provenance.candidate)) throw new Error("AEH_RESULT_STALE_CANDIDATE: result submission belongs to a candidate that is no longer current.");
      await assertWorkspaceMatchesCandidate(channel.provenance.candidate.worktree ?? operation.workspaceRoot ?? operation.root, channel.provenance.candidate, operation.candidateRevision);
      if (channel.provenance.status === "BOUND") await assertCurrentStructuredResultExecution(operation, channel.provenance);
    }
    const turn = channel.activeTurn;
    if (!turn) throw new Error("AEH_RESULT_NO_ACTIVE_TURN: result submission has no controller-activated turn.");
    const validation = validateAgentOutput(turn.contract, payload);
    if (!validation.ok) {
      const failure = `SCHEMA_VALIDATION_FAILED: ${validation.issues.join("; ")}`;
      channel.activeTurn = { ...turn, status: "REJECTED", attempts: turn.attempts + 1, error: failure };
      channel.updatedAt = new Date().toISOString();
      await writeJsonAtomic(file, channel);
      throw new Error(failure);
    }
    const normalized = validation.value as T;
    const sha256 = sha256Canonical(normalized);
    if (turn.status === "ACCEPTED" && turn.sha256) {
      if (turn.sha256 !== sha256) {
        channel.activeTurn = { ...turn, status: "CONFLICT", attempts: turn.attempts + 1, error: "CONFLICTING_RESULT: a different valid payload was submitted for an already accepted turn." };
        channel.updatedAt = new Date().toISOString();
        await writeJsonAtomic(file, channel);
        throw new Error("CONFLICTING_RESULT: a different valid payload was submitted for an already accepted turn.");
      }
      if (!turn.artifact) throw new Error("AEH_RESULT_CHANNEL_STATE: accepted turn is missing its artifact reference.");
      return readVerifiedAcceptedArtifact<T>(stateRoot, channel, turn);
    }

    const artifactEnvelope: StructuredResultArtifact<T> = {
      version: 1,
      kind: "agent-result",
      operationId,
      channelId,
      turnId: turn.id,
      sequence: turn.sequence,
      revision: turn.revision,
      attempt: turn.attempts + 1,
      logicalAgent: channel.logicalAgent,
      role: channel.role,
      taskId: channel.taskId,
      operationRevision: channel.operationRevision,
      supervisorGeneration: channel.supervisorGeneration,
      agentId: channel.agentId,
      contract: turn.contract,
      provenance: channel.provenance,
      source,
      createdAt: new Date().toISOString(),
      payloadSha256: sha256,
      payload: normalized
    };
    const artifact = await persistResultArtifact(stateRoot, artifactEnvelope);
    const acceptedAt = new Date().toISOString();
    channel.activeTurn = {
      ...turn,
      status: "ACCEPTED",
      attempts: turn.attempts + 1,
      acceptedAt,
      artifact,
      sha256,
      source,
      error: undefined
    };
    channel.updatedAt = acceptedAt;
    await writeJsonAtomic(file, channel);
    if (channel.agentId) {
      await updateOperationParticipant(stateRoot, operationId, channel.agentId, { resultArtifact: artifact }).catch(() => undefined);
    }
    return { artifact, sha256, payload: normalized, source, turnId: turn.id, channelId, provenance: channel.provenance };
  });
}

export async function acceptedStructuredResultForAgent<T = unknown>(
  root: string,
  agentId: string,
  expected: StructuredResultExpectation = {}
): Promise<AcceptedStructuredResult<T> | undefined> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding) return undefined;
  const stateRoot = resolveOperationStateRoot(root);
  if (expected.operationId && binding.operationId !== expected.operationId) throw new Error("AEH_RESULT_PROVENANCE: result binding belongs to a different operation.");
  const channel = await readJson<StructuredResultChannel>(channelFile(stateRoot, binding.operationId, binding.channelId)).catch(() => undefined);
  const turn = channel?.activeTurn;
  if (!channel || !turn || turn.status !== "ACCEPTED" || !turn.artifact || !turn.sha256) return undefined;
  return readVerifiedAcceptedArtifact(stateRoot, channel, turn, agentId, expected);
}

export async function structuredResultProvenanceForAgent(root: string, agentId: string): Promise<StructuredResultProvenanceV1 | undefined> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding) return undefined;
  const channel = await loadStructuredResultChannel(root, binding.operationId, binding.channelId);
  return channel.provenance;
}

export async function reconcileStructuredResult<T = unknown>(
  root: string,
  input: {
    operationId: string;
    agentId?: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    contract: string;
    provenance?: StructuredResultProvenanceV1;
    phase?: string;
    stdout: string;
    stderr?: string;
  }
): Promise<StructuredResultResolution<T>> {
  let payload: unknown;
  try {
    payload = extractMarkedJson(input.stdout, input.stderr ?? "");
  } catch (error) {
    if (error instanceof StructuredOutputError) return { ok: false, failure: `${error.reason}: ${error.message}` };
    return { ok: false, failure: `OUTPUT_CONTRACT_UNKNOWN: ${String(error)}` };
  }

  try {
    const channel = input.agentId
      ? await ensureAgentChannel(root, input)
    : await provisionStructuredResultChannel(root, { operationId: input.operationId, logicalAgent: input.logicalAgent, role: input.role, taskId: input.taskId, contract: input.contract, provenance: input.provenance });
    if (!channel.activeTurn || channel.activeTurn.status === "ACCEPTED") {
      await activateStructuredResultTurn(root, input.operationId, channel.channelId, input.phase);
    }
    const accepted = await acceptStructuredResult<T>(root, input.operationId, channel.channelId, payload, "captured");
    return { ok: true, accepted };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
}

export async function projectAcceptedStructuredResult<T extends { stdout: string }>(root: string, agentId: string, result: T): Promise<T> {
  const accepted = await acceptedStructuredResultForAgent(root, agentId);
  return accepted ? { ...result, stdout: JSON.stringify(accepted.payload) } : result;
}

export async function loadStructuredResultChannel(root: string, operationId: string, channelId: string): Promise<StructuredResultChannel> {
  return readJson<StructuredResultChannel>(channelFile(resolveOperationStateRoot(root), operationId, channelId));
}

export function resultSinkMcpServerDefinition(root: string, operationId: string, channelId: string): {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  alwaysLoad: true;
} {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./resultSinkMcp.js", import.meta.url))],
    env: {
      AEH_RESULT_CONTROL_ROOT: resolveOperationStateRoot(root),
      AEH_RESULT_OPERATION_ID: operationId,
      AEH_RESULT_CHANNEL_ID: channelId
    },
    alwaysLoad: true
  };
}

async function ensureAgentChannel(
  root: string,
  input: { operationId: string; agentId?: string; logicalAgent: string; role?: string; taskId?: string; contract: string; provenance?: StructuredResultProvenanceV1 }
): Promise<StructuredResultChannel> {
  if (!input.agentId) throw new Error("agentId is required");
  const binding = await loadAgentChannelBinding(root, input.agentId);
  if (binding) {
    const channel = await loadStructuredResultChannel(root, binding.operationId, binding.channelId);
    if (binding.operationId !== input.operationId) throw new Error("AEH_RESULT_PROVENANCE: participant result binding belongs to another operation.");
    if (channel.contract !== input.contract) throw new Error(`AEH_RESULT_CONTRACT_MISMATCH: channel=${channel.contract} requested=${input.contract}`);
    if (input.provenance && !provenanceMatches(channel.provenance, input.provenance)) throw new Error("AEH_RESULT_PROVENANCE: participant result binding belongs to another candidate or generation.");
    return channel;
  }
  const channel = await provisionStructuredResultChannel(root, input);
  return bindStructuredResultChannel(root, input.operationId, channel.channelId, input.agentId);
}

async function loadAgentChannelBinding(root: string, agentId: string): Promise<{ operationId: string; channelId: string; agentId: string } | undefined> {
  const stateRoot = resolveOperationStateRoot(root);
  return readJson<{ operationId: string; channelId: string; agentId: string }>(agentIndexFile(stateRoot, agentId)).catch(() => undefined);
}

async function persistResultArtifact<T>(root: string, envelope: StructuredResultArtifact<T>): Promise<string> {
  const dir = path.join(operationArtifactDir(root, envelope.operationId), RESULTS_DIR, safe(envelope.logicalAgent));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${String(envelope.sequence).padStart(4, "0")}-${safe(envelope.turnId)}.json`);
  await writeJsonAtomic(file, envelope);
  return path.relative(resolveOperationStateRoot(root), file).replaceAll("\\", "/");
}

function channelFile(root: string, operationId: string, channelId: string): string {
  return path.join(operationArtifactDir(root, operationId), CHANNELS_DIR, `${safe(channelId)}.json`);
}
function agentIndexFile(root: string, agentId: string): string { return path.resolve(root, GLOBAL_INDEX_DIR, `${safe(agentId)}.json`); }
function safe(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "result"; }
function isWithin(parent: string, child: string): boolean { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }

async function readVerifiedAcceptedArtifact<T>(
  stateRoot: string,
  channel: StructuredResultChannel,
  turn: StructuredResultTurn,
  expectedAgentId?: string,
  expected: StructuredResultExpectation = {}
): Promise<AcceptedStructuredResult<T>> {
  if (channel.operationId !== expected.operationId && expected.operationId) throw new Error("AEH_RESULT_PROVENANCE: result channel belongs to a different operation.");
  if (channel.operationId.length === 0 || !channel.channelId || !channel.logicalAgent || !channel.contract) throw new Error("AEH_RESULT_PROVENANCE: result channel identity is incomplete.");
  if (expectedAgentId !== undefined && channel.agentId !== expectedAgentId) throw new Error("AEH_RESULT_PROVENANCE: result channel participant does not match the requested agent.");
  if (expected.participantId && channel.agentId !== expected.participantId) throw new Error("AEH_RESULT_PROVENANCE: result channel participant does not match the requested agent.");
  if (expected.logicalAgent && channel.logicalAgent !== expected.logicalAgent) throw new Error("AEH_RESULT_PROVENANCE: result logical agent does not match the requested participant.");
  if (expected.role && channel.role !== expected.role) throw new Error("AEH_RESULT_PROVENANCE: result role does not match the requested participant.");
  if (expected.contract && channel.contract !== expected.contract) throw new Error("AEH_RESULT_PROVENANCE: result contract does not match the requested handoff.");
  if (expected.taskId && channel.taskId !== expected.taskId) throw new Error("AEH_RESULT_PROVENANCE: result task does not match the requested task.");
  if (expected.operationRevision !== undefined && channel.operationRevision !== expected.operationRevision) throw new Error("AEH_RESULT_PROVENANCE: result operation revision does not match the requested revision.");
  if (expected.supervisorGeneration !== undefined && channel.supervisorGeneration !== expected.supervisorGeneration) throw new Error("AEH_RESULT_PROVENANCE: result supervisor generation does not match the requested participant.");
  if (!Number.isInteger(turn.revision) || turn.revision !== turn.sequence || turn.contract !== channel.contract || (expected.phase && turn.phase !== expected.phase)) throw new Error("AEH_RESULT_PROVENANCE: result turn revision or contract does not match the active channel.");
  if (expected.attempt !== undefined && turn.attempts !== expected.attempt) throw new Error("AEH_RESULT_PROVENANCE: result attempt does not match the requested attempt.");
  if (expected.revision !== undefined && turn.revision !== expected.revision) throw new Error("AEH_RESULT_PROVENANCE: result revision does not match the requested revision.");
  if (!turn.artifact || !turn.sha256 || !turn.source || turn.attempts < 1) throw new Error("AEH_RESULT_PROVENANCE: accepted result turn provenance is incomplete.");
  if (path.isAbsolute(turn.artifact)) throw new Error("AEH_RESULT_PROVENANCE: result artifact reference must be relative.");
  const artifactPath = path.resolve(stateRoot, turn.artifact);
  if (!isWithin(stateRoot, artifactPath)) throw new Error("AEH_RESULT_PROVENANCE: result artifact escapes the control root.");
  const envelope = await readJson<StructuredResultArtifact<T>>(artifactPath);
  const identityMatches = envelope.version === 1 && envelope.kind === "agent-result" && envelope.operationId === channel.operationId && envelope.channelId === channel.channelId && envelope.turnId === turn.id && envelope.sequence === turn.sequence && envelope.revision === turn.revision && envelope.attempt === turn.attempts && envelope.logicalAgent === channel.logicalAgent && envelope.role === channel.role && envelope.agentId === channel.agentId && envelope.contract === channel.contract && envelope.source === turn.source && envelope.taskId === channel.taskId && envelope.operationRevision === channel.operationRevision && envelope.supervisorGeneration === channel.supervisorGeneration;
  if (!identityMatches) throw new Error("AEH_RESULT_PROVENANCE: result artifact identity does not match the active channel turn.");
  const payloadSha256 = sha256Canonical(envelope.payload);
  if (payloadSha256 !== envelope.payloadSha256 || payloadSha256 !== turn.sha256) throw new Error("AEH_RESULT_INTEGRITY: accepted result artifact payload digest mismatch.");
  const validation = validateAgentOutput(envelope.contract, envelope.payload);
  if (!validation.ok) throw new Error(`AEH_RESULT_INTEGRITY: accepted result no longer satisfies its contract: ${validation.issues.join("; ")}`);
  if (!channel.provenance || !envelope.provenance || sha256Canonical(envelope.provenance) !== sha256Canonical(channel.provenance)) throw new Error("AEH_RESULT_PROVENANCE: result artifact is missing or has different immutable provenance.");
  if (channel.operationRevision !== undefined && channel.provenance.operationRevision !== undefined && channel.operationRevision !== channel.provenance.operationRevision) throw new Error("AEH_RESULT_PROVENANCE: channel operation revision does not match immutable result provenance.");
  assertStructuredResultProvenance(channel.provenance, { operationId: channel.operationId, logicalAgent: channel.logicalAgent, role: channel.role, taskId: channel.taskId, contract: channel.contract });
  assertStructuredResultProvenance(envelope.provenance, { operationId: channel.operationId, logicalAgent: channel.logicalAgent, role: channel.role, taskId: channel.taskId, contract: channel.contract });
  if (expected.requireBoundProvenance && channel.provenance.status !== "BOUND") throw new Error(`AEH_RESULT_PROVENANCE_INCOMPLETE: result lacks complete immutable execution identity: ${channel.provenance.unsupported.join(", ")}.`);
  if (expected.provenance && !provenanceMatches(channel.provenance, expected.provenance)) throw new Error("AEH_RESULT_PROVENANCE: result belongs to a different candidate, participant generation, or execution parent.");
  if (channel.provenance.status === "BOUND") {
    const operation = await loadOperation(stateRoot, channel.operationId).catch((error) => { throw new Error(`AEH_RESULT_PROVENANCE: current operation identity is unavailable: ${String(error)}`); });
    await assertCurrentStructuredResultExecution(operation, channel.provenance);
  }
  if (expected.verifyCurrentCandidate) {
    const operation = await loadOperation(stateRoot, channel.operationId).catch((error) => { throw new Error(`AEH_RESULT_PROVENANCE: current operation identity is unavailable: ${String(error)}`); });
    if (!operation.candidateRevision || !channel.provenance.candidate || !candidateRevisionsEqual(operation.candidateRevision, channel.provenance.candidate)) throw new Error("AEH_RESULT_STALE_CANDIDATE: result was produced for a candidate that is no longer current.");
    await assertWorkspaceMatchesCandidate(channel.provenance.candidate.worktree ?? operation.workspaceRoot ?? operation.root, channel.provenance.candidate, operation.candidateRevision);
  }
  return { artifact: turn.artifact, sha256: turn.sha256, payload: envelope.payload, source: envelope.source, turnId: turn.id, channelId: channel.channelId, provenance: channel.provenance };
}

async function assertCurrentStructuredResultExecution(operation: Awaited<ReturnType<typeof loadOperation>>, provenance: StructuredResultProvenanceV1): Promise<void> {
  const candidate = operation.candidateRevision;
  const binding = provenance.participantId ? operation.participants[provenance.participantId]?.executionBinding : undefined;
  if (!candidate || !provenance.candidate || !candidateRevisionsEqual(candidate, provenance.candidate)) {
    throw new Error("AEH_RESULT_STALE_CANDIDATE: result was produced for a candidate that is no longer current.");
  }
  await assertWorkspaceMatchesCandidate(provenance.candidate.worktree ?? operation.workspaceRoot ?? operation.root, provenance.candidate, candidate);
  if (!binding || !provenance.executionBinding || binding.digest !== provenance.executionBinding.digest || binding.operationExecutionRevision !== operation.operationExecutionRevision || binding.candidateDigest !== provenance.candidate.identityDigest || binding.controllerEpoch !== currentControllerEpoch(operation) || binding.controllerEpoch !== provenance.controllerEpoch || binding.executionBlueprintDigest !== provenance.executionBlueprintDigest || binding.operationPolicyDigest !== provenance.resolvedOperationPolicyDigest || operation.resolvedOperationPolicy?.digest !== binding.operationPolicyDigest) {
    throw new Error("AEH_RESULT_STALE_EXECUTION: result was produced for an older participant generation, operation revision, or ExecutionBlueprint.");
  }
}

function provenanceMatches(actual: StructuredResultProvenanceV1, expected: NonNullable<StructuredResultExpectation["provenance"]>): boolean {
  if (expected.provenanceDigest && actual.provenanceDigest !== expected.provenanceDigest) return false;
  for (const key of ["projectId", "operationId", "operationRevision", "operationExecutionRevision", "participantId", "participantGeneration", "logicalAgent", "role", "taskId", "controllerEpoch", "outputContract", "outputSchemaDigest", "executionBlueprintDigest", "resolvedOperationPolicyDigest", "skillManifestDigest", "contextManifestDigest", "promptManifestDigest"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) return false;
  }
  if (expected.candidate && (!actual.candidate || !candidateRevisionsEqual(actual.candidate, expected.candidate))) return false;
  if (expected.runtime && sha256Canonical(actual.runtime) !== sha256Canonical(expected.runtime)) return false;
  if (expected.executionBinding && actual.executionBinding?.digest !== expected.executionBinding.digest) return false;
  if (expected.unsupported && sha256Canonical(actual.unsupported) !== sha256Canonical([...expected.unsupported].sort())) return false;
  if (expected.status && actual.status !== expected.status) return false;
  return true;
}

async function mutateChannel(
  root: string,
  operationId: string,
  channelId: string,
  mutate: (current: StructuredResultChannel) => StructuredResultChannel
): Promise<StructuredResultChannel> {
  const file = channelFile(root, operationId, channelId);
  return withFileLock(file, async () => {
    const current = await readJson<StructuredResultChannel>(file);
    const next = mutate(current);
    await writeJsonAtomic(file, next);
    return next;
  });
}

async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx");
      try { return await action(); }
      finally { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
