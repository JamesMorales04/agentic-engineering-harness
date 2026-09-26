import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  acceptedStructuredResultForAgent,
  activateStructuredResultTurn,
  activateStructuredResultTurnForAgent,
  bindStructuredResultChannel,
  loadStructuredResultChannel,
  provisionStructuredResultChannel,
  resultSinkMcpServerDefinition,
  type StructuredResultExpectation,
  type StructuredResultProvenanceV1
} from "../workers/resultGateway.js";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";

export interface PaseoSdkMcpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
  /** Metadata consumed by AEH-managed MCP proxies; native Paseo ignores it. */
  toolPolicy?: { allow?: string[]; deny?: string[] };
}

export interface PaseoSdkToolPolicy {
  preapproved: Array<{ kind: "mcp"; server: string; tool: string }>;
}

export interface PaseoSdkAgentOptions {
  /** Provider resource id requested for a frozen pre-prompt execution binding. */
  agentId?: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  env?: Record<string, string>;
  title: string;
  systemPrompt?: string;
  prompt?: string;
  outputSchema?: Record<string, unknown>;
  labels?: Record<string, string>;
  mcpServers?: Record<string, PaseoSdkMcpStdioServer>;
  toolPolicy?: PaseoSdkToolPolicy;
  timeoutMs?: number;
  waitForFinish?: boolean;
}

export interface PaseoSdkAgentResult {
  id: string;
  workspaceId?: string;
  status?: string;
  lastMessage?: string;
  error?: string;
}

export interface PaseoSdkAgentRecord {
  id: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  raw: Record<string, unknown>;
}

interface PaseoSdkTurnResult {
  status: string;
  lastMessage?: string;
  error?: string;
}

interface PaseoSdkAgentHandle {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly status?: unknown;
  latest?(): Record<string, unknown> | null;
  refresh?(requestId?: string): Promise<{ agent: Record<string, unknown>; project: unknown } | null>;
  refetch?(requestId?: string): Promise<{ agent: Record<string, unknown>; project: unknown } | null>;
  send?(text: string, options?: Record<string, unknown>): Promise<void>;
  run?(text: string, options?: { timeoutMs?: number; outputSchema?: Record<string, unknown> }): Promise<PaseoSdkTurnResult>;
  waitForFinish?(timeoutMs?: number): Promise<PaseoSdkTurnResult>;
  cancel?(): Promise<void>;
  stop?(): Promise<void>;
  kill?(): Promise<void>;
  abort?(): Promise<void>;
  archive?(): Promise<{ archivedAt: string }>;
  timeline?: { refetch(options?: Record<string, unknown>): Promise<unknown> };
}

interface PaseoSdkClient {
  readonly agents: {
    create(options: Record<string, unknown>): Promise<PaseoSdkAgentHandle>;
    ref(agentId: string): PaseoSdkAgentHandle;
    list(options?: Record<string, unknown>): Promise<{ entries: Array<{ agent: Record<string, unknown> }> }>;
  };
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface PaseoSdkModule {
  createPaseoClient(config: { url: string; clientId?: string; password?: string }): PaseoSdkClient;
}

export class PaseoSdkUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaseoSdkUnavailableError";
  }
}

export class PaseoSdkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaseoSdkTimeoutError";
  }
}

export async function connectPaseoClient(
  client: { connect(): Promise<void> },
  timeoutMs = 15_000
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PaseoSdkTimeoutError(`Connecting to the Paseo daemon timed out after ${timeoutMs}ms.`)),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PaseoSdkUnavailableError(`Unable to connect to the Paseo daemon through @getpaseo/client: ${message}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createPaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const effective = await withStructuredResultSink(root, options, Boolean(options.prompt !== undefined && options.outputSchema));
  const result = await withPaseoClient(root, async (client) => createPaseoSdkAgentWithClient(client, effective));
  await bindStructuredResultFromOptions(root, effective, result.id);
  return projectAcceptedPaseoResult(root, result, structuredResultExpectation(effective.labels));
}

export async function materializePaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const effective = await withStructuredResultSink(root, options, false);
  const result = await withPaseoClient(root, async (client) => materializePaseoSdkAgentWithClient(client, effective));
  await bindStructuredResultFromOptions(root, effective, result.id);
  return result;
}

export async function materializePaseoSdkAgentWithClient(client: PaseoSdkClient, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const handle = await client.agents.create(buildCreateOptions(options, false));
  return handleResult(handle);
}

export async function createPaseoSdkAgentWithClient(client: PaseoSdkClient, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const handle = await client.agents.create(buildCreateOptions(options, options.prompt !== undefined));
  if (options.prompt !== undefined && options.waitForFinish !== false) {
    const result = await waitForHandle(handle, options.timeoutMs);
    if (result.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return result;
  }
  return handleResult(handle);
}

export async function dispatchPaseoSdkAgent(root: string, agentId: string, prompt: string, timeoutMs?: number): Promise<PaseoSdkAgentResult> {
  return withPaseoClient(root, (client) => dispatchPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs));
}

export async function dispatchPaseoSdkAgentWithClient(client: PaseoSdkClient, agentId: string, prompt: string, timeoutMs?: number): Promise<PaseoSdkAgentResult> {
  const handle = client.agents.ref(agentId);
  if (typeof handle.send === "function") {
    try {
      await withTimeout(handle.send(prompt), timeoutMs, `Paseo agent ${agentId} dispatch timed out after ${timeoutMs ?? 1_800_000}ms.`);
    } catch (error) {
      if (error instanceof PaseoSdkTimeoutError) await stopPaseoSdkAgentHandle(handle);
      throw error;
    }
    return { ...handleResult(handle), status: statusText(handle.status) ?? "working" };
  }
  if (typeof handle.run === "function") {
    const turn = await handle.run(prompt, { timeoutMs });
    if (turn.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return turnResult(handle, turn);
  }
  throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither send() nor run(); cannot dispatch a turn through the SDK.");
}

export async function waitPaseoSdkAgent(root: string, agentId: string, timeoutMs?: number): Promise<PaseoSdkAgentResult> {
  const result = await withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    const result = await waitForHandle(handle, timeoutMs);
    if (result.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return result;
  });
  return projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
}

/** Execute one resumed turn on one concrete SDK handle. Prefer the SDK's atomic
 * run() primitive so dispatch and completion observation cannot be separated by
 * an idle->running->idle race. Older SDKs fall back to send()+waitForFinish()
 * on the same handle/client. Structured output constraints accompany the turn
 * when provided. When the session has an AEH structured-result capability, the
 * accepted durable result artifact is projected back into lastMessage so legacy
 * consumers remain compatible without making transcript text lifecycle authority. */
export async function runPaseoSdkAgent(
  root: string,
  agentId: string,
  prompt: string,
  timeoutMs?: number,
  outputSchema?: Record<string, unknown>
): Promise<PaseoSdkAgentResult> {
  if (outputSchema) await activateStructuredResultTurnForAgent(root, agentId);
  const result = await withPaseoClient(root, async (client) =>
    runPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs, outputSchema)
  );
  return projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
}

export async function runPaseoSdkAgentWithClient(
  client: PaseoSdkClient,
  agentId: string,
  prompt: string,
  timeoutMs?: number,
  outputSchema?: Record<string, unknown>
): Promise<PaseoSdkAgentResult> {
  const handle = client.agents.ref(agentId);
  if (typeof handle.run === "function") {
    const turn = await handle.run(prompt, { timeoutMs, ...(outputSchema ? { outputSchema } : {}) });
    if (turn.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return turnResult(handle, turn);
  }
  if (typeof handle.send === "function") {
    await withTimeout(handle.send(prompt, outputSchema ? { outputSchema } : undefined), timeoutMs, `Paseo agent ${agentId} turn dispatch timed out after ${timeoutMs ?? 1_800_000}ms.`).catch(async (error) => {
      if (error instanceof PaseoSdkTimeoutError) await stopPaseoSdkAgentHandle(handle);
      throw error;
    });
    const result = await waitForHandle(handle, timeoutMs);
    if (result.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return result;
  }
  throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither run() nor send(); cannot execute an atomic resumed turn through the SDK.");
}

export async function archivePaseoSdkAgent(root: string, agentId: string): Promise<void> {
  return withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    if (typeof handle.archive !== "function") throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle does not expose archive().");
    await handle.archive();
  });
}

export async function inspectPaseoSdkAgent(root: string, agentId: string): Promise<PaseoSdkAgentRecord | undefined> {
  return withPaseoClient(root, async (client) => {
    const raw = await refreshHandle(client.agents.ref(agentId));
    return raw ? normalizeRecord(raw) : undefined;
  });
}

export async function inspectPaseoSdkAgentTimeline(root: string, agentId: string): Promise<unknown[] | undefined> {
  return withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    if (!handle.timeline || typeof handle.timeline.refetch !== "function") return undefined;
    const result = await handle.timeline.refetch({ direction: "backward", limit: 100 });
    return extractTimelineEntries(result);
  });
}

export async function probePaseoSdkAgent(root: string, agentId: string): Promise<boolean> {
  return Boolean(await inspectPaseoSdkAgent(root, agentId));
}

export async function listPaseoSdkAgents(root: string, labels: Record<string, string> = {}): Promise<PaseoSdkAgentRecord[]> {
  return withPaseoClient(root, async (client) => {
    const filter: Record<string, unknown> = { includeArchived: false };
    if (Object.keys(labels).length) filter.labels = labels;
    if (typeof client.agents.list !== "function") throw new PaseoSdkUnavailableError("The active @getpaseo/client does not expose agents.list().");
    const page = await client.agents.list({ filter });
    return page.entries.map((entry) => normalizeRecord(entry.agent)).filter((agent) => labelsMatch(agent.labels, labels));
  });
}

async function withStructuredResultSink(root: string, options: PaseoSdkAgentOptions, activateInitialTurn: boolean): Promise<PaseoSdkAgentOptions> {
  const contract = options.labels?.["aeh.output.contract"]?.trim();
  const operationId = options.labels?.["aeh.operation"]?.trim();
  const logicalAgent = options.labels?.["aeh.role"]?.trim();
  if (!contract || !operationId || !logicalAgent) return options;
  const operationRevision = Number(options.labels?.["aeh.operation.revision"]);
  const supervisorGeneration = Number(options.labels?.["aeh.supervisor.generation"]);
  const taskId = options.labels?.["aeh.task"]?.trim();
  const role = options.labels?.["aeh.canonical.role"]?.trim();
  const rawBinding = options.labels?.["aeh.execution.binding"];
  if (!rawBinding) {
    const pendingChannelId = options.labels?.["aeh.result.channel"]?.trim();
    if (options.labels?.["aeh.execution.binding.phase"] !== "PENDING_SESSION" || !pendingChannelId) {
      throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry a complete versioned binding or an inert pending-session channel.");
    }
    const pending = await loadStructuredResultChannel(root, operationId, pendingChannelId);
    if (pending.operationId !== operationId || pending.logicalAgent !== logicalAgent || pending.role !== role || pending.taskId !== taskId || pending.contract !== contract || pending.provenance.status !== "UNSUPPORTED" || pending.agentId || pending.activeTurn || !options.mcpServers?.["aeh-result"] || !options.toolPolicy?.preapproved.some((item) => item.kind === "mcp" && item.server === "aeh-result" && item.tool === "aeh_submit_result")) {
      throw new Error("AEH_RESULT_PROVENANCE: pending Paseo result channel is not inert or does not match the launch contract.");
    }
    return options;
  }
  const provenance = parseStructuredResultProvenance(options.labels?.["aeh.result.provenance"], {
    operationId,
    logicalAgent,
    role,
    taskId,
    contract
  });
  if (!rawBinding || !provenance.executionBinding || rawBinding !== JSON.stringify(provenance.executionBinding) || options.labels?.["aeh.execution.binding.digest"] !== provenance.executionBinding.digest) throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry the complete versioned binding in its launch labels.");
  const channel = await provisionStructuredResultChannel(root, {
    operationId,
    logicalAgent,
    role,
    taskId,
    contract,
    operationRevision: Number.isInteger(operationRevision) ? operationRevision : undefined,
    supervisorGeneration: Number.isInteger(supervisorGeneration) ? supervisorGeneration : undefined,
    provenance
  });
  if (activateInitialTurn) await activateStructuredResultTurn(root, operationId, channel.channelId, options.labels?.["aeh.operation.phase"]);
  const server = "aeh-result";
  const preapproved = [
    ...(options.toolPolicy?.preapproved ?? []).filter((item) => !(item.kind === "mcp" && item.server === server && item.tool === "aeh_submit_result")),
    { kind: "mcp" as const, server, tool: "aeh_submit_result" }
  ];
  return {
    ...options,
    labels: { ...options.labels, "aeh.result.channel": channel.channelId },
    mcpServers: { ...(options.mcpServers ?? {}), [server]: resultSinkMcpServerDefinition(root, operationId, channel.channelId) },
    toolPolicy: { preapproved }
  };
}

async function bindStructuredResultFromOptions(root: string, options: PaseoSdkAgentOptions, agentId: string): Promise<void> {
  const operationId = options.labels?.["aeh.operation"]?.trim();
  const channelId = options.labels?.["aeh.result.channel"]?.trim();
  if (!operationId || !channelId) return;
  await bindStructuredResultChannel(root, operationId, channelId, agentId);
}

async function projectAcceptedPaseoResult(root: string, result: PaseoSdkAgentResult, expected: StructuredResultExpectation = { requireBoundProvenance: true, verifyCurrentCandidate: true }): Promise<PaseoSdkAgentResult> {
  const accepted = await acceptedStructuredResultForAgent(root, result.id, expected).catch(() => undefined);
  return accepted ? { ...result, lastMessage: JSON.stringify(accepted.payload) } : result;
}

function parseStructuredResultProvenance(
  raw: string | undefined,
  identity: { operationId: string; logicalAgent: string; role?: string; taskId?: string; contract: string }
): StructuredResultProvenanceV1 {
  if (raw) {
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label is not valid JSON."); }
    const provenance = value as StructuredResultProvenanceV1;
    if (!provenance || provenance.version !== 1 || provenance.operationId !== identity.operationId || provenance.logicalAgent !== identity.logicalAgent || provenance.role !== identity.role || provenance.taskId !== identity.taskId || provenance.outputContract !== identity.contract) {
      throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label does not match operation/participant/task/contract labels.");
    }
    return provenance;
  }
  throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launches must propagate a complete versioned StructuredResultProvenance before session creation.");
}

function structuredResultExpectation(labels: Record<string, string> | undefined): StructuredResultExpectation {
  const operationId = labels?.["aeh.operation"];
  const logicalAgent = labels?.["aeh.role"];
  const raw = labels?.["aeh.result.provenance"];
  if (!operationId || !logicalAgent || !raw) return { requireBoundProvenance: true, verifyCurrentCandidate: true };
  return {
    operationId,
    logicalAgent,
    role: labels?.["aeh.canonical.role"],
    taskId: labels?.["aeh.task"],
    contract: labels?.["aeh.output.contract"],
    provenance: parseStructuredResultProvenance(raw, { operationId, logicalAgent, role: labels?.["aeh.canonical.role"], taskId: labels?.["aeh.task"], contract: labels?.["aeh.output.contract"] ?? "" }),
    requireBoundProvenance: true,
    verifyCurrentCandidate: true
  };
}

async function withPaseoClient<T>(root: string, action: (client: PaseoSdkClient) => Promise<T>): Promise<T> {
  const sdk = await loadPaseoSdk(root);
  const client = sdk.createPaseoClient({
    url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
    clientId: `aeh-${process.pid}`,
    password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
  });
  try {
    await connectPaseoClient(client);
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadPaseoSdk(root: string): Promise<PaseoSdkModule> {
  const bundled = await resolvePaseoSdkFromCli(root);
  if (bundled.resolved) {
    try {
      const sdk = (await import(pathToFileURL(bundled.resolved).href)) as unknown as PaseoSdkModule;
      if (typeof sdk.createPaseoClient === "function") return sdk;
    } catch (error) { bundled.diagnostics.push(`bundled import: ${String(error)}`); }
  }
  const packageName = "@getpaseo/client";
  let directError: unknown;
  try {
    const direct = (await import(packageName)) as unknown as PaseoSdkModule;
    if (typeof direct.createPaseoClient === "function") return direct;
  } catch (error) { directError = error; }
  const detail = bundled.diagnostics.length ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.` : "";
  throw new PaseoSdkUnavailableError(`@getpaseo/client could not be resolved from the active Paseo CLI installation or directly.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`, { cause: directError });
}

function buildCreateOptions(options: PaseoSdkAgentOptions, includePrompt: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = { provider: providerModelForSdk(options.provider, options.model) };
  if (options.modeId) config.modeId = options.modeId;
  if (options.thinkingOptionId) config.thinkingOptionId = options.thinkingOptionId;
  if (options.systemPrompt) config.systemPrompt = options.systemPrompt;
  if (options.mcpServers && Object.keys(options.mcpServers).length) config.mcpServers = options.mcpServers;
  if (options.toolPolicy?.preapproved.length) config.toolPolicy = options.toolPolicy;

  const createOptions: Record<string, unknown> = { config, title: options.title, cwd: options.cwd };
  if (options.agentId) createOptions.agentId = options.agentId;
  if (options.env && Object.keys(options.env).length) createOptions.env = options.env;
  if (options.workspaceId) createOptions.workspaceId = options.workspaceId;
  if (options.parentAgentId) createOptions.parent = options.parentAgentId;
  if (includePrompt && options.prompt !== undefined) createOptions.initialPrompt = options.prompt;
  if (options.outputSchema) createOptions.outputSchema = options.outputSchema;
  if (options.labels && Object.keys(options.labels).length) createOptions.labels = options.labels;
  return createOptions;
}

async function waitForHandle(handle: PaseoSdkAgentHandle, timeoutMs = 1_800_000): Promise<PaseoSdkAgentResult> {
  if (typeof handle.waitForFinish === "function") {
    const turn = await handle.waitForFinish(timeoutMs);
    return turnResult(handle, turn);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await refreshHandle(handle);
    const status = statusText(raw?.status ?? handle.status);
    if (isTerminalStatus(status)) {
      const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
        ? await handle.timeline.refetch({ direction: "backward", limit: 50 }).catch(() => undefined)
        : undefined;
      return {
        id: handle.id,
        workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
        status,
        lastMessage: stringField(raw ?? {}, ["lastMessage", "last_message"]) ?? extractLastAssistantText(timeline),
        error: stringField(raw ?? {}, ["error", "lastError", "last_error"])
      };
    }
    if (Date.now() >= deadline) return { id: handle.id, workspaceId: handle.workspaceId ?? undefined, status: "timeout", error: `Timed out after ${timeoutMs}ms.` };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function stopPaseoSdkAgentHandle(handle: PaseoSdkAgentHandle): Promise<void> {
  for (const method of [handle.cancel, handle.stop, handle.kill, handle.abort]) {
    if (typeof method !== "function") continue;
    await method.call(handle);
    return;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1_800_000, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new PaseoSdkTimeoutError(message)), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function turnResult(handle: PaseoSdkAgentHandle, turn: PaseoSdkTurnResult): Promise<PaseoSdkAgentResult> {
  if (turn.lastMessage) {
    return {
      id: handle.id,
      workspaceId: handle.workspaceId ?? undefined,
      status: turn.status,
      lastMessage: turn.lastMessage,
      error: turn.error
    };
  }
  const raw = await refreshHandle(handle).catch(() => undefined);
  const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
    ? await handle.timeline.refetch({ direction: "backward", limit: 50 }).catch(() => undefined)
    : undefined;
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
    status: turn.status || statusText(raw?.status ?? handle.status),
    lastMessage:
      stringField(raw ?? {}, ["lastMessage", "last_message"]) ??
      extractLastAssistantText(timeline),
    error: turn.error ?? stringField(raw ?? {}, ["error", "lastError", "last_error"])
  };
}

async function refreshHandle(handle: PaseoSdkAgentHandle): Promise<Record<string, unknown> | undefined> {
  if (typeof handle.refetch === "function") return (await handle.refetch())?.agent;
  if (typeof handle.refresh === "function") return (await handle.refresh())?.agent;
  return handle.latest?.() ?? undefined;
}

function handleResult(handle: PaseoSdkAgentHandle): PaseoSdkAgentResult {
  const raw = handle.latest?.() ?? undefined;
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
    status: statusText(raw?.status ?? handle.status)
  };
}

function providerModelForSdk(provider: string, model?: string): string {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) throw new Error("Paseo SDK requires a provider.");
  const separator = normalizedProvider.indexOf("/");
  if (separator < 0) {
    const explicitModel = model?.trim();
    if (!explicitModel) throw new Error("Paseo SDK requires a provider/model value.");
    return `${normalizedProvider}/${explicitModel}`;
  }
  const providerId = normalizedProvider.slice(0, separator).trim();
  const embeddedModel = normalizedProvider.slice(separator + 1).trim();
  if (!providerId || !embeddedModel) throw new Error(`Invalid Paseo provider/model value '${provider}'. Expected '<provider>/<model>'.`);
  const explicitModel = model?.trim();
  if (explicitModel && explicitModel !== embeddedModel) throw new Error(`Conflicting Paseo models: provider value '${provider}' embeds '${embeddedModel}' but explicit model is '${explicitModel}'.`);
  return `${providerId}/${embeddedModel}`;
}

function normalizeRecord(raw: Record<string, unknown>): PaseoSdkAgentRecord {
  const id = stringField(raw, ["id", "agentId", "agent_id"]);
  if (!id) throw new Error("Paseo SDK returned an agent without an id.");
  return { id, title: stringField(raw, ["title", "name"]), status: statusText(raw.status), workspaceId: stringField(raw, ["workspaceId", "workspace_id"]), labels: recordOfStrings(raw.labels), raw };
}

function extractLastAssistantText(value: unknown): string | undefined {
  const candidates: string[] = [];
  visit(value, false, candidates);
  return candidates.at(-1);
}

function visit(value: unknown, assistantContext: boolean, out: string[]): void {
  if (Array.isArray(value)) { for (const item of value) visit(item, assistantContext, out); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const role = String(record.role ?? record.author ?? record.kind ?? record.type ?? "").toLowerCase();
  const assistant = assistantContext || role.includes("assistant");
  if (assistant) {
    for (const key of ["text", "content", "message", "lastMessage"]) if (typeof record[key] === "string" && record[key]) out.push(record[key] as string);
  }
  for (const child of Object.values(record)) visit(child, assistant, out);
}

function labelsMatch(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}
function isTerminalStatus(value?: string): boolean {
  return value === "idle" || value === "finished" || value === "completed" || value === "failed" || value === "error" || value === "timeout" || value === "cancelled";
}
function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}
function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") result[key] = item;
  return Object.keys(result).length ? result : undefined;
}
function statusText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>).status;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function extractTimelineEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["entries", "items", "events", "messages"]) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}
