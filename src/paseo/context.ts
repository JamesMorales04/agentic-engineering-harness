import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { HarnessProjectConfig } from "../core/types.js";
import { runProcess } from "../utils/process.js";
import { startPaseoHarness } from "./start.js";
import {
  contextUsageFromPaseoSnapshot,
  inspectPaseoNativeAgent,
  type PaseoNativeAgentSnapshot
} from "./native.js";
import { recordPaseoTrace } from "./trace.js";

export type ContextGuardState =
  | "OK"
  | "PRESSURE"
  | "HANDOFF_REQUIRED"
  | "HARD_HANDOFF"
  | "NO_USAGE_YET"
  | "USAGE_UNAVAILABLE"
  | "UNKNOWN";

export interface ContextUsage {
  used?: number;
  limit?: number;
  ratio?: number;
  source: string;
  availability?: "available" | "no-usage-yet" | "provider-usage-unavailable" | "agent-unavailable";
}

export interface LeadHandoffArtifact {
  version: 1;
  createdAt: string;
  reason: "CONTEXT_PRESSURE";
  project: string;
  previousAgentId: string;
  rotatedAgentId?: string;
  context: ContextUsage;
  branch?: string;
  activeRun?: string;
  latestAudit?: string;
  latestDelivery?: string;
  semanticBrief?: string;
  nextInstruction: string;
}

export interface ContextGuardResult {
  state: ContextGuardState;
  usage: ContextUsage;
  handoffPath?: string;
  rotatedAgentId?: string;
  message: string;
}

type Runner = typeof runProcess;
type Starter = typeof startPaseoHarness;
type Inspector = typeof inspectPaseoNativeAgent;
type Trace = typeof recordPaseoTrace;

export interface ContextGuardOptions {
  brief?: string;
  run?: Runner;
  autoRotate?: boolean;
  aehCommand?: string;
  start?: Starter;
  inspect?: Inspector;
  trace?: Trace;
}

export async function statusLeadContext(
  root: string,
  config: HarnessProjectConfig,
  agentId: string,
  options: Pick<ContextGuardOptions, "inspect" | "trace"> = {}
): Promise<ContextGuardResult> {
  const inspect = options.inspect ?? inspectPaseoNativeAgent;
  const trace = options.trace ?? recordPaseoTrace;
  let snapshot: PaseoNativeAgentSnapshot | undefined;
  try {
    snapshot = await inspect(root, agentId);
  } catch (error) {
    const usage: ContextUsage = { source: "paseo-agent-snapshot", availability: "agent-unavailable" };
    await trace(root, "context.status", { agentId, state: "USAGE_UNAVAILABLE", source: usage.source, error: String(error) });
    return {
      state: "USAGE_UNAVAILABLE",
      usage,
      message: `Paseo could not provide the current agent snapshot: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!snapshot) {
    const usage: ContextUsage = { source: "paseo-agent-snapshot", availability: "agent-unavailable" };
    await trace(root, "context.status", { agentId, state: "USAGE_UNAVAILABLE", source: usage.source });
    return { state: "USAGE_UNAVAILABLE", usage, message: "Paseo did not return a snapshot for the managed lead." };
  }

  const native = contextUsageFromPaseoSnapshot(snapshot);
  const usage: ContextUsage = { used: native.used, limit: native.limit, ratio: native.ratio, source: native.source, availability: native.availability };
  if (native.availability === "no-usage-yet") {
    await trace(root, "context.status", { agentId, state: "NO_USAGE_YET", source: usage.source });
    return { state: "NO_USAGE_YET", usage, message: "The lead has not reported context-window usage yet. This is normal before the provider emits its first usage snapshot." };
  }
  if (native.availability !== "available" || native.ratio === undefined) {
    await trace(root, "context.status", {
      agentId,
      state: "USAGE_UNAVAILABLE",
      source: usage.source,
      used: usage.used ?? -1,
      limit: usage.limit ?? -1
    });
    return { state: "USAGE_UNAVAILABLE", usage, message: "The active provider reported usage but did not expose both contextWindowUsedTokens and contextWindowMaxTokens." };
  }

  const policy = contextPolicy(config);
  let state: ContextGuardState;
  let message: string;
  if (native.ratio < policy.pressure) {
    state = "OK";
    message = `Lead context ${(native.ratio * 100).toFixed(1)}% is below the pressure threshold.`;
  } else if (native.ratio < policy.handoff) {
    state = "PRESSURE";
    message = `Lead context ${(native.ratio * 100).toFixed(1)}% is under pressure. Stop exploratory shell work and delegate all non-semantic operations.`;
  } else if (native.ratio >= policy.hard) {
    state = "HARD_HANDOFF";
    message = `HARD_HANDOFF: context ${(native.ratio * 100).toFixed(1)}%. Responsibility must move to a fresh lead before additional engineering work.`;
  } else {
    state = "HANDOFF_REQUIRED";
    message = `HANDOFF_REQUIRED: context ${(native.ratio * 100).toFixed(1)}%. Prepare responsibility transfer to a fresh lead.`;
  }
  await trace(root, "context.status", {
    agentId,
    state,
    source: usage.source,
    used: native.used ?? -1,
    limit: native.limit ?? -1,
    ratio: native.ratio,
    pressureThreshold: policy.pressure,
    handoffThreshold: policy.handoff,
    hardHandoffThreshold: policy.hard
  });
  return { state, usage, message };
}

export async function guardLeadContext(
  root: string,
  config: HarnessProjectConfig,
  agentId: string,
  options: ContextGuardOptions = {}
): Promise<ContextGuardResult> {
  const status = await statusLeadContext(root, config, agentId, options);
  if (status.state !== "HANDOFF_REQUIRED" && status.state !== "HARD_HANDOFF") return status;

  const run = options.run ?? runProcess;
  const trace = options.trace ?? recordPaseoTrace;
  const artifactPath = await writeHandoffArtifact(root, config, agentId, status.usage, options.brief, run);
  const autoRotate = options.autoRotate ?? Boolean(process.env.PASEO_AGENT_ID);
  if (!autoRotate) {
    await trace(root, "context.handoff", { agentId, state: status.state, action: "artifact-created", handoffPath: relative(root, artifactPath) });
    return {
      ...status,
      handoffPath: artifactPath,
      message: `${status.message} Handoff artifact created at ${relative(root, artifactPath)}. Create a fresh lead with /paseo-handoff (preferred) or rerun the guard from the managed lead to rotate automatically.`
    };
  }

  const starter = options.start ?? startPaseoHarness;
  const aehCommand = options.aehCommand ?? exactAehCommand();
  const relativeHandoff = relative(root, artifactPath);
  const fresh = await starter(root, config, { forceNew: true, resume: false, handoffPath: relativeHandoff, aehCommand });
  await recordRotatedLead(artifactPath, fresh.agentId);
  await trace(root, "context.handoff", { agentId, rotatedAgentId: fresh.agentId, state: status.state, action: "rotated", handoffPath: relativeHandoff });
  return {
    ...status,
    handoffPath: artifactPath,
    rotatedAgentId: fresh.agentId,
    message: `${status.message} AEH rotated responsibility to fresh lead ${fresh.agentId} using ${relativeHandoff}. Stop engineering work in ${agentId}; the fresh lead bootstraps from deterministic artifacts.`
  };
}

export async function inspectPaseoContextUsage(
  root: string,
  agentId: string,
  inspect: Inspector = inspectPaseoNativeAgent
): Promise<ContextUsage> {
  const snapshot = await inspect(root, agentId);
  if (!snapshot) return { source: "paseo-agent-snapshot", availability: "agent-unavailable" };
  const usage = contextUsageFromPaseoSnapshot(snapshot);
  return { used: usage.used, limit: usage.limit, ratio: usage.ratio, source: usage.source, availability: usage.availability };
}

/** Compatibility helper retained for callers/tests, but intentionally strict. */
export function extractContextUsage(value: unknown): ContextUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { source: "paseo-snapshot-invalid", availability: "agent-unavailable" };
  const record = value as Record<string, unknown>;
  const usageValue = record.lastUsage ?? record;
  if (!usageValue || typeof usageValue !== "object" || Array.isArray(usageValue)) return { source: "paseo-agent-snapshot", availability: "no-usage-yet" };
  const usage = usageValue as Record<string, unknown>;
  const used = finiteNonNegative(usage.contextWindowUsedTokens);
  const limit = finitePositive(usage.contextWindowMaxTokens);
  if (used === undefined && limit === undefined) return { source: "paseo-agent-snapshot", availability: "no-usage-yet" };
  if (used === undefined || limit === undefined) return { used, limit, source: "paseo-agent-snapshot", availability: "provider-usage-unavailable" };
  return { used, limit, ratio: Math.min(used / limit, 1), source: "paseo-agent-snapshot", availability: "available" };
}

function contextPolicy(config: HarnessProjectConfig): { pressure: number; handoff: number; hard: number } {
  const context = config.orchestration?.interactive?.context;
  const pressure = clamp(context?.pressureThreshold ?? 0.70);
  const handoff = Math.max(pressure, clamp(context?.handoffThreshold ?? 0.80));
  const hard = Math.max(handoff, clamp(context?.hardHandoffThreshold ?? 0.90));
  return { pressure, handoff, hard };
}

async function writeHandoffArtifact(
  root: string,
  config: HarnessProjectConfig,
  agentId: string,
  usage: ContextUsage,
  semanticBrief: string | undefined,
  run: Runner
): Promise<string> {
  const stateDir = config.orchestration?.interactive?.stateDir ?? ".harness/paseo";
  const dir = path.resolve(root, stateDir, "handoffs");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `lead-${stamp}.json`);
  const branchResult = await run("git branch --show-current", { cwd: root, timeoutMs: 10_000 });
  const artifact: LeadHandoffArtifact = {
    version: 1,
    createdAt: new Date().toISOString(),
    reason: "CONTEXT_PRESSURE",
    project: config.project.name,
    previousAgentId: agentId,
    context: usage,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || undefined : undefined,
    activeRun: await latestJsonPath(root, config.sdd?.runsDir ?? ".harness/runs"),
    latestAudit: await existingRelative(root, ".harness/audits/latest.json"),
    latestDelivery: await latestJsonPath(root, config.delivery?.stateDir ?? ".harness/delivery"),
    semanticBrief: semanticBrief?.trim() || undefined,
    nextInstruction: "Continue as a fresh AEH Lead. Read the referenced sealed/run/audit/delivery artifacts rather than asking the previous lead to replay its full context. Re-run deterministic checks before accepting any state transition."
  };
  await fs.writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`);
  return file;
}

async function recordRotatedLead(file: string, agentId: string): Promise<void> {
  const artifact = JSON.parse(await fs.readFile(file, "utf8")) as LeadHandoffArtifact;
  artifact.rotatedAgentId = agentId;
  await fs.writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`);
}

async function latestJsonPath(root: string, relativeDir: string): Promise<string | undefined> {
  const dir = path.resolve(root, relativeDir);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const json = names.filter((name) => name.endsWith(".json"));
  if (!json.length) return undefined;
  const values = await Promise.all(json.map(async (name) => ({ name, stat: await fs.stat(path.join(dir, name)) })));
  values.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return relative(root, path.join(dir, values[0].name));
}

async function existingRelative(root: string, relativePath: string): Promise<string | undefined> {
  try { await fs.access(path.resolve(root, relativePath)); return relativePath.replaceAll("\\", "/"); }
  catch { return undefined; }
}

function exactAehCommand(): string { const entry = path.resolve(process.argv[1]); return `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function finiteNonNegative(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function finitePositive(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
