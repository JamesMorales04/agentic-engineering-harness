import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgentOutput } from "../agents/outputContracts.js";
import { extractMarkedJson, StructuredOutputError } from "../agents/structuredOutput.js";
import { operationArtifactDir, resolveOperationStateRoot, updateOperationParticipant } from "../operations/state.js";

export type StructuredResultSource = "mcp" | "captured";
export type StructuredResultTurnStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CONFLICT";

export interface StructuredResultTurn {
  id: string;
  sequence: number;
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
  contract: string;
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
  logicalAgent: string;
  role?: string;
  agentId?: string;
  contract: string;
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
}

export interface StructuredResultResolution<T = unknown> {
  ok: boolean;
  accepted?: AcceptedStructuredResult<T>;
  failure?: string;
}

const CHANNELS_DIR = "result-channels";
const RESULTS_DIR = "results";
const GLOBAL_INDEX_DIR = path.join(".harness", "result-channels", "agents");
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

export async function provisionStructuredResultChannel(
  root: string,
  input: { operationId: string; logicalAgent: string; role?: string; contract: string; channelId?: string }
): Promise<StructuredResultChannel> {
  const stateRoot = resolveOperationStateRoot(root);
  const channelId = input.channelId ?? crypto.randomUUID();
  const file = channelFile(stateRoot, input.operationId, channelId);
  try {
    return await readJson<StructuredResultChannel>(file);
  } catch {
    const now = new Date().toISOString();
    const channel: StructuredResultChannel = {
      version: 1,
      operationId: input.operationId,
      channelId,
      logicalAgent: input.logicalAgent,
      role: input.role,
      contract: input.contract,
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
  const channel = await mutateChannel(stateRoot, operationId, channelId, (current) => ({
    ...current,
    agentId,
    updatedAt: new Date().toISOString()
  }));
  const index = agentIndexFile(stateRoot, agentId);
  await writeJsonAtomic(index, { version: 1, operationId, channelId, agentId });
  return channel;
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
): Promise<StructuredResultTurn | undefined> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding) return undefined;
  return activateStructuredResultTurn(root, binding.operationId, binding.channelId, phase);
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
    const canonical = JSON.stringify(normalized);
    const sha256 = crypto.createHash("sha256").update(canonical).digest("hex");
    if (turn.status === "ACCEPTED" && turn.sha256) {
      if (turn.sha256 !== sha256) {
        channel.activeTurn = { ...turn, status: "CONFLICT", attempts: turn.attempts + 1, error: "CONFLICTING_RESULT: a different valid payload was submitted for an already accepted turn." };
        channel.updatedAt = new Date().toISOString();
        await writeJsonAtomic(file, channel);
        throw new Error("CONFLICTING_RESULT: a different valid payload was submitted for an already accepted turn.");
      }
      if (!turn.artifact) throw new Error("AEH_RESULT_CHANNEL_STATE: accepted turn is missing its artifact reference.");
      return { artifact: turn.artifact, sha256, payload: normalized, source: turn.source ?? source, turnId: turn.id, channelId };
    }

    const artifactEnvelope: StructuredResultArtifact<T> = {
      version: 1,
      kind: "agent-result",
      operationId,
      channelId,
      turnId: turn.id,
      sequence: turn.sequence,
      logicalAgent: channel.logicalAgent,
      role: channel.role,
      agentId: channel.agentId,
      contract: turn.contract,
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
    return { artifact, sha256, payload: normalized, source, turnId: turn.id, channelId };
  });
}

export async function acceptedStructuredResultForAgent<T = unknown>(
  root: string,
  agentId: string
): Promise<AcceptedStructuredResult<T> | undefined> {
  const binding = await loadAgentChannelBinding(root, agentId);
  if (!binding) return undefined;
  const stateRoot = resolveOperationStateRoot(root);
  const channel = await readJson<StructuredResultChannel>(channelFile(stateRoot, binding.operationId, binding.channelId)).catch(() => undefined);
  const turn = channel?.activeTurn;
  if (!channel || !turn || turn.status !== "ACCEPTED" || !turn.artifact || !turn.sha256) return undefined;
  const envelope = await readJson<StructuredResultArtifact<T>>(path.resolve(stateRoot, turn.artifact));
  return { artifact: turn.artifact, sha256: turn.sha256, payload: envelope.payload, source: turn.source ?? envelope.source, turnId: turn.id, channelId: channel.channelId };
}

export async function reconcileStructuredResult<T = unknown>(
  root: string,
  input: {
    operationId: string;
    agentId?: string;
    logicalAgent: string;
    role?: string;
    contract: string;
    phase?: string;
    stdout: string;
    stderr?: string;
  }
): Promise<StructuredResultResolution<T>> {
  if (input.agentId) {
    const accepted = await acceptedStructuredResultForAgent<T>(root, input.agentId).catch(() => undefined);
    if (accepted) return { ok: true, accepted };
  }

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
      : await provisionStructuredResultChannel(root, { operationId: input.operationId, logicalAgent: input.logicalAgent, role: input.role, contract: input.contract });
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
  const accepted = await acceptedStructuredResultForAgent(root, agentId).catch(() => undefined);
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
  input: { operationId: string; agentId?: string; logicalAgent: string; role?: string; contract: string }
): Promise<StructuredResultChannel> {
  if (!input.agentId) throw new Error("agentId is required");
  const binding = await loadAgentChannelBinding(root, input.agentId);
  if (binding) {
    const channel = await loadStructuredResultChannel(root, binding.operationId, binding.channelId);
    if (channel.contract !== input.contract) throw new Error(`AEH_RESULT_CONTRACT_MISMATCH: channel=${channel.contract} requested=${input.contract}`);
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
