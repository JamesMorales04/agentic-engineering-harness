import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";

export interface PaseoSdkAgentOptions {
  cwd: string;
  workspaceId?: string;
  provider: string;
  model?: string;
  title: string;
  systemPrompt?: string;
  prompt?: string;
  outputSchema?: Record<string, unknown>;
  labels?: Record<string, string>;
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
  readonly workspaceId: string | null;
  readonly status: unknown;
  refresh(requestId?: string): Promise<{ agent: Record<string, unknown>; project: unknown } | null>;
  run(text: string, options?: { timeoutMs?: number }): Promise<PaseoSdkTurnResult>;
  waitForFinish(timeoutMs?: number): Promise<PaseoSdkTurnResult>;
}

interface PaseoSdkWorkspaceHandle {
  readonly agents: { create(options: Record<string, unknown>): Promise<PaseoSdkAgentHandle> };
}

interface PaseoSdkClient {
  readonly agents: {
    create(options: Record<string, unknown>): Promise<PaseoSdkAgentHandle>;
    ref(agentId: string): PaseoSdkAgentHandle;
    list(options?: Record<string, unknown>): Promise<{ entries: Array<{ agent: Record<string, unknown> }> }>;
  };
  readonly workspaces: { ref(workspaceId: string): PaseoSdkWorkspaceHandle };
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

export async function createPaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  return withPaseoClient(root, async (client) => createPaseoSdkAgentWithClient(client, options));
}

export async function createPaseoSdkAgentWithClient(client: PaseoSdkClient, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const config: Record<string, unknown> = normalizeProviderModel(options.provider, options.model);
  if (options.systemPrompt) config.systemPrompt = options.systemPrompt;
  const createOptions: Record<string, unknown> = { config, title: options.title };
  if (options.prompt !== undefined) createOptions.prompt = options.prompt;
  if (options.outputSchema) createOptions.outputSchema = options.outputSchema;
  if (options.labels && Object.keys(options.labels).length) createOptions.labels = options.labels;

  // Intentionally omit `parent`: AEH run/task labels own lifecycle relationships.
  // Workspace placement does not imply parentage in the Paseo SDK.
  const handle = options.workspaceId
    ? await client.workspaces.ref(options.workspaceId).agents.create(createOptions)
    : await client.agents.create({ ...createOptions, cwd: options.cwd });

  if (options.prompt !== undefined && options.waitForFinish !== false) {
    const turn = await handle.waitForFinish(options.timeoutMs);
    return {
      id: handle.id,
      workspaceId: handle.workspaceId ?? undefined,
      status: turn.status,
      lastMessage: turn.lastMessage,
      error: turn.error
    };
  }
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? undefined,
    status: statusText(handle.status)
  };
}

export async function runPaseoSdkAgent(root: string, agentId: string, prompt: string, timeoutMs?: number): Promise<PaseoSdkAgentResult> {
  return withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    const turn = await handle.run(prompt, { timeoutMs });
    return { id: agentId, workspaceId: handle.workspaceId ?? undefined, status: turn.status, lastMessage: turn.lastMessage, error: turn.error };
  });
}

export async function inspectPaseoSdkAgent(root: string, agentId: string): Promise<PaseoSdkAgentRecord | undefined> {
  return withPaseoClient(root, async (client) => {
    const refreshed = await client.agents.ref(agentId).refresh();
    return refreshed ? normalizeRecord(refreshed.agent) : undefined;
  });
}

export async function probePaseoSdkAgent(root: string, agentId: string): Promise<boolean> {
  return Boolean(await inspectPaseoSdkAgent(root, agentId));
}

export async function listPaseoSdkAgents(root: string, labels: Record<string, string> = {}): Promise<PaseoSdkAgentRecord[]> {
  return withPaseoClient(root, async (client) => {
    const filter: Record<string, unknown> = { includeArchived: false };
    if (Object.keys(labels).length) filter.labels = labels;
    const page = await client.agents.list({ filter });
    return page.entries.map((entry) => normalizeRecord(entry.agent)).filter((agent) => labelsMatch(agent.labels, labels));
  });
}

async function withPaseoClient<T>(root: string, action: (client: PaseoSdkClient) => Promise<T>): Promise<T> {
  const sdk = await loadPaseoSdk(root);
  const client = sdk.createPaseoClient({
    url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
    clientId: `aeh-${process.pid}`,
    password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
  });
  try {
    try { await client.connect(); }
    catch (error) { throw new PaseoSdkUnavailableError(`Unable to connect to the Paseo daemon through @getpaseo/client: ${String(error)}`, { cause: error }); }
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadPaseoSdk(root: string): Promise<PaseoSdkModule> {
  // Prefer the client bundled with the active Paseo CLI. Paseo currently ships
  // @getpaseo/client as an exact-version dependency of @getpaseo/cli, while the
  // client SDK is explicitly not API-stable yet. Loading the co-installed copy
  // therefore avoids protocol/API drift between an independently resolved SDK
  // and the daemon that the active CLI starts.
  const bundled = await resolvePaseoSdkFromCli(root);
  if (bundled.resolved) {
    try {
      const sdk = await import(pathToFileURL(bundled.resolved).href) as unknown as PaseoSdkModule;
      if (typeof sdk.createPaseoClient === "function") return sdk;
    } catch (error) {
      bundled.diagnostics.push(`bundled import: ${String(error)}`);
    }
  }

  // Compatibility fallback for installations that intentionally provide the
  // SDK directly alongside AEH instead of through the Paseo CLI package. Keep
  // the package specifier non-literal so TypeScript does not require this
  // optional runtime package to be installed while compiling AEH.
  const packageName = "@getpaseo/client";
  let directError: unknown;
  try {
    const direct = await import(packageName) as unknown as PaseoSdkModule;
    if (typeof direct.createPaseoClient === "function") return direct;
  } catch (error) { directError = error; }

  const detail = bundled.diagnostics.length ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.` : "";
  throw new PaseoSdkUnavailableError(
    `@getpaseo/client could not be resolved from the active Paseo CLI installation or directly.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`,
    { cause: directError }
  );
}

function normalizeProviderModel(provider: string, model?: string): Record<string, string> {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) throw new Error("Paseo SDK requires a provider.");

  const separator = normalizedProvider.indexOf("/");
  if (separator < 0) {
    if (!model?.trim()) throw new Error(`Paseo SDK requires an explicit model for provider '${normalizedProvider}'.`);
    return { provider: normalizedProvider, model: model.trim() };
  }

  const providerId = normalizedProvider.slice(0, separator).trim();
  const embeddedModel = normalizedProvider.slice(separator + 1).trim();
  if (!providerId || !embeddedModel) {
    throw new Error(`Invalid Paseo provider/model value '${provider}'. Expected '<provider>/<model>'.`);
  }

  const explicitModel = model?.trim();
  if (explicitModel && explicitModel !== embeddedModel) {
    throw new Error(`Conflicting Paseo models: provider value '${provider}' embeds '${embeddedModel}' but explicit model is '${explicitModel}'.`);
  }
  return { provider: providerId, model: explicitModel || embeddedModel };
}

function normalizeRecord(raw: Record<string, unknown>): PaseoSdkAgentRecord {
  const id = stringField(raw, ["id", "agentId", "agent_id"]);
  if (!id) throw new Error("Paseo SDK returned an agent without an id.");
  const labels = recordOfStrings(raw.labels);
  return {
    id,
    title: stringField(raw, ["title", "name"]),
    status: statusText(raw.status),
    workspaceId: stringField(raw, ["workspaceId", "workspace_id"]),
    labels,
    raw
  };
}

function labelsMatch(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}
function stringField(record: Record<string, unknown>, keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function recordOfStrings(value: unknown): Record<string, string> | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") result[key] = item; return Object.keys(result).length ? result : undefined; }
function statusText(value: unknown): string | undefined { if (typeof value === "string") return value; if (value && typeof value === "object") { const nested = (value as Record<string, unknown>).status; if (typeof nested === "string") return nested; } return undefined; }
