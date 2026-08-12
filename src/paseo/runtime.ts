import process from "node:process";
import { buildPaseoBackgroundRunCommand, detectPaseoCapabilities, extractPaseoAgentId } from "./capabilities.js";
import {
  PaseoSdkUnavailableError,
  createPaseoSdkAgent,
  inspectPaseoSdkAgent,
  listPaseoSdkAgents,
  probePaseoSdkAgent,
  runPaseoSdkAgent,
  type PaseoSdkAgentOptions,
  type PaseoSdkAgentRecord,
  type PaseoSdkAgentResult
} from "./sdk.js";
import { runProcess } from "../utils/process.js";

export interface ManagedPaseoAgentOptions extends PaseoSdkAgentOptions {
  timeoutSeconds?: number;
}

export interface ManagedPaseoAgentResult {
  id?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  status?: string;
  transport: "sdk" | "cli";
}

interface PaseoRuntimeDeps {
  run: typeof runProcess;
  detectCapabilities: typeof detectPaseoCapabilities;
  sdk: {
    create: typeof createPaseoSdkAgent;
    run: typeof runPaseoSdkAgent;
    probe: typeof probePaseoSdkAgent;
    inspect: typeof inspectPaseoSdkAgent;
    list: typeof listPaseoSdkAgents;
  };
}

const DEFAULT_DEPS: PaseoRuntimeDeps = {
  run: runProcess,
  detectCapabilities: detectPaseoCapabilities,
  sdk: { create: createPaseoSdkAgent, run: runPaseoSdkAgent, probe: probePaseoSdkAgent, inspect: inspectPaseoSdkAgent, list: listPaseoSdkAgents }
};

export async function launchManagedPaseoAgent(root: string, options: ManagedPaseoAgentOptions, deps: PaseoRuntimeDeps = DEFAULT_DEPS): Promise<ManagedPaseoAgentResult> {
  if (preferSdk(options)) {
    try {
      const result = await deps.sdk.create(root, { ...options, timeoutMs: options.timeoutMs ?? timeoutMs(options.timeoutSeconds) });
      return fromSdk(result);
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      return launchCli(root, options, deps, `SDK unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return launchCli(root, options, deps, "SDK skipped because no explicit provider/model was available or AEH_PASEO_FORCE_CLI=1.");
}

export async function continueManagedPaseoAgent(root: string, agentId: string, prompt: string, timeoutSeconds?: number, deps: PaseoRuntimeDeps = DEFAULT_DEPS): Promise<ManagedPaseoAgentResult> {
  if (!forceCli()) {
    try { return fromSdk(await deps.sdk.run(root, agentId, prompt, timeoutMs(timeoutSeconds))); }
    catch (error) { if (!sdkCanFallback(error)) throw error; }
  }
  const timeout = timeoutSeconds ?? 1800;
  const send = await deps.run(`paseo send ${quote(agentId)} --no-wait ${quote(prompt)}`, { cwd: root, timeoutMs: 60_000 });
  if (send.exitCode !== 0) return { id: agentId, exitCode: send.exitCode, stdout: send.stdout, stderr: send.stderr, transport: "cli" };
  const wait = await deps.run(`paseo wait ${quote(agentId)} --timeout ${timeout}`, { cwd: root, timeoutMs: (timeout + 30) * 1000 });
  const logs = await deps.run(`paseo logs ${quote(agentId)} --tail 200`, { cwd: root, timeoutMs: 60_000 });
  return { id: agentId, exitCode: wait.exitCode, stdout: logs.stdout || wait.stdout, stderr: [send.stderr, wait.stderr, logs.stderr].filter(Boolean).join("\n"), transport: "cli" };
}

export async function probeManagedPaseoAgent(root: string, agentId: string, deps: PaseoRuntimeDeps = DEFAULT_DEPS): Promise<boolean> {
  if (!forceCli()) {
    try { return await deps.sdk.probe(root, agentId); }
    catch (error) { if (!sdkCanFallback(error)) return false; }
  }
  const probe = await deps.run(`paseo logs ${quote(agentId)} --tail 1`, { cwd: root, timeoutMs: 30_000 });
  return probe.exitCode === 0;
}

export async function inspectManagedPaseoAgent(root: string, agentId: string, deps: PaseoRuntimeDeps = DEFAULT_DEPS): Promise<PaseoSdkAgentRecord | undefined> {
  if (!forceCli()) {
    try { return await deps.sdk.inspect(root, agentId); }
    catch (error) { if (!sdkCanFallback(error)) return undefined; }
  }
  return (await listCliAgents(root, deps)).find((agent) => agent.id === agentId);
}

export async function listManagedPaseoAgents(root: string, labels: Record<string, string> = {}, deps: PaseoRuntimeDeps = DEFAULT_DEPS): Promise<PaseoSdkAgentRecord[]> {
  if (!forceCli()) {
    try { return await deps.sdk.list(root, labels); }
    catch (error) { if (!sdkCanFallback(error)) throw error; }
  }
  return (await listCliAgents(root, deps)).filter((agent) => Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value));
}

async function launchCli(root: string, options: ManagedPaseoAgentOptions, deps: PaseoRuntimeDeps, fallbackReason: string): Promise<ManagedPaseoAgentResult> {
  if (options.prompt === undefined && options.systemPrompt !== undefined) {
    throw new PaseoSdkUnavailableError(`Paseo SDK is required to create an idle systemPrompt-only agent. Refusing CLI fallback because it would expose session instructions as a user turn. ${fallbackReason}`);
  }
  const capabilities = await deps.detectCapabilities(root, deps.run);
  const prompt = options.prompt;
  if (prompt === undefined) throw new Error("Paseo CLI fallback requires a prompt.");
  const timeout = options.timeoutSeconds ?? Math.max(1, Math.ceil((options.timeoutMs ?? 1_800_000) / 1000));

  if (options.outputSchema) {
    if (!capabilities.outputSchema) throw new Error(`Installed Paseo${capabilities.version ? ` ${capabilities.version}` : ""} does not advertise --output-schema required by this agent.`);
    const parts = ["paseo run --quiet", `--title ${quote(options.title)}`, `--provider ${quote(options.provider)}`];
    if (options.workspaceId) parts.push(`--workspace ${quote(options.workspaceId)}`);
    if (options.model) parts.push(`--model ${quote(options.model)}`);
    parts.push(`--output-schema ${quote(JSON.stringify(options.outputSchema))}`, quote(prompt));
    const result = await deps.run(parts.join(" "), { cwd: root, timeoutMs: timeout * 1000 });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: [fallbackReason, result.stderr].filter(Boolean).join("\n"), transport: "cli" };
  }

  const command = buildPaseoBackgroundRunCommand({ title: options.title, provider: options.provider, model: options.model, workspaceId: options.workspaceId, prompt }, capabilities);
  const launch = await deps.run(command, { cwd: root, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) return { exitCode: launch.exitCode, stdout: launch.stdout, stderr: [fallbackReason, launch.stderr].filter(Boolean).join("\n"), transport: "cli" };
  const id = extractPaseoAgentId(launch.stdout);
  if (!id) return { exitCode: 1, stdout: launch.stdout, stderr: [fallbackReason, "Paseo returned no parseable agent id."].join("\n"), transport: "cli" };
  const wait = await deps.run(`paseo wait ${quote(id)} --timeout ${timeout}`, { cwd: root, timeoutMs: (timeout + 30) * 1000 });
  const logs = await deps.run(`paseo logs ${quote(id)} --tail 200`, { cwd: root, timeoutMs: 60_000 });
  return { id, exitCode: wait.exitCode, stdout: logs.stdout || wait.stdout || launch.stdout, stderr: [fallbackReason, launch.stderr, wait.stderr, logs.stderr].filter(Boolean).join("\n"), transport: "cli" };
}

async function listCliAgents(root: string, deps: PaseoRuntimeDeps): Promise<PaseoSdkAgentRecord[]> {
  const result = await deps.run("paseo ls -a -g --json", { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  try {
    const records = new Map<string, PaseoSdkAgentRecord>();
    collectCliAgents(JSON.parse(result.stdout) as unknown, records);
    return [...records.values()];
  } catch { return []; }
}

function collectCliAgents(value: unknown, out: Map<string, PaseoSdkAgentRecord>): void {
  if (Array.isArray(value)) { for (const child of value) collectCliAgents(child, out); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const id = firstString(record, ["id", "agentId", "agent_id"]);
  if (id && ("status" in record || "title" in record || "labels" in record)) {
    out.set(id, { id, title: firstString(record, ["title", "name"]), status: statusText(record.status), workspaceId: firstString(record, ["workspaceId", "workspace_id"]), labels: stringRecord(record.labels), raw: record });
  }
  for (const child of Object.values(record)) collectCliAgents(child, out);
}

function preferSdk(options: ManagedPaseoAgentOptions): boolean { return !forceCli() && (Boolean(options.model) || options.provider.includes("/")); }
function forceCli(): boolean { return process.env.AEH_PASEO_FORCE_CLI === "1"; }
function sdkCanFallback(error: unknown): boolean { return error instanceof PaseoSdkUnavailableError || (error instanceof Error && error.name === "PaseoSdkUnavailableError"); }
function timeoutMs(seconds?: number): number { return (seconds ?? 1800) * 1000; }
function fromSdk(result: PaseoSdkAgentResult): ManagedPaseoAgentResult { return { id: result.id, exitCode: sdkExitCode(result.status, result.error), stdout: result.lastMessage ?? "", stderr: result.error ?? "", status: result.status, transport: "sdk" }; }
function sdkExitCode(status?: string, error?: string): number { if (error) return 1; return !status || status === "idle" ? 0 : status === "timeout" ? 124 : 1; }
function firstString(record: Record<string, unknown>, keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function stringRecord(value: unknown): Record<string, string> | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") result[key] = item; return Object.keys(result).length ? result : undefined; }
function statusText(value: unknown): string | undefined { if (typeof value === "string") return value; if (value && typeof value === "object" && typeof (value as Record<string, unknown>).status === "string") return (value as Record<string, unknown>).status as string; return undefined; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
