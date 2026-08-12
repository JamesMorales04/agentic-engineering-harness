import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, McpServerConfig } from "../core/types.js";
import { commandExists } from "../utils/process.js";

export interface McpBenchmarkResult {
  server: string;
  type: "local" | "remote";
  available: boolean;
  baselineConfigTokens: number;
  permissionSurfaceScore: number;
  staleDataRisk: "low" | "medium" | "high";
  latencyMs?: { median: number; min: number; max: number; samples: number[] };
  notes: string[];
}
export interface McpBenchmarkReport { version: 1; generatedAt: string; results: McpBenchmarkResult[]; packs: Record<string, string[]>; }

export async function benchmarkMcpCatalog(root: string, config: HarnessProjectConfig, names?: string[]): Promise<McpBenchmarkReport> {
  const catalog = config.mcp?.servers ?? {}; const selected = names?.length ? names : Object.keys(catalog).filter((name) => catalog[name].enabled !== false); const repetitions = config.mcp?.benchmark?.repetitions ?? 3;
  const results: McpBenchmarkResult[] = [];
  for (const name of selected) { const server = catalog[name]; if (!server) throw new Error(`Unknown MCP server '${name}'.`); results.push(await benchmarkOne(root, name, server, repetitions)); }
  const packs: Record<string, string[]> = {}; for (const [name, pack] of Object.entries(config.mcp?.packs ?? {})) if (pack.enabled !== false) packs[name] = pack.servers.filter((server) => Boolean(catalog[server]));
  const report: McpBenchmarkReport = { version: 1, generatedAt: new Date().toISOString(), results: results.sort((a, b) => a.server.localeCompare(b.server)), packs };
  const output = path.resolve(root, config.mcp?.benchmark?.resultsDir ?? ".harness/mcp-benchmarks", `${Date.now()}.json`); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`); return report;
}

export function resolveMcpPack(config: HarnessProjectConfig, pack: string): string[] { const value = config.mcp?.packs?.[pack]; if (!value || value.enabled === false) throw new Error(`Unknown or disabled MCP pack '${pack}'.`); const catalog = config.mcp?.servers ?? {}; const missing = value.servers.filter((name) => !catalog[name]); if (missing.length) throw new Error(`MCP pack '${pack}' references unknown servers: ${missing.join(", ")}`); return [...new Set(value.servers)]; }

async function benchmarkOne(root: string, name: string, server: McpServerConfig, repetitions: number): Promise<McpBenchmarkResult> {
  const notes: string[] = []; const serialized = JSON.stringify({ name, ...server }); const baselineConfigTokens = Math.ceil(serialized.length / 4); const samples: number[] = []; let available = false;
  if (server.type === "local") {
    const command = server.command?.[0]; available = Boolean(command && await commandExists(command, root));
    if (!available) notes.push(`local command '${command ?? "<missing>"}' unavailable`);
    else for (let index = 0; index < repetitions; index += 1) { const started = performance.now(); await commandExists(command!, root); samples.push(performance.now() - started); }
  } else {
    for (let index = 0; index < repetitions; index += 1) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Math.min(server.timeoutMs ?? 10_000, 10_000)); const started = performance.now();
      try { const response = await fetch(server.url!, { method: "HEAD", headers: resolvedHeaders(server.headers), signal: controller.signal }); samples.push(performance.now() - started); available = available || response.status < 500; if (response.status === 401 || response.status === 403) notes.push(`probe reached server but authentication is required (HTTP ${response.status})`); }
      catch (error) { notes.push(`probe failed: ${String(error)}`); }
      finally { clearTimeout(timeout); }
    }
  }
  const permissionSurfaceScore = permissionSurface(server); const staleDataRisk = staleRisk(name, server); if (baselineConfigTokens > 500) notes.push("large MCP configuration footprint; measure runtime tool-schema overhead before broad enablement");
  return { server: name, type: server.type, available, baselineConfigTokens, permissionSurfaceScore, staleDataRisk, latencyMs: samples.length ? summarizeLatency(samples) : undefined, notes: [...new Set(notes)] };
}
function permissionSurface(server: McpServerConfig): number { let score = server.type === "remote" ? 2 : 1; score += Object.keys(server.environment ?? {}).length; score += Object.keys(server.headers ?? {}).length; if (server.oauth) score += 2; if (server.command?.some((item) => /docker|podman|kubectl|terraform|gh|aws|gcloud|az/i.test(item))) score += 3; if (/write|admin|mutation/i.test(server.description ?? "")) score += 4; return score; }
function staleRisk(name: string, server: McpServerConfig): "low" | "medium" | "high" { const text = `${name} ${server.description ?? ""}`.toLowerCase(); if (/database|cluster|kubernetes|production|inventory|cloud/.test(text)) return "high"; if (/docs|documentation|issue|sentry|observability|search/.test(text)) return "medium"; return "low"; }
function summarizeLatency(samples: number[]): { median: number; min: number; max: number; samples: number[] } { const sorted = [...samples].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; return { median, min: sorted[0], max: sorted.at(-1)!, samples }; }
function resolvedHeaders(headers?: Record<string, string>): Headers { const result = new Headers(); for (const [name, value] of Object.entries(headers ?? {})) result.set(name, value.replace(/\{env:([^}]+)\}/g, (_, env: string) => process.env[env] ?? "")); return result; }
