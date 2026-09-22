import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "../utils/process.js";
import type { HarnessProjectConfig } from "./types.js";

export interface GitChangeOptions {
  ignoredPaths?: string[];
}

async function namesFrom(args: readonly string[], cwd: string): Promise<string[]> {
  const result = await runExecutable("git", args, { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  const result = await runExecutable("git", ["branch", "--show-current"], { cwd });
  const branch = result.exitCode === 0 ? result.stdout.trim() : "";
  return branch || undefined;
}

export async function resolveBaseRef(cwd: string, configured = "HEAD"): Promise<{ ref: string; fallbackFrom?: string }> {
  const candidates = [...new Set([configured, await getCurrentBranch(cwd), "HEAD"].filter((value): value is string => Boolean(value)))];
  for (const candidate of candidates) {
    const result = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`], { cwd, timeoutMs: 15_000 });
    if (result.exitCode === 0 && result.stdout.trim()) return { ref: candidate, fallbackFrom: candidate === configured ? undefined : configured };
  }
  throw new Error(`No resolvable Git base ref found; configured baseRef=${configured}.`);
}

export async function getOriginRemote(cwd: string): Promise<string | undefined> {
  const result = await runExecutable("git", ["remote", "get-url", "origin"], { cwd });
  const remote = result.exitCode === 0 ? result.stdout.trim() : "";
  return remote || undefined;
}

export async function getChangedFiles(cwd: string, baseRef: string, options: GitChangeOptions = {}): Promise<string[]> {
  const baseCommit = await resolveCommit(cwd, baseRef);
  const sets = await Promise.all([
    baseCommit ? namesFrom(["diff", "--name-only", "--no-ext-diff", `${baseCommit}...HEAD`], cwd) : Promise.resolve([]),
    namesFrom(["diff", "--name-only"], cwd),
    namesFrom(["diff", "--cached", "--name-only"], cwd),
    namesFrom(["ls-files", "--others", "--exclude-standard"], cwd)
  ]);
  return [...new Set(sets.flat())].filter((file) => !isIgnoredPath(file, options.ignoredPaths ?? [])).sort();
}

/** Digest the actual current source tree, including unstaged and untracked files. */
export async function computeWorktreeDigest(cwd: string): Promise<string> {
  let files: string[];
  try {
    files = await listWorktreeDigestPaths(cwd);
  } catch {
    files = await fallbackSourceFiles(cwd);
  }
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    hash.update(`path\0${normalized}\0`);
    try {
      const stat = await fs.lstat(path.resolve(cwd, file));
      if (stat.isSymbolicLink()) hash.update(`symlink\0${await fs.readlink(path.resolve(cwd, file))}\0`);
      else hash.update(await fs.readFile(path.resolve(cwd, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing\0");
    }
  }
  return hash.digest("hex");
}

/**
 * Return the exact Git path inventory hashed by computeWorktreeDigest when Git
 * enumeration is available. Callers that use this as a read boundary must
 * fail closed when Git cannot establish the tracked/non-ignored file set.
 */
export async function listWorktreeDigestPaths(cwd: string): Promise<string[]> {
  const filesResult = await runExecutable("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, timeoutMs: 15_000 });
  if (filesResult.exitCode !== 0) throw new Error("Git could not enumerate the worktree digest file set.");
  return [...new Set(filesResult.stdout.split("\0").filter(Boolean))].sort();
}

async function fallbackSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", ".harness", "dist", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  await visit(root);
  return files.sort();
}

export async function getDiffStats(cwd: string, baseRef: string, options: GitChangeOptions = {}): Promise<{ files: number; added: number; deleted: number }> {
  const baseCommit = await resolveCommit(cwd, baseRef);
  const result = baseCommit ? await runExecutable("git", ["diff", "--numstat", "--no-ext-diff", `${baseCommit}...HEAD`], { cwd }) : { stdout: "", stderr: "", exitCode: 1, durationMs: 0 };
  const worktree = await runExecutable("git", ["diff", "--numstat"], { cwd });
  const staged = await runExecutable("git", ["diff", "--cached", "--numstat"], { cwd });
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

async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
  const result = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, timeoutMs: 15_000 });
  const commit = result.stdout.trim();
  return result.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit : undefined;
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
