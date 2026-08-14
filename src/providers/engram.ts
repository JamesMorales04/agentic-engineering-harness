import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryProvider, MemoryRecord } from "./types.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface EngramOptions { command?: string; storagePath?: string; maxRecall?: number; executor?: typeof runProcess; }

export class EngramMemoryProvider implements MemoryProvider {
  readonly name = "engram";
  private readonly command: string;
  private readonly storagePath: string;
  private readonly maxRecall: number;
  private readonly executor: typeof runProcess;

  constructor(private readonly root: string, options: EngramOptions = {}) {
    this.command = options.command ?? "engram";
    this.storagePath = path.resolve(root, options.storagePath ?? ".harness/memory/engram.ndjson");
    this.maxRecall = options.maxRecall ?? 8;
    this.executor = options.executor ?? runProcess;
  }

  async doctor(root: string): Promise<{ ok: boolean; message: string; version?: string }> {
    if (!(await commandExists(this.command, root))) return { ok: false, message: `Engram executable '${this.command}' was not found in the reconciled toolchain PATH.` };
    const result = await this.executor(`${quote(this.command)} doctor`, { cwd: root, timeoutMs: 20_000 });
    if (result.exitCode !== 0) return { ok: false, message: `Engram health check failed: ${result.stderr || result.stdout}` };
    const version = (result.stdout || result.stderr).match(/v?\d+\.\d+(?:\.\d+)?/)?.[0];
    return {
      ok: true,
      version,
      message: `Engram memory provider ready${version ? ` (${version})` : ""}; memory is advisory.`
    };
  }

  async remember(record: MemoryRecord): Promise<string | undefined> {
    const normalized = normalizeRecord(record); const records = await this.readLedger();
    const duplicate = records.find((item) => fingerprint(item) === fingerprint(normalized));
    if (duplicate) return duplicate.id;
    const id = normalized.id ?? fingerprint(normalized).slice(0, 24); const stored = { ...normalized, id };
    const payload = JSON.stringify({ ...stored, advisory: true, provenance: stored.source });
    const result = await this.executor(`${quote(this.command)} store ${quote(payload)} --type semantic --importance 0.5 --namespace ${quote(normalized.project)} --source aeh`, { cwd: this.root, timeoutMs: 30_000, env: { ENGRAM_NAMESPACE_MODE: "isolated", ENGRAM_NAMESPACE: normalized.project } });
    if (result.exitCode !== 0) throw new Error(`Engram remember failed: ${result.stderr || result.stdout}`);
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true }); await fs.appendFile(this.storagePath, `${JSON.stringify(stored)}\n`, "utf8");
    return id;
  }

  async recall(project: string, query: string): Promise<MemoryRecord[]> {
    if (!project.trim() || !query.trim()) return [];
    const all = await this.readLedger();
    const local = (await filterStaleRecords(this.root, all)).filter((record) => record.project === project && !all.some((candidate) => candidate.supersedes === record.id && candidate.project === project) && matches(record, query)).slice(-this.maxRecall).reverse();
    const result = await this.executor(`${quote(this.command)} recall ${quote(query)} --json`, { cwd: this.root, timeoutMs: 30_000, env: { ENGRAM_NAMESPACE_MODE: "isolated", ENGRAM_NAMESPACE: project } });
    if (result.exitCode !== 0) throw new Error(`Engram recall failed: ${result.stderr || result.stdout}`);
    return dedupe([...local, ...parseRecords(result.stdout, project)]).slice(0, this.maxRecall);
  }

  private async readLedger(): Promise<MemoryRecord[]> {
    try { return (await fs.readFile(this.storagePath, "utf8")).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [normalizeRecord(JSON.parse(line) as MemoryRecord)]; } catch { return []; } }); }
    catch { return []; }
  }
}

export async function createMemoryProvider(root: string, config: { memory?: { provider?: string; required?: boolean } }): Promise<MemoryProvider | undefined> {
  const provider = config.memory?.provider;
  if (!provider || provider === "none") return undefined;
  if (provider !== "engram") throw new Error(`Unsupported memory provider '${provider}'.`);
  const instance = new EngramMemoryProvider(root); const health = await instance.doctor(root);
  if (!health.ok) { if (config.memory?.required) throw new Error(`Required memory provider unavailable: ${health.message}`); return undefined; }
  return instance;
}

export function memoryFingerprint(record: MemoryRecord): string { return fingerprint(normalizeRecord(record)); }
export async function filterStaleRecords(root: string, records: MemoryRecord[]): Promise<MemoryRecord[]> {
  const result: MemoryRecord[] = [];
  for (const record of records) {
    if (!record.source || !record.sourceSha256) { result.push(record); continue; }
    try { const actual = crypto.createHash("sha256").update(await fs.readFile(path.resolve(root, record.source))).digest("hex"); if (actual === record.sourceSha256) result.push(record); }
    catch { /* an unavailable provenance artifact is stale, not authoritative */ }
  }
  return result;
}
function normalizeRecord(record: MemoryRecord): MemoryRecord { if (!record.project?.trim() || !record.title?.trim() || !record.content?.trim()) throw new Error("Memory records require project, title and content."); return { ...record, project: record.project.trim(), title: record.title.trim(), content: record.content.trim(), tags: [...new Set(record.tags ?? [])].sort() }; }
function fingerprint(record: MemoryRecord): string { return crypto.createHash("sha256").update(JSON.stringify({ project: record.project, type: record.type, title: record.title, content: record.content, tags: record.tags ?? [] })).digest("hex"); }
function matches(record: MemoryRecord, query: string): boolean { const haystack = `${record.title} ${record.content} ${(record.tags ?? []).join(" ")}`.toLocaleLowerCase(); return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).some((term) => haystack.includes(term)); }
function parseRecords(stdout: string, project: string): MemoryRecord[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const values: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).memories) ? (parsed as Record<string, unknown>).memories as unknown[] : [parsed];
    return values.flatMap((item) => parseRecord(item, project));
  } catch {
    return stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return parseRecord(JSON.parse(line), project); } catch { return []; } });
  }
}
function parseRecord(item: unknown, project: string): MemoryRecord[] {
  if (!item || typeof item !== "object") return [];
  const value = item as Record<string, unknown>;
  if (typeof value.content !== "string") return [];
  let embedded: Record<string, unknown> | undefined;
  try { const parsed = JSON.parse(value.content) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) embedded = parsed as Record<string, unknown>; } catch { /* ordinary Engram content */ }
  if (typeof value.project === "string" && value.project !== project) return [];
  if (embedded?.project && embedded.project !== project) return [];
  const source = embedded ?? value;
  const title = typeof source.title === "string" ? source.title : typeof value.title === "string" ? value.title : "Engram recalled memory";
  const content = typeof embedded?.content === "string" ? embedded.content : value.content;
  return [normalizeRecord({ project, type: typeof source.type === "string" ? source.type : "discovery", title, content, id: typeof source.id === "string" ? source.id : typeof value.id === "string" ? value.id : undefined, source: typeof source.source === "string" ? source.source : typeof value.source === "string" ? value.source : undefined, sourceSha256: typeof source.sourceSha256 === "string" ? source.sourceSha256 : undefined, tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string") : undefined })];
}
function dedupe(records: MemoryRecord[]): MemoryRecord[] { const seen = new Set<string>(); return records.filter((record) => { const key = fingerprint(record); if (seen.has(key)) return false; seen.add(key); return true; }); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
