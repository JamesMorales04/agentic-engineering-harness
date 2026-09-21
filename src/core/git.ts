import { runProcess } from "../utils/process.js";
import type { HarnessProjectConfig } from "./types.js";

export interface GitChangeOptions {
  ignoredPaths?: string[];
}

async function namesFrom(command: string, cwd: string): Promise<string[]> {
  const result = await runProcess(command, { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  const result = await runProcess("git branch --show-current", { cwd });
  const branch = result.exitCode === 0 ? result.stdout.trim() : "";
  return branch || undefined;
}

export async function resolveBaseRef(cwd: string, configured = "HEAD"): Promise<{ ref: string; fallbackFrom?: string }> {
  const candidates = [...new Set([configured, await getCurrentBranch(cwd), "HEAD"].filter((value): value is string => Boolean(value)))];
  for (const candidate of candidates) {
    const result = await runProcess(`git rev-parse --verify ${shellQuote(`${candidate}^{commit}`)}`, { cwd, timeoutMs: 15_000 });
    if (result.exitCode === 0 && result.stdout.trim()) return { ref: candidate, fallbackFrom: candidate === configured ? undefined : configured };
  }
  throw new Error(`No resolvable Git base ref found; configured baseRef=${configured}.`);
}

export async function getOriginRemote(cwd: string): Promise<string | undefined> {
  const result = await runProcess("git remote get-url origin", { cwd });
  const remote = result.exitCode === 0 ? result.stdout.trim() : "";
  return remote || undefined;
}

export async function getChangedFiles(cwd: string, baseRef: string, options: GitChangeOptions = {}): Promise<string[]> {
  const sets = await Promise.all([
    namesFrom(`git diff --name-only ${shellQuote(baseRef)}...HEAD`, cwd),
    namesFrom("git diff --name-only", cwd),
    namesFrom("git diff --cached --name-only", cwd),
    namesFrom("git ls-files --others --exclude-standard", cwd)
  ]);
  return [...new Set(sets.flat())].filter((file) => !isIgnoredPath(file, options.ignoredPaths ?? [])).sort();
}

export async function getDiffStats(cwd: string, baseRef: string, options: GitChangeOptions = {}): Promise<{ files: number; added: number; deleted: number }> {
  const result = await runProcess(`git diff --numstat ${shellQuote(baseRef)}...HEAD`, { cwd });
  const worktree = await runProcess("git diff --numstat", { cwd });
  const staged = await runProcess("git diff --cached --numstat", { cwd });
  const rows = [result.stdout, worktree.stdout, staged.stdout].join("\n").split(/\r?\n/).filter(Boolean);
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    const [a, d, ...fileParts] = row.split(/\s+/);
    if (isIgnoredPath(fileParts.join(" "), options.ignoredPaths ?? [])) continue;
    if (a && a !== "-") added += Number(a) || 0;
    if (d && d !== "-") deleted += Number(d) || 0;
  }
  const changed = await getChangedFiles(cwd, baseRef, options);
  return { files: changed.length, added, deleted };
}

/** Provider-owned outputs must not become product-scope changes during validation. */
export function generatedArtifactPaths(config: HarnessProjectConfig): string[] {
  const codeIntelligence = config.codeIntelligence;
  const paths = config.context?.semanticRetrieval?.provider === "serena" ? [".serena"] : [];
  if (codeIntelligence?.provider === "graphify") paths.push("graphify-out", codeIntelligence.graphPath ?? "graphify-out/graph.json", codeIntelligence.snapshotDir ?? ".harness/graphify");
  return paths;
}

function isIgnoredPath(file: string, ignoredPaths: string[]): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return ignoredPaths.some((ignored) => {
    const prefix = ignored.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
