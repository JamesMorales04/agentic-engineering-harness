import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runProcess } from "../utils/process.js";

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
  const config: Record<string, unknown> = { provider: providerModel(options.provider, options.model) };
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
  const packageName = "@getpaseo/client";
  let directError: unknown;
  try {
    const direct = await import(packageName) as unknown as PaseoSdkModule;
    if (typeof direct.createPaseoClient === "function") return direct;
  } catch (error) { directError = error; }

  const located = await runProcess("command -v paseo", { cwd: root, timeoutMs: 15_000 });
  const executable = located.exitCode === 0 ? located.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : undefined;
  if (executable) {
    const real = await fs.realpath(executable).catch(() => executable);
    for (const start of [...new Set([path.dirname(real), path.dirname(executable)])]) {
      let current = start;
      for (let depth = 0; depth < 10; depth += 1) {
        try {
          const resolver = createRequire(path.join(current, "__aeh_paseo_sdk_loader__.cjs"));
          const resolved = resolver.resolve(packageName);
          const bundled = await import(pathToFileURL(resolved).href) as unknown as PaseoSdkModule;
          if (typeof bundled.createPaseoClient === "function") return bundled;
        } catch { /* walk toward the managed npm installation root */ }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }

  throw new PaseoSdkUnavailableError(
    `@getpaseo/client could not be resolved directly or from the managed Paseo CLI installation.${directError ? ` Direct import: ${String(directError)}` : ""}`,
    { cause: directError }
  );
}

function providerModel(provider: string, model?: string): string {
  if (provider.includes("/")) return provider;
  if (!model) throw new Error(`Paseo SDK requires an explicit model for provider '${provider}'.`);
  return `${provider}/${model}`;
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
