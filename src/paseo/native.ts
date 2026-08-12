import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";
import { PaseoSdkUnavailableError } from "./sdk.js";
import { recordPaseoTrace } from "./trace.js";

export interface PaseoNativeUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface PaseoNativeAgentSnapshot {
  id: string;
  status?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  lastUsage?: PaseoNativeUsage;
  raw: Record<string, unknown>;
}

export interface PaseoContextUsageSnapshot {
  used?: number;
  limit?: number;
  ratio?: number;
  source: "paseo-agent-snapshot";
  availability: "available" | "no-usage-yet" | "provider-usage-unavailable";
}

export interface PaseoProviderPreflightResult {
  ok: boolean;
  provider: string;
  model?: string;
  providerStatus?: string;
  availableModels?: string[];
  source: "paseo-provider-snapshot" | "paseo-provider-models" | "paseo-provider-diagnostic" | "paseo-provider-unchecked";
  message: string;
}

export interface PaseoNativeWaitResult {
  id: string;
  workspaceId?: string;
  status?: string;
  lastMessage?: string;
  error?: string;
  source: "paseo-agent-subscription";
  updatesObserved: number;
}

interface NativeAgentHandle {
  readonly id: string;
  latest?(): Record<string, unknown> | null;
  refetch?(requestId?: string): Promise<{ agent: Record<string, unknown>; project?: unknown } | null>;
  refresh?(requestId?: string): Promise<{ agent: Record<string, unknown>; project?: unknown } | null>;
  subscribe?(handler: (update: unknown) => void): () => void;
  timeline?: { refetch(options?: Record<string, unknown>): Promise<unknown> };
}

interface NativePaseoClient {
  agents: { ref(agentId: string): NativeAgentHandle };
  providers?: {
    snapshot?(options?: Record<string, unknown>): Promise<unknown>;
    listModels?(provider: string, options?: Record<string, unknown>): Promise<unknown>;
    listAvailable?(options?: Record<string, unknown>): Promise<unknown>;
    diagnostic?(provider: string, options?: Record<string, unknown>): Promise<unknown>;
  };
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface NativePaseoModule {
  createPaseoClient(config: { url: string; clientId?: string; password?: string }): NativePaseoClient;
}

export async function inspectPaseoNativeAgent(root: string, agentId: string): Promise<PaseoNativeAgentSnapshot | undefined> {
  return withNativeClient(root, async (client) => {
    const raw = await refetchAgent(client.agents.ref(agentId));
    if (!raw) return undefined;
    const snapshot = normalizePaseoNativeAgent(raw);
    await recordPaseoTrace(root, "agent.snapshot", {
      agentId,
      status: snapshot.status ?? "unknown",
      hasUsage: Boolean(snapshot.lastUsage),
      contextWindowUsedTokens: snapshot.lastUsage?.contextWindowUsedTokens ?? -1,
      contextWindowMaxTokens: snapshot.lastUsage?.contextWindowMaxTokens ?? -1
    });
    return snapshot;
  });
}

export function normalizePaseoNativeAgent(raw: Record<string, unknown>): PaseoNativeAgentSnapshot {
  const id = stringField(raw, ["id", "agentId", "agent_id"]);
  if (!id) throw new Error("Paseo agent snapshot does not contain an id.");
  return {
    id,
    status: statusText(raw.status),
    workspaceId: stringField(raw, ["workspaceId", "workspace_id"]),
    labels: stringRecord(raw.labels),
    lastUsage: parseUsage(raw.lastUsage),
    raw
  };
}

export function contextUsageFromPaseoSnapshot(snapshot: PaseoNativeAgentSnapshot): PaseoContextUsageSnapshot {
  if (!snapshot.lastUsage) {
    return { source: "paseo-agent-snapshot", availability: "no-usage-yet" };
  }
  const used = finiteNonNegative(snapshot.lastUsage.contextWindowUsedTokens);
  const limit = finitePositive(snapshot.lastUsage.contextWindowMaxTokens);
  if (used === undefined || limit === undefined) {
    return { used, limit, source: "paseo-agent-snapshot", availability: "provider-usage-unavailable" };
  }
  return {
    used,
    limit,
    ratio: Math.min(used / limit, 1),
    source: "paseo-agent-snapshot",
    availability: "available"
  };
}

export async function preflightPaseoProviderModel(
  root: string,
  providerValue: string,
  modelValue?: string,
  cwd = root
): Promise<PaseoProviderPreflightResult> {
  const { provider, model } = normalizeProviderModel(providerValue, modelValue);
  return withNativeClient(root, async (client) => {
    const providers = client.providers;
    if (!providers) throw new PaseoSdkUnavailableError("The active Paseo SDK does not expose provider APIs required for preflight.");

    let entry: Record<string, unknown> | undefined;
    if (typeof providers.snapshot === "function") {
      try {
        const snapshot = await providers.snapshot({ cwd });
        entry = findProviderEntry(snapshot, provider);
      } catch (error) {
        await recordPaseoTrace(root, "provider.preflight.snapshot_error", { provider, model: model ?? "", error: String(error) });
      }
    }

    const providerStatus = entry ? stringField(entry, ["status"]) : undefined;
    const enabled = entry?.enabled;
    if (enabled === false || providerStatus === "error" || providerStatus === "unavailable") {
      const diagnostic = await providerDiagnostic(providers, provider);
      const result: PaseoProviderPreflightResult = {
        ok: false,
        provider,
        model,
        providerStatus,
        source: diagnostic ? "paseo-provider-diagnostic" : "paseo-provider-snapshot",
        message: diagnostic || `Provider ${provider} is ${enabled === false ? "disabled" : providerStatus}.`
      };
      await tracePreflight(root, result);
      return result;
    }

    let models = modelIds(entry?.models);
    let source: PaseoProviderPreflightResult["source"] = entry ? "paseo-provider-snapshot" : "paseo-provider-unchecked";
    if (model && models.length === 0 && typeof providers.listModels === "function") {
      try {
        const listed = await providers.listModels(provider, { cwd });
        models = modelIds(recordField(listed, "models") ?? listed);
        source = "paseo-provider-models";
      } catch (error) {
        const diagnostic = await providerDiagnostic(providers, provider);
        const result: PaseoProviderPreflightResult = {
          ok: false,
          provider,
          model,
          providerStatus,
          source: diagnostic ? "paseo-provider-diagnostic" : "paseo-provider-models",
          message: diagnostic || `Paseo could not list models for provider ${provider}: ${String(error)}`
        };
        await tracePreflight(root, result);
        return result;
      }
    }

    if (model && models.length > 0 && !models.includes(model)) {
      const result: PaseoProviderPreflightResult = {
        ok: false,
        provider,
        model,
        providerStatus,
        availableModels: models,
        source,
        message: `Model ${provider}/${model} is not present in Paseo's current provider catalog.`
      };
      await tracePreflight(root, result);
      return result;
    }

    const result: PaseoProviderPreflightResult = {
      ok: true,
      provider,
      model,
      providerStatus,
      availableModels: models.length ? models : undefined,
      source,
      message: models.length || entry ? `Provider ${provider}${model ? ` model ${model}` : ""} passed Paseo preflight.` : `Paseo provider preflight had no catalog snapshot for ${provider}; agent creation remains authoritative.`
    };
    await tracePreflight(root, result);
    return result;
  });
}

export async function waitForPaseoAgentNative(root: string, agentId: string, timeoutMs = 1_800_000): Promise<PaseoNativeWaitResult> {
  return withNativeClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    if (typeof handle.subscribe !== "function") {
      throw new PaseoSdkUnavailableError("The active Paseo SDK agent handle does not expose subscribe(); event-driven waiting is unavailable.");
    }
    const startedAt = Date.now();
    const result = await waitForPaseoAgentHandle(handle, timeoutMs);
    await recordPaseoTrace(root, "agent.wait", {
      agentId,
      source: result.source,
      status: result.status ?? "unknown",
      updatesObserved: result.updatesObserved,
      durationMs: Date.now() - startedAt
    });
    return result;
  });
}

export async function waitForPaseoAgentHandle(handle: NativeAgentHandle, timeoutMs = 1_800_000): Promise<PaseoNativeWaitResult> {
  let updatesObserved = 0;
  let sawActivity = false;
  let settled = false;
  let unsubscribe = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();

  return new Promise<PaseoNativeWaitResult>((resolve, reject) => {
    const finish = (value: PaseoNativeWaitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      reject(error);
    };
    const inspect = async (fromUpdate: boolean) => {
      const raw = await refetchAgent(handle);
      if (!raw || settled) return;
      const status = statusText(raw.status);
      if (fromUpdate) updatesObserved += 1;
      if (fromUpdate || isActiveStatus(status) || Boolean(raw.activeTurn)) sawActivity = true;
      if (!isTerminalStatus(status) || (status === "idle" && !sawActivity)) return;
      const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
        ? await handle.timeline.refetch({ direction: "backward", limit: 50 }).catch(() => undefined)
        : undefined;
      finish({
        id: handle.id,
        workspaceId: stringField(raw, ["workspaceId", "workspace_id"]),
        status,
        lastMessage: stringField(raw, ["lastMessage", "last_message"]) ?? extractLastAssistantText(timeline),
        error: stringField(raw, ["error", "lastError", "last_error"]),
        source: "paseo-agent-subscription",
        updatesObserved
      });
    };

    try {
      unsubscribe = handle.subscribe!(() => {
        chain = chain.then(() => inspect(true)).catch(fail);
      });
    } catch (error) {
      fail(error);
      return;
    }

    // Subscribe first, then refetch. This closes the event/refetch race: a state
    // transition between those operations is either observed by the subscription
    // or represented by the fresh snapshot.
    chain = chain.then(() => inspect(false)).catch(fail);
    timer = setTimeout(() => finish({
      id: handle.id,
      status: "timeout",
      error: `Timed out after ${timeoutMs}ms.`,
      source: "paseo-agent-subscription",
      updatesObserved
    }), timeoutMs);
  });
}

async function withNativeClient<T>(root: string, action: (client: NativePaseoClient) => Promise<T>): Promise<T> {
  const sdk = await loadNativeSdk(root);
  const client = sdk.createPaseoClient({
    url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
    clientId: `aeh-native-${process.pid}`,
    password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
  });
  try {
    await client.connect();
    return await action(client);
  } catch (error) {
    if (error instanceof PaseoSdkUnavailableError) throw error;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadNativeSdk(root: string): Promise<NativePaseoModule> {
  const bundled = await resolvePaseoSdkFromCli(root);
  if (bundled.resolved) {
    try {
      const sdk = await import(pathToFileURL(bundled.resolved).href) as unknown as NativePaseoModule;
      if (typeof sdk.createPaseoClient === "function") return sdk;
    } catch (error) {
      bundled.diagnostics.push(`native bundled import: ${String(error)}`);
    }
  }
  const packageName = "@getpaseo/client";
  let directError: unknown;
  try {
    const direct = await import(packageName) as unknown as NativePaseoModule;
    if (typeof direct.createPaseoClient === "function") return direct;
  } catch (error) { directError = error; }
  const detail = bundled.diagnostics.length ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.` : "";
  throw new PaseoSdkUnavailableError(`Paseo native SDK could not be resolved.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`, { cause: directError });
}

async function refetchAgent(handle: NativeAgentHandle): Promise<Record<string, unknown> | undefined> {
  if (typeof handle.refetch === "function") return (await handle.refetch())?.agent;
  if (typeof handle.refresh === "function") return (await handle.refresh())?.agent;
  return handle.latest?.() ?? undefined;
}

async function providerDiagnostic(providers: NonNullable<NativePaseoClient["providers"]>, provider: string): Promise<string | undefined> {
  if (typeof providers.diagnostic !== "function") return undefined;
  try {
    const value = await providers.diagnostic(provider);
    return firstDiagnosticMessage(value);
  } catch { return undefined; }
}

async function tracePreflight(root: string, result: PaseoProviderPreflightResult): Promise<void> {
  await recordPaseoTrace(root, "provider.preflight", {
    ok: result.ok,
    provider: result.provider,
    model: result.model ?? "",
    providerStatus: result.providerStatus ?? "unknown",
    source: result.source,
    availableModelCount: result.availableModels?.length ?? 0,
    message: result.message
  });
}

function parseUsage(value: unknown): PaseoNativeUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: PaseoNativeUsage = {
    inputTokens: finiteNonNegative(record.inputTokens),
    cachedInputTokens: finiteNonNegative(record.cachedInputTokens),
    outputTokens: finiteNonNegative(record.outputTokens),
    totalCostUsd: finiteNonNegative(record.totalCostUsd),
    contextWindowMaxTokens: finitePositive(record.contextWindowMaxTokens),
    contextWindowUsedTokens: finiteNonNegative(record.contextWindowUsedTokens)
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function findProviderEntry(value: unknown, provider: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findProviderEntry(item, provider); if (found) return found; }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = stringField(record, ["provider", "id", "key"]);
  if (id === provider && ("status" in record || "models" in record || "enabled" in record)) return record;
  for (const child of Object.values(record)) { const found = findProviderEntry(child, provider); if (found) return found; }
  return undefined;
}

function modelIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const id = stringField(record, ["id", "model", "name"]);
    if (id && ("label" in record || "provider" in record || "aliases" in record || "isDefault" in record)) result.add(id);
    if (Array.isArray(record.aliases)) for (const alias of record.aliases) if (typeof alias === "string") result.add(alias);
    for (const child of Object.values(record)) if (child !== record.aliases) visit(child);
  };
  visit(value);
  return [...result];
}

function firstDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) { for (const child of value) { const found = firstDiagnosticMessage(child); if (found) return found; } return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "diagnostic", "detail"]) if (typeof record[key] === "string" && (record[key] as string).trim()) return (record[key] as string).trim();
  for (const child of Object.values(record)) { const found = firstDiagnosticMessage(child); if (found) return found; }
  return undefined;
}

function normalizeProviderModel(providerValue: string, modelValue?: string): { provider: string; model?: string } {
  const provider = providerValue.trim();
  if (!provider) throw new Error("Paseo provider is required.");
  const slash = provider.indexOf("/");
  if (slash < 0) return { provider, model: modelValue?.trim() || undefined };
  const providerId = provider.slice(0, slash).trim();
  const embedded = provider.slice(slash + 1).trim();
  const explicit = modelValue?.trim();
  if (!providerId || !embedded) throw new Error(`Invalid Paseo provider/model '${providerValue}'.`);
  if (explicit && explicit !== embedded) throw new Error(`Conflicting Paseo model '${explicit}' versus embedded '${embedded}'.`);
  return { provider: providerId, model: explicit || embedded };
}

function extractLastAssistantText(value: unknown): string | undefined {
  const out: string[] = [];
  const visit = (item: unknown, assistant = false) => {
    if (Array.isArray(item)) { for (const child of item) visit(child, assistant); return; }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const role = String(record.role ?? record.author ?? record.kind ?? record.type ?? "").toLowerCase();
    const isAssistant = assistant || role.includes("assistant");
    if (isAssistant) for (const key of ["text", "content", "message"]) if (typeof record[key] === "string" && record[key]) out.push(record[key] as string);
    for (const child of Object.values(record)) visit(child, isAssistant);
  };
  visit(value);
  return out.at(-1);
}

function isActiveStatus(status?: string): boolean { return status === "working" || status === "running" || status === "streaming" || status === "starting"; }
function isTerminalStatus(status?: string): boolean { return status === "idle" || status === "finished" || status === "completed" || status === "failed" || status === "error" || status === "cancelled"; }
function finiteNonNegative(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function finitePositive(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
function recordField(value: unknown, key: string): unknown { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
function stringField(record: Record<string, unknown>, keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function stringRecord(value: unknown): Record<string, string> | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const out: Record<string, string> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") out[key] = item; return Object.keys(out).length ? out : undefined; }
function statusText(value: unknown): string | undefined { if (typeof value === "string") return value; if (value && typeof value === "object" && typeof (value as Record<string, unknown>).status === "string") return (value as Record<string, unknown>).status as string; return undefined; }
