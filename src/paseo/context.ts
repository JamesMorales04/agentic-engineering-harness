import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { runProcess } from "../utils/process.js";

export type ContextGuardState = "OK" | "PRESSURE" | "HANDOFF_REQUIRED" | "HARD_HANDOFF" | "UNKNOWN";
export interface ContextUsage { used?: number; limit?: number; ratio?: number; source: string; }
export interface LeadHandoffArtifact {
  version: 1;
  createdAt: string;
  reason: "CONTEXT_PRESSURE";
  project: string;
  previousAgentId: string;
  context: ContextUsage;
  branch?: string;
  activeRun?: string;
  latestAudit?: string;
  latestDelivery?: string;
  semanticBrief?: string;
  nextInstruction: string;
}
export interface ContextGuardResult { state: ContextGuardState; usage: ContextUsage; handoffPath?: string; message: string; }

type Runner = typeof runProcess;

export async function guardLeadContext(root: string, config: HarnessProjectConfig, agentId: string, options: { brief?: string; run?: Runner } = {}): Promise<ContextGuardResult> {
  const run = options.run ?? runProcess;
  const policy = contextPolicy(config);
  const usage = await inspectPaseoContextUsage(root, agentId, run);
  if (usage.ratio === undefined) return { state: "UNKNOWN", usage, message: "Paseo did not expose a stable context-usage ratio; continue with delegation-first behavior and prefer a fresh lead on the next aeh start." };
  if (usage.ratio < policy.pressure) return { state: "OK", usage, message: `Lead context ${(usage.ratio * 100).toFixed(1)}% is below the pressure threshold.` };
  if (usage.ratio < policy.handoff) return { state: "PRESSURE", usage, message: `Lead context ${(usage.ratio * 100).toFixed(1)}% is under pressure. Stop exploratory shell work and delegate all non-semantic operations.` };
  const artifact = await writeHandoffArtifact(root, config, agentId, usage, options.brief, run);
  const state: ContextGuardState = usage.ratio >= policy.hard ? "HARD_HANDOFF" : "HANDOFF_REQUIRED";
  return { state, usage, handoffPath: artifact, message: `${state}: context ${(usage.ratio * 100).toFixed(1)}%. Create a fresh lead with /paseo-handoff (preferred) or the Paseo create_agent tool and use ${path.relative(root, artifact).replaceAll("\\", "/")} as the deterministic briefing source. Do not compact and continue the engineering workflow in the old lead.` };
}

export async function inspectPaseoContextUsage(root: string, agentId: string, run: Runner = runProcess): Promise<ContextUsage> {
  const attempts = [
    `paseo ls -a -g --json`,
    `paseo logs ${quote(agentId)} --tail 5 --json`
  ];
  for (const command of attempts) {
    const result = await run(command, { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) continue;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      const agent = findAgent(parsed, agentId) ?? parsed;
      const usage = extractContextUsage(agent);
      if (usage.ratio !== undefined) return usage;
    } catch { /* older Paseo or non-JSON output */ }
  }
  return { source: "unavailable" };
}

export function extractContextUsage(value: unknown): ContextUsage {
  const pairs = collectNumericFields(value);
  const explicitRatio = first(pairs, ["contextusage", "contextusageratio", "contextpercentage", "contextpercent", "windowusage", "contextutilization"]);
  if (explicitRatio !== undefined) {
    const ratio = explicitRatio > 1 ? explicitRatio / 100 : explicitRatio;
    if (ratio >= 0 && ratio <= 1.5) return { ratio: Math.min(ratio, 1), source: "paseo-explicit-ratio" };
  }
  const used = first(pairs, ["contexttokens", "contextused", "usedcontexttokens", "tokensused", "totaltokens", "inputtokens"]);
  const limit = first(pairs, ["contextwindow", "contextlimit", "contextwindowtokens", "maxtokens", "tokenlimit"]);
  if (used !== undefined && limit !== undefined && limit > 0) return { used, limit, ratio: Math.min(used / limit, 1), source: "paseo-token-fields" };
  return { used, limit, source: "paseo-snapshot-no-ratio" };
}

function contextPolicy(config: HarnessProjectConfig): { pressure: number; handoff: number; hard: number } {
  const context = config.orchestration?.interactive?.context;
  const pressure = clamp(context?.pressureThreshold ?? 0.70);
  const handoff = Math.max(pressure, clamp(context?.handoffThreshold ?? 0.80));
  const hard = Math.max(handoff, clamp(context?.hardHandoffThreshold ?? 0.90));
  return { pressure, handoff, hard };
}

async function writeHandoffArtifact(root: string, config: HarnessProjectConfig, agentId: string, usage: ContextUsage, semanticBrief: string | undefined, run: Runner): Promise<string> {
  const stateDir = config.orchestration?.interactive?.stateDir ?? ".harness/paseo";
  const dir = path.resolve(root, stateDir, "handoffs"); await fs.mkdir(dir, { recursive: true });
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

async function latestJsonPath(root: string, relativeDir: string): Promise<string | undefined> {
  const dir = path.resolve(root, relativeDir);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const json = names.filter((name) => name.endsWith(".json"));
  if (!json.length) return undefined;
  const values = await Promise.all(json.map(async (name) => ({ name, stat: await fs.stat(path.join(dir, name)) })));
  values.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return path.relative(root, path.join(dir, values[0].name)).replaceAll("\\", "/");
}
async function existingRelative(root: string, relative: string): Promise<string | undefined> { try { await fs.access(path.resolve(root, relative)); return relative.replaceAll("\\", "/"); } catch { return undefined; } }
function findAgent(value: unknown, id: string): unknown { if (Array.isArray(value)) { for (const child of value) { const found = findAgent(child, id); if (found) return found; } return undefined; } if (!value || typeof value !== "object") return undefined; const record = value as Record<string, unknown>; if ([record.id, record.agentId, record.agent_id].some((item) => item === id)) return record; for (const child of Object.values(record)) { const found = findAgent(child, id); if (found) return found; } return undefined; }
function collectNumericFields(value: unknown, out = new Map<string, number>()): Map<string, number> { if (Array.isArray(value)) { for (const child of value) collectNumericFields(child, out); return out; } if (!value || typeof value !== "object") return out; for (const [key, child] of Object.entries(value as Record<string, unknown>)) { const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, ""); if (typeof child === "number" && Number.isFinite(child) && !out.has(normalized)) out.set(normalized, child); else collectNumericFields(child, out); } return out; }
function first(values: Map<string, number>, keys: string[]): number | undefined { for (const key of keys) { const value = values.get(key); if (value !== undefined) return value; } return undefined; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
