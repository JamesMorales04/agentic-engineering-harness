import process from "node:process";
import type { OpenCodeAgentBindingSource } from "../agents/permissions.js";
import { registerCurrentOperationAgent } from "../operations/state.js";
import { runProcess } from "../utils/process.js";
import {
  buildPaseoBackgroundRunCommand,
  detectPaseoCapabilities,
  extractPaseoAgentId
} from "./capabilities.js";
import { preflightPaseoProviderMode } from "./modePreflight.js";
import {
  capturePaseoAgentTurnBaseline,
  preflightPaseoProviderModel,
  waitForPaseoAgentNative,
  type PaseoNativeWaitResult,
  type PaseoTurnBaseline
} from "./native.js";
import {
  PaseoSdkUnavailableError,
  createPaseoSdkAgent,
  dispatchPaseoSdkAgent,
  inspectPaseoSdkAgent,
  listPaseoSdkAgents,
  materializePaseoSdkAgent,
  probePaseoSdkAgent,
  runPaseoSdkAgent,
  waitPaseoSdkAgent,
  type PaseoSdkAgentOptions,
  type PaseoSdkAgentRecord,
  type PaseoSdkAgentResult
} from "./sdk.js";
import { recordPaseoTrace } from "./trace.js";

export interface ManagedPaseoAgentOptions extends PaseoSdkAgentOptions {
  timeoutSeconds?: number;
  modeSource?: OpenCodeAgentBindingSource;
}

export interface ManagedPaseoAgentResult {
  id?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  status?: string;
  workspaceId?: string;
  transport: "sdk" | "cli";
  observation?: "subscription" | "sdk-wait" | "cli-wait";
}

interface PaseoRuntimeDeps {
  run: typeof runProcess;
  detectCapabilities: typeof detectPaseoCapabilities;
  trace?: typeof recordPaseoTrace;
  native?: {
    preflight: typeof preflightPaseoProviderModel;
    preflightMode: typeof preflightPaseoProviderMode;
    wait: typeof waitForPaseoAgentNative;
    capture?: typeof capturePaseoAgentTurnBaseline;
  };
  sdk: {
    create: typeof createPaseoSdkAgent;
    materialize: typeof materializePaseoSdkAgent;
    dispatch: typeof dispatchPaseoSdkAgent;
    wait: typeof waitPaseoSdkAgent;
    run: typeof runPaseoSdkAgent;
    probe: typeof probePaseoSdkAgent;
    inspect: typeof inspectPaseoSdkAgent;
    list: typeof listPaseoSdkAgents;
  };
}

const DEFAULT_DEPS: PaseoRuntimeDeps = {
  run: runProcess,
  detectCapabilities: detectPaseoCapabilities,
  trace: recordPaseoTrace,
  native: {
    preflight: preflightPaseoProviderModel,
    preflightMode: preflightPaseoProviderMode,
    wait: waitForPaseoAgentNative,
    capture: capturePaseoAgentTurnBaseline
  },
  sdk: {
    create: createPaseoSdkAgent,
    materialize: materializePaseoSdkAgent,
    dispatch: dispatchPaseoSdkAgent,
    wait: waitPaseoSdkAgent,
    run: runPaseoSdkAgent,
    probe: probePaseoSdkAgent,
    inspect: inspectPaseoSdkAgent,
    list: listPaseoSdkAgents
  }
};

export async function launchManagedPaseoAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<ManagedPaseoAgentResult> {
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;

  if (!forceCli()) {
    await ensurePreflight(root, options, deps);
    await traceResolvedIdentity(root, options, trace);
    try {
      const created = fromSdk(
        await deps.sdk.create(root, { ...options, waitForFinish: false })
      );
      await registerManagedAgent(root, options, created);
      await trace(root, "agent.launch", {
        transport: "sdk",
        agentId: created.id ?? "",
        provider: options.provider,
        model: options.model ?? "",
        modeId: options.modeId ?? "",
        modeSource: options.modeSource ?? "",
        status: created.status ?? "unknown"
      });

      if (!created.id || options.prompt === undefined || options.waitForFinish === false) {
        return created;
      }
      return waitManagedPaseoAgent(
        root,
        created.id,
        options.timeoutSeconds ?? secondsFromMs(options.timeoutMs),
        deps
      );
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "fallback.cli", {
        operation: "launch",
        provider: options.provider,
        model: options.model ?? "",
        modeId: options.modeId ?? "",
        reason: errorMessage(error)
      });
      return launchCli(root, options, deps, `SDK unavailable: ${errorMessage(error)}`);
    }
  }

  await trace(root, "fallback.cli", {
    operation: "launch",
    provider: options.provider,
    model: options.model ?? "",
    modeId: options.modeId ?? "",
    reason: "AEH_PASEO_FORCE_CLI=1"
  });
  return launchCli(
    root,
    options,
    deps,
    "AEH_PASEO_FORCE_CLI=1 forced the compatibility lifecycle."
  );
}

export async function materializeManagedPaseoAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<ManagedPaseoAgentResult> {
  if (forceCli()) {
    throw new PaseoSdkUnavailableError(
      "Idle agent materialization is SDK-only; AEH_PASEO_FORCE_CLI=1 is active."
    );
  }
  await ensurePreflight(root, options, deps);
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;
  await traceResolvedIdentity(root, options, trace);
  try {
    const result = fromSdk(
      await deps.sdk.materialize(root, {
        ...options,
        prompt: undefined,
        waitForFinish: false
      })
    );
    await registerManagedAgent(root, options, result);
    await trace(root, "agent.materialize", {
      transport: "sdk",
      agentId: result.id ?? "",
      provider: options.provider,
      model: options.model ?? "",
      modeId: options.modeId ?? "",
      modeSource: options.modeSource ?? "",
      workspaceId: result.workspaceId ?? ""
    });
    return result;
  } catch (error) {
    if (sdkCanFallback(error)) {
      throw new PaseoSdkUnavailableError(
        `Paseo SDK is required to materialize an idle visible agent. ${errorMessage(error)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

export async function dispatchManagedPaseoAgent(
  root: string,
  agentId: string,
  prompt: string,
  timeoutSeconds?: number,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<ManagedPaseoAgentResult> {
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;
  if (!forceCli()) {
    try {
      const result = fromSdk(
        await deps.sdk.dispatch(root, agentId, prompt, timeoutMs(timeoutSeconds))
      );
      await trace(root, "agent.dispatch", {
        transport: "sdk",
        agentId,
        status: result.status ?? "unknown"
      });
      return result;
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "fallback.cli", {
        operation: "dispatch",
        agentId,
        reason: errorMessage(error)
      });
    }
  }

  const send = await deps.run(`paseo send ${quote(agentId)} --no-wait ${quote(prompt)}`, {
    cwd: root,
    timeoutMs: 60_000
  });
  await trace(root, "agent.dispatch", {
    transport: "cli",
    agentId,
    exitCode: send.exitCode
  });
  return {
    id: agentId,
    exitCode: send.exitCode,
    stdout: send.stdout,
    stderr: send.stderr,
    status: send.exitCode === 0 ? "working" : "failed",
    transport: "cli"
  };
}

export async function waitManagedPaseoAgent(
  root: string,
  agentId: string,
  timeoutSeconds?: number,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS,
  baseline?: PaseoTurnBaseline
): Promise<ManagedPaseoAgentResult> {
  const timeout = timeoutMs(timeoutSeconds);
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;

  if (!forceCli()) {
    const native = deps.native ?? DEFAULT_DEPS.native!;
    try {
      const result = fromNativeWait(await native.wait(root, agentId, timeout, baseline));
      await trace(root, "agent.wait.completed", {
        transport: "sdk",
        observation: "subscription",
        agentId,
        status: result.status ?? "unknown"
      });
      return result;
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "agent.wait.fallback", {
        agentId,
        from: "subscription",
        to: "sdk-wait",
        reason: errorMessage(error)
      });
      try {
        const result = {
          ...fromSdk(await deps.sdk.wait(root, agentId, timeout)),
          observation: "sdk-wait" as const
        };
        await trace(root, "agent.wait.completed", {
          transport: "sdk",
          observation: "sdk-wait",
          agentId,
          status: result.status ?? "unknown"
        });
        return result;
      } catch (sdkError) {
        if (!sdkCanFallback(sdkError)) throw sdkError;
        await trace(root, "fallback.cli", {
          operation: "wait",
          agentId,
          reason: errorMessage(sdkError)
        });
      }
    }
  }

  const timeoutSec = timeoutSeconds ?? 1800;
  const wait = await deps.run(`paseo wait ${quote(agentId)} --timeout ${timeoutSec}`, {
    cwd: root,
    timeoutMs: (timeoutSec + 30) * 1000
  });
  const logs = await deps.run(`paseo logs ${quote(agentId)} --tail 200`, {
    cwd: root,
    timeoutMs: 60_000
  });
  const result: ManagedPaseoAgentResult = {
    id: agentId,
    exitCode: wait.exitCode,
    stdout: logs.stdout || wait.stdout,
    stderr: [wait.stderr, logs.stderr].filter(Boolean).join("\n"),
    status: wait.exitCode === 0 ? "idle" : "failed",
    transport: "cli",
    observation: "cli-wait"
  };
  await trace(root, "agent.wait.completed", {
    transport: "cli",
    observation: "cli-wait",
    agentId,
    status: result.status ?? "unknown"
  });
  return result;
}

export async function continueManagedPaseoAgent(
  root: string,
  agentId: string,
  prompt: string,
  timeoutSeconds?: number,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<ManagedPaseoAgentResult> {
  let baseline: PaseoTurnBaseline | undefined;
  if (!forceCli()) {
    const native = deps.native ?? DEFAULT_DEPS.native!;
    if (typeof native.capture === "function") {
      try {
        baseline = await native.capture(root, agentId);
        await (deps.trace ?? DEFAULT_DEPS.trace!)(root, "agent.turn.baseline", {
          agentId,
          assistantMessage: baseline.lastAssistantMessage ? "present" : "absent"
        });
      } catch (error) {
        if (!sdkCanFallback(error)) throw error;
        await (deps.trace ?? DEFAULT_DEPS.trace!)(root, "agent.turn.baseline.skipped", {
          agentId,
          reason: errorMessage(error)
        });
      }
    }
  }

  const sent = await dispatchManagedPaseoAgent(root, agentId, prompt, timeoutSeconds, deps);
  if (sent.exitCode !== 0) return sent;
  return waitManagedPaseoAgent(root, agentId, timeoutSeconds, deps, baseline);
}

export async function probeManagedPaseoAgent(
  root: string,
  agentId: string,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<boolean> {
  if (!forceCli()) {
    try {
      return await deps.sdk.probe(root, agentId);
    } catch (error) {
      if (!sdkCanFallback(error)) return false;
    }
  }
  const probe = await deps.run(`paseo logs ${quote(agentId)} --tail 1`, {
    cwd: root,
    timeoutMs: 30_000
  });
  return probe.exitCode === 0;
}

export async function inspectManagedPaseoAgent(
  root: string,
  agentId: string,
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<PaseoSdkAgentRecord | undefined> {
  if (!forceCli()) {
    try {
      return await deps.sdk.inspect(root, agentId);
    } catch (error) {
      if (!sdkCanFallback(error)) return undefined;
    }
  }
  return (await listCliAgents(root, deps)).find((agent) => agent.id === agentId);
}

export async function listManagedPaseoAgents(
  root: string,
  labels: Record<string, string> = {},
  deps: PaseoRuntimeDeps = DEFAULT_DEPS
): Promise<PaseoSdkAgentRecord[]> {
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;
  if (!forceCli()) {
    try {
      return await deps.sdk.list(root, labels);
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "agent.list.cli.required", {
        reason: errorMessage(error),
        labelCount: Object.keys(labels).length
      });
    }
  }
  return (await listCliAgents(root, deps)).filter((agent) =>
    Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value)
  );
}

async function ensurePreflight(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps
): Promise<void> {
  const native = deps.native ?? DEFAULT_DEPS.native!;
  const trace = deps.trace ?? DEFAULT_DEPS.trace!;
  try {
    const result = await native.preflight(root, options.provider, options.model, options.cwd);
    if (!result.ok) {
      const available = result.availableModels?.length
        ? ` Available models: ${result.availableModels.join(", ")}.`
        : "";
      throw new Error(`Paseo provider preflight failed: ${result.message}${available}`);
    }
  } catch (error) {
    if (sdkCanFallback(error)) {
      await trace(root, "provider.preflight.skipped", {
        provider: options.provider,
        model: options.model ?? "",
        reason: errorMessage(error)
      });
    } else {
      throw error;
    }
  }

  if (!options.modeId) return;

  if (options.modeSource === "aeh-managed") {
    await trace(root, "provider.mode.preflight", {
      ok: true,
      provider: options.provider,
      modeId: options.modeId,
      source: "aeh-inline-config",
      message:
        "AEH injects this primary OpenCode agent through the session launch environment; ambient provider mode discovery is not authoritative for the dedicated helper."
    });
    return;
  }

  const mode = await native.preflightMode(root, options.provider, options.modeId, options.cwd);
  if (!mode.ok) {
    const available = mode.availableModes.length
      ? ` Available modes: ${mode.availableModes.join(", ")}.`
      : "";
    throw new Error(`Paseo mode preflight failed: ${mode.message}${available}`);
  }
}

async function traceResolvedIdentity(
  root: string,
  options: ManagedPaseoAgentOptions,
  trace: typeof recordPaseoTrace
): Promise<void> {
  if (!options.modeId) return;
  await trace(root, "agent.identity", {
    provider: options.provider,
    model: options.model ?? "",
    modeId: options.modeId,
    source: options.modeSource ?? "provider-mode",
    sessionScopedEnv: options.env?.OPENCODE_CONFIG_CONTENT ? true : false
  });
}

async function launchCli(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps,
  fallbackReason: string
): Promise<ManagedPaseoAgentResult> {
  if (options.prompt === undefined && options.systemPrompt !== undefined) {
    throw new PaseoSdkUnavailableError(
      `Paseo SDK is required to create an idle systemPrompt-only agent. Refusing CLI fallback because it would expose session instructions as a user turn. ${fallbackReason}`
    );
  }
  if (options.env && Object.keys(options.env).length) {
    throw new PaseoSdkUnavailableError(
      `Paseo SDK is required for session-scoped launch environment used by provider ${options.provider}${
        options.modeId ? ` mode ${options.modeId}` : ""
      }. Refusing CLI fallback because dropping that environment could change the native execution identity or permissions. ${fallbackReason}`
    );
  }
  const capabilities = await deps.detectCapabilities(root, deps.run);
  const prompt = options.prompt;
  if (prompt === undefined) throw new Error("Paseo CLI fallback requires a prompt.");
  const timeout =
    options.timeoutSeconds ?? Math.max(1, Math.ceil((options.timeoutMs ?? 1_800_000) / 1000));

  if (options.outputSchema) {
    if (!capabilities.outputSchema) {
      throw new Error(
        `Installed Paseo${capabilities.version ? ` ${capabilities.version}` : ""} does not advertise --output-schema required by this agent.`
      );
    }
    const parts = [
      "paseo run --quiet",
      `--title ${quote(options.title)}`,
      `--provider ${quote(options.provider)}`
    ];
    if (options.workspaceId) parts.push(`--workspace ${quote(options.workspaceId)}`);
    if (options.model) parts.push(`--model ${quote(options.model)}`);
    parts.push(
      `--output-schema ${quote(JSON.stringify(options.outputSchema))}`,
      quote(prompt)
    );
    const result = await deps.run(parts.join(" "), {
      cwd: root,
      timeoutMs: timeout * 1000
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: [fallbackReason, result.stderr].filter(Boolean).join("\n"),
      status: result.exitCode === 0 ? "idle" : "failed",
      transport: "cli"
    };
  }

  const command = buildPaseoBackgroundRunCommand(
    {
      title: options.title,
      provider: options.provider,
      model: options.model,
      workspaceId: options.workspaceId,
      prompt
    },
    capabilities
  );
  const launch = await deps.run(command, { cwd: root, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) {
    return {
      exitCode: launch.exitCode,
      stdout: launch.stdout,
      stderr: [fallbackReason, launch.stderr].filter(Boolean).join("\n"),
      status: "failed",
      transport: "cli"
    };
  }
  const id = extractPaseoAgentId(launch.stdout);
  if (!id) {
    return {
      exitCode: 1,
      stdout: launch.stdout,
      stderr: [fallbackReason, "Paseo returned no parseable agent id."].join("\n"),
      status: "failed",
      transport: "cli"
    };
  }

  const launched: ManagedPaseoAgentResult = {
    id,
    exitCode: 0,
    stdout: launch.stdout,
    stderr: launch.stderr,
    status: "working",
    workspaceId: options.workspaceId,
    transport: "cli"
  };
  await registerManagedAgent(root, options, launched);
  if (options.waitForFinish === false) return launched;

  const waited = await waitManagedPaseoAgent(root, id, timeout, deps);
  return {
    ...waited,
    stderr: [fallbackReason, launch.stderr, waited.stderr].filter(Boolean).join("\n")
  };
}

async function registerManagedAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  result: ManagedPaseoAgentResult
): Promise<void> {
  if (!result.id) return;
  await registerCurrentOperationAgent(root, {
    id: result.id,
    role: options.labels?.["aeh.role"],
    phase: options.labels?.["aeh.operation.phase"],
    workspaceId: result.workspaceId ?? options.workspaceId,
    transport: result.transport
  });
}

async function listCliAgents(
  root: string,
  deps: PaseoRuntimeDeps
): Promise<PaseoSdkAgentRecord[]> {
  const result = await deps.run("paseo ls -a -g --json", {
    cwd: root,
    timeoutMs: 30_000
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  try {
    const records = new Map<string, PaseoSdkAgentRecord>();
    collectCliAgents(JSON.parse(result.stdout) as unknown, records);
    return [...records.values()];
  } catch {
    return [];
  }
}

function collectCliAgents(
  value: unknown,
  out: Map<string, PaseoSdkAgentRecord>
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCliAgents(child, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const id = firstString(record, ["id", "agentId", "agent_id"]);
  if (id && ("status" in record || "title" in record || "labels" in record)) {
    out.set(id, {
      id,
      title: firstString(record, ["title", "name"]),
      status: statusText(record.status),
      workspaceId: firstString(record, ["workspaceId", "workspace_id"]),
      labels: stringRecord(record.labels),
      raw: record
    });
  }
  for (const child of Object.values(record)) collectCliAgents(child, out);
}

function forceCli(): boolean {
  return process.env.AEH_PASEO_FORCE_CLI === "1";
}
function sdkCanFallback(error: unknown): boolean {
  return (
    error instanceof PaseoSdkUnavailableError ||
    (error instanceof Error && error.name === "PaseoSdkUnavailableError")
  );
}
function timeoutMs(seconds?: number): number {
  return (seconds ?? 1800) * 1000;
}
function secondsFromMs(ms?: number): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}
function fromSdk(result: PaseoSdkAgentResult): ManagedPaseoAgentResult {
  return {
    id: result.id,
    exitCode: sdkExitCode(result.status, result.error),
    stdout: result.lastMessage ?? "",
    stderr: result.error ?? "",
    status: result.status,
    workspaceId: result.workspaceId,
    transport: "sdk"
  };
}
function fromNativeWait(result: PaseoNativeWaitResult): ManagedPaseoAgentResult {
  return {
    id: result.id,
    exitCode: sdkExitCode(result.status, result.error),
    stdout: result.lastMessage ?? "",
    stderr: result.error ?? "",
    status: result.status,
    workspaceId: result.workspaceId,
    transport: "sdk",
    observation: "subscription"
  };
}
function sdkExitCode(status?: string, error?: string): number {
  if (status === "timeout") return 124;
  if (error) return 1;
  if (status === "failed" || status === "error" || status === "cancelled") return 1;
  return 0;
}
function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}
function statusText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).status === "string"
  ) {
    return (value as Record<string, unknown>).status as string;
  }
  return undefined;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
