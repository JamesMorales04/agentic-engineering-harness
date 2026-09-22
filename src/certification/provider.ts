import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageMetrics } from "../core/types.js";
import { extractUsageMetrics } from "../metrics/usage.js";
import type { AgentProviderRequest, AgentProviderResult, ProviderEvent } from "./types.js";

const SAFE_ENVIRONMENT = new Set(["PATH", "NODE_PATH", "TMPDIR", "LANG", "LC_ALL", "CI", "TERM"]);

export interface ProcessExecutionOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork?: boolean;
}

/** Execute an external actor without a shell and with a deliberately filtered environment. */
export async function executeArgv(command: string, args: readonly string[], options: ProcessExecutionOptions): Promise<{
  status: "COMPLETED" | "FAILED" | "TIMED_OUT" | "OUTPUT_LIMIT";
  exitCode: number;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
}> {
  const cwd = await safeDirectory(options.cwd);
  const environment = filteredEnvironment(options.env ?? {});
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: environment, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const finishOnLimit = (): void => {
      if (outputLimit) return;
      outputLimit = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 250).unref();
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        finishOnLimit();
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 250).unref(); }, options.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: outputLimit ? "OUTPUT_LIMIT" : timedOut ? "TIMED_OUT" : code === 0 ? "COMPLETED" : "FAILED", exitCode: code ?? 1, signal: signal ?? undefined, stdout, stderr, durationMs: Date.now() - started, outputTruncated: outputLimit });
    });
  });
}

export class LocalAgentProvider {
  readonly name: string = "local-process";
  readonly networkIsolation = "unavailable" as const;

  async execute(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const started = new Date().toISOString();
    const events: ProviderEvent[] = [{ at: started, type: "started", data: { requestId: request.requestId, role: request.role } }];
    const result = await executeArgv(request.command, request.args, {
      cwd: request.cwd,
      env: buildProviderEnvironment(request),
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      allowNetwork: request.allowNetwork
    });
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      try { events.push({ at: new Date().toISOString(), type: "json", data: JSON.parse(line) }); }
      catch { events.push({ at: new Date().toISOString(), type: "stdout", data: line }); }
    }
    if (result.stderr) events.push({ at: new Date().toISOString(), type: "stderr", data: result.stderr });
    events.push({ at: new Date().toISOString(), type: result.status === "TIMED_OUT" ? "timeout" : "finished", data: { exitCode: result.exitCode, status: result.status } });
    const usage = structuredUsage(events) ?? extractUsageMetrics(`${result.stdout}\n${result.stderr}`);
    return { version: 1, provider: this.name, requestId: request.requestId, role: request.role, ...result, events, structuredOutput: jsonOutput(events), usage, usageKnown: usage.totalTokens !== undefined || usage.costUsd !== undefined, outputTruncated: result.outputTruncated };
  }
}

export function buildProviderEnvironment(request: Pick<AgentProviderRequest, "environment" | "environmentAllowlist" | "credentialEnvAllowlist">): Record<string, string> {
  const allowed = new Set([...SAFE_ENVIRONMENT, ...(request.environmentAllowlist ?? []), ...(request.credentialEnvAllowlist ?? [])]);
  const credentials = new Set(request.credentialEnvAllowlist ?? []);
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined && (SAFE_ENVIRONMENT.has(name) || credentials.has(name) || (request.environmentAllowlist ?? []).includes(name))) result[name] = value;
  }
  for (const [name, value] of Object.entries(request.environment ?? {})) if (allowed.has(name) || name === "AEH_CERTIFICATION_ACTIVE" || name === "AEH_CERTIFICATION_DEPTH") result[name] = value;
  return result;
}

export function parseJsonl(text: string): unknown[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

async function safeDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`Provider cwd is not a directory: ${resolved}`);
  return fs.realpath(resolved);
}

function filteredEnvironment(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT) if (process.env[name] !== undefined) result[name] = process.env[name];
  for (const [name, value] of Object.entries(overrides)) if (value !== undefined) result[name] = value;
  result.TMPDIR ??= os.tmpdir();
  return result;
}

function jsonOutput(events: ProviderEvent[]): unknown {
  const values = events.filter((event) => event.type === "json").map((event) => event.data);
  return values.length === 1 ? values[0] : values.length ? values : undefined;
}

function structuredUsage(events: ProviderEvent[]): UsageMetrics | undefined {
  const totals: UsageMetrics = {};
  let found = false;
  for (const event of events) {
    const value = event.data;
    if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "turn.completed") continue;
    const usage = (value as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") continue;
    const record = usage as Record<string, unknown>;
    found = true;
    addMetric(totals, "inputTokens", record.input_tokens ?? record.inputTokens);
    addMetric(totals, "cachedInputTokens", record.cached_input_tokens ?? record.cachedInputTokens);
    addMetric(totals, "outputTokens", record.output_tokens ?? record.outputTokens);
    addMetric(totals, "reasoningOutputTokens", record.reasoning_output_tokens ?? record.reasoningOutputTokens);
    addMetric(totals, "totalTokens", record.total_tokens ?? record.totalTokens);
  }
  if (!found) return undefined;
  if (totals.totalTokens === undefined && (totals.inputTokens !== undefined || totals.outputTokens !== undefined)) totals.totalTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  return totals;
}

function addMetric(target: UsageMetrics, key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens", value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = (target[key] ?? 0) + Math.round(value);
}

export function usageForProviderResult(result: AgentProviderResult): UsageMetrics { return result.usage; }
