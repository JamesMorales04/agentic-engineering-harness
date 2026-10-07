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

/**
 * Absolute git metadata roots of a worktree: the worktree-private git dir and the
 * shared common dir. These are the only git-internal paths a managed provider session
 * may touch outside its project root (AEH-V2-0116); source access stays governed by the
 * compiled tool ceiling.
 */
export async function worktreeGitRoots(cwd: string): Promise<string[]> {
  const [gitDir, commonDir] = await Promise.all([
    runExecutable("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeoutMs: 15_000 }),
    runExecutable("git", ["rev-parse", "--git-common-dir"], { cwd, timeoutMs: 15_000 })
  ]);
  const roots = new Set<string>();
  if (gitDir.exitCode === 0 && gitDir.stdout.trim()) roots.add(path.resolve(gitDir.stdout.trim()));
  if (commonDir.exitCode === 0 && commonDir.stdout.trim()) {
    const value = commonDir.stdout.trim();
    roots.add(path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value));
  }
  return [...roots].sort();
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

/**
 * Untracked provider-owned directories never contribute to candidate/repository identity.
 * Provider sessions (Serena semantic retrieval, Graphify code intelligence) activate and update
 * project-local scratch inside the workspace while an operation runs; that scratch is not product
 * source, must not become scope or change evidence, and must not destabilize a bound candidate
 * digest. Tracked files always contribute, so a repository that deliberately versions provider
 * configuration keeps its normal change detection.
 */
const PROVIDER_GENERATED_PREFIXES = [".serena", "graphify-out"];

/** Git pathspec exclusions for provider-owned scratch that must never enter a candidate ChangeSet. */
export function providerGeneratedPathspecExcludes(): string[] {
  return PROVIDER_GENERATED_PREFIXES.flatMap((prefix) => [`:(exclude)${prefix}`, `:(exclude)${prefix}/**`]);
}

function isProviderGeneratedPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return PROVIDER_GENERATED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

/** Digest the actual current source tree, including unstaged and untracked files.
 *
 * Decision mechanism: DETERMINISTIC. Every entry is hashed through the
 * canonical framed combiner `updateDigestWithEntry` under the `aeh-tree-v2`
 * scheme tag (see `TREE_DIGEST_SCHEME`): distinct length-prefixed type tags
 * (`file` / `symlink` / `missing`), length-prefixed path bytes,
 * length-prefixed mode bytes, and a 64-bit length-prefixed content payload.
 * A regular file whose content bytes mimic another entry kind's encoding can
 * therefore never digest like that entry kind. Backslash path-key
 * normalization is shared verbatim with `computeCommitTreeDigest`
 * (DOCUMENTED-ONLY: changing path-key encoding would migrate every
 * historical identity digest).
 */
export async function computeWorktreeDigest(cwd: string): Promise<string> {
  let files: string[];
  try {
    files = await listWorktreeDigestPaths(cwd);
  } catch {
    files = await fallbackSourceFiles(cwd);
  }
  const hash = crypto.createHash("sha256");
  hash.update(TREE_DIGEST_SCHEME_TAG);
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    try {
      const stat = await fs.lstat(path.resolve(cwd, file));
      if (stat.isSymbolicLink()) {
        updateDigestWithEntry(hash, {
          type: "symlink",
          path: normalized,
          mode: "120000",
          content: await fs.readlink(path.resolve(cwd, file), { encoding: "buffer" })
        });
      } else if (stat.isFile()) {
        updateDigestWithEntry(hash, {
          type: "file",
          path: normalized,
          // The executable bit is source identity: 100755 must never digest
          // like 100644 for the same bytes. Git checks out the committed
          // mode, so a clean tree agrees with `computeCommitTreeDigest`.
          mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
          content: await fs.readFile(path.resolve(cwd, file))
        });
      } else {
        // Directories (e.g. checked-out submodule worktrees), sockets and
        // other non-file/non-symlink entries have no defined content
        // encoding: fail closed rather than hashing an ambiguous projection.
        throw new Error(`Git worktree digest entry '${file}' is not a file, symlink or absent path.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A path that vanished between enumeration and read (worktree race)
      // hashes its tag + path with ZERO content length and NO content-shaped
      // bytes, so a file containing `missing\0`-shaped bytes can never alias it.
      updateDigestWithEntry(hash, { type: "missing", path: normalized, mode: "", content: null });
    }
  }
  return hash.digest("hex");
}

/**
 * Tree-digest framing scheme tag. Every `computeWorktreeDigest` /
 * `computeCommitTreeDigest` hash input starts with these exact bytes, so a
 * digest produced under a different (past or future) framing scheme is
 * structurally distinct and future scheme changes are explicit.
 */
export const TREE_DIGEST_SCHEME = "aeh-tree-v2";

/** Raw hash-input bytes for the scheme tag (scheme + NUL separator). */
const TREE_DIGEST_SCHEME_TAG = Buffer.from(`${TREE_DIGEST_SCHEME}\0`, "utf8");

/** Entry kinds distinguished by the framed combiner. Never raw content bytes. */
type TreeDigestEntryType = "file" | "symlink" | "missing";

interface TreeDigestEntry {
  type: TreeDigestEntryType;
  /** Backslash-normalized repository-relative path (path-key encoding is DOCUMENTED-ONLY shared). */
  path: string;
  /** Git mode string (`100644` / `100755` / `120000`; empty for `missing`). */
  mode: string;
  /** Entry payload bytes; `null` for `missing` (hashes zero length, no content bytes). */
  content: Buffer | null;
}

function u32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u64be(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

/** Length-prefixed field: `u32be(byteLength) + bytes` (unambiguous boundary). */
function updateDigestWithField(hash: crypto.Hash, bytes: Buffer): void {
  hash.update(u32be(bytes.length));
  hash.update(bytes);
}

/**
 * Canonical per-entry combiner shared by worktree and commit-tree digests.
 *
 * Decision mechanism: DETERMINISTIC. The hashed stream per entry is exactly:
 * `u32be(typeLen) + typeUtf8 + u32be(pathLen) + pathUtf8 + u32be(modeLen) +
 * modeUtf8 + u64be(contentLen) + contentBytes`, where `type` is one of the
 * distinct constants `file` / `symlink` / `missing` (never content-derived)
 * and a `missing` entry contributes zero content length with no content
 * bytes. Every variable-length field is length-prefixed, so no two distinct
 * `(type, path, mode, content)` tuples share a byte stream (exact-alias
 * resistance, not hash-collision resistance).
 */
function updateDigestWithEntry(hash: crypto.Hash, entry: TreeDigestEntry): void {
  updateDigestWithField(hash, Buffer.from(entry.type, "utf8"));
  updateDigestWithField(hash, Buffer.from(entry.path, "utf8"));
  updateDigestWithField(hash, Buffer.from(entry.mode, "utf8"));
  if (entry.content === null) {
    hash.update(u64be(0));
    return;
  }
  hash.update(u64be(entry.content.length));
  hash.update(entry.content);
}

/**
 * Digest the COMMITTED tree at `ref` (default HEAD), not the live worktree.
 *
 * Decision mechanism: DETERMINISTIC. Enumerates `git ls-tree -r --name-only`
 * and reads each blob via `git show <ref>:<path>`, applying the SAME
 * canonical framed per-entry combiner `computeWorktreeDigest` uses
 * (`aeh-tree-v2` scheme tag, then per entry: length-prefixed type tag
 * `file` / `symlink`, length-prefixed path, length-prefixed Git mode, and
 * 64-bit length-prefixed content bytes). A stale HEAD subject with a dirty
 * worktree therefore cannot masquerade as the intended commit: only committed
 * bytes match.
 *
 * Blob bytes are hashed RAW from `ProcessResult.stdoutBuffer` (opted in via
 * `rawStdout`): they never pass through the lossy UTF-8 `stdout` decode, so
 * a non-UTF-8 byte such as 0xFF cannot hash like the valid UTF-8 U+FFFD
 * sequence and falsely match a contentDigest. Symlink targets hash as RAW BYTES on both paths — the
 * worktree via `readlink` with `buffer` encoding and the committed tree via
 * `git show` `stdoutBuffer` fed directly to the combiner with no
 * `toString("utf8")` on either side — so distinct invalid sequences such as
 * 0xFF vs 0xFE (both decoding to U+FFFD as strings) digest distinctly.
 * `git show <ref>:<path>` emits the raw blob with no framing newline (matching
 * `readlink`), so no trailing-newline strip is applied and a target of
 * `target\n` never digests like `target`. Both digest paths consume the same
 * ls-tree enumeration inputs through the same combiner; no cross-encoding
 * comparison is performed. NOTE (documented only, out of scope): both paths
 * share the identical backslash path-key normalization, so no asymmetric
 * false-accept exists there; changing path-key encoding would migrate every
 * historical identity digest.
 *
 * Resource bound (DETERMINISTIC fail-closed): each blob is read with
 * `captureOutputLimitBytes: maxBlobBytes` so a huge historical blob cannot
 * exhaust controller memory via full `stdoutBuffer` retention. Truncation is
 * detected via the total-vs-retained signal (`ProcessResult.stdoutBytes` is
 * the TOTAL streamed byte count; `stdoutBuffer.length` is the RETAINED
 * count): `BoundedOutput` retains the TAIL when limited, so truncated bytes
 * must NEVER be hashed. An oversize/truncated blob throws `COMMIT_BLOB_TOO_LARGE`
 * (naming path + total size vs cap); callers map this to UNKNOWN, never SUCCEEDED.
 */
export const COMMIT_TREE_MAX_BLOB_BYTES = 32 * 1024 * 1024;

export async function computeCommitTreeDigest(cwd: string, ref = "HEAD", maxBlobBytes = COMMIT_TREE_MAX_BLOB_BYTES): Promise<string> {
  const cap = Math.floor(maxBlobBytes);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`COMMIT_BLOB_CAP_INVALID: maxBlobBytes must be a positive finite byte count (got ${String(maxBlobBytes)}).`);
  const entries = await listCommitTreeEntries(cwd, ref);
  const hash = crypto.createHash("sha256");
  hash.update(TREE_DIGEST_SCHEME_TAG);
  for (const { path: file, mode } of entries) {
    const normalized = file.replaceAll("\\", "/");
    const shown = await runExecutable("git", ["show", `${ref}:${file}`], { cwd, timeoutMs: 15_000, rawStdout: true, captureOutputLimitBytes: cap });
    if (shown.exitCode !== 0) throw new Error(`Git could not read committed blob '${file}' at ${ref}.`);
    // Fail closed when the raw bytes are unavailable: falling back to the
    // lossy `stdout` text would reintroduce the UTF-8 collision (never a
    // false SUCCEEDED from a decode round-trip).
    if (!shown.stdoutBuffer) throw new Error(`Git committed blob bytes unavailable for '${file}' at ${ref}.`);
    // Fail closed on oversize/truncation: `stdoutBytes` is the TOTAL streamed
    // count while `stdoutBuffer.length` is RETAINED (capped tail). NEVER hash
    // partial bytes: `BoundedOutput` keeps the TAIL when limited, so hashing
    // the retained buffer would hash the wrong bytes.
    const retained = shown.stdoutBuffer.length;
    const total = shown.stdoutBytes ?? retained;
    if (total > retained || total > cap || retained > cap) {
      throw new Error(`COMMIT_BLOB_TOO_LARGE: committed blob '${file}' at ${ref} is ${total} bytes (cap ${cap} bytes).`);
    }
    // The Git mode is a framed digest input, not just a symlink probe: an
    // unsupported mode (e.g. gitlink 160000) has no defined content encoding
    // and fails closed instead of hashing an ambiguous projection.
    if (mode !== "120000" && mode !== "100644" && mode !== "100755") {
      throw new Error(`Git tree entry '${file}' at ${ref} has unsupported mode '${mode}' for digest framing.`);
    }
    updateDigestWithEntry(hash, {
      type: mode === "120000" ? "symlink" : "file",
      path: normalized,
      mode,
      content: shown.stdoutBuffer
    });
  }
  return hash.digest("hex");
}

interface CommitTreeEntry {
  path: string;
  mode: string;
}

async function listCommitTreeEntries(cwd: string, ref: string): Promise<CommitTreeEntry[]> {
  const listed = await runExecutable("git", ["ls-tree", "-r", "-z", ref, "--"], { cwd, timeoutMs: 15_000 });
  if (listed.exitCode !== 0) throw new Error(`Git could not enumerate the committed tree at ${ref}.`);
  const entries: CommitTreeEntry[] = [];
  for (const record of listed.stdout.split("\0")) {
    if (!record) continue;
    // Format: "<mode> <type> <sha>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const file = record.slice(tab + 1);
    if (!meta[0] || !file) continue;
    entries.push({ path: file, mode: meta[0] });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Return the committed path inventory hashed by `computeCommitTreeDigest`.
 * Fails closed when Git cannot establish the tree.
 */
export async function listCommitTreePaths(cwd: string, ref = "HEAD"): Promise<string[]> {
  return (await listCommitTreeEntries(cwd, ref)).map((entry) => entry.path);
}

/**
 * Return the exact Git path inventory hashed by computeWorktreeDigest when Git
 * enumeration is available. Callers that use this as a read boundary must
 * fail closed when Git cannot establish the tracked/non-ignored file set.
 *
 * `git add -N` (intent-to-add) entries surface under `git ls-files --cached`
 * even though they carry no committed content, so provider-owned scratch could
 * otherwise be smuggled into a digest. Intent-to-add entries are classified
 * deterministically from `git status --porcelain=v2` (XY ".A") and only
 * provider-generated ones are excluded; genuinely tracked provider files and
 * legitimate intent-to-add source files always contribute.
 */
export async function listWorktreeDigestPaths(cwd: string): Promise<string[]> {
  const [trackedResult, untrackedResult, intentToAdd] = await Promise.all([
    runExecutable("git", ["ls-files", "-z", "--cached"], { cwd, timeoutMs: 15_000 }),
    runExecutable("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd, timeoutMs: 15_000 }),
    listIntentToAddPaths(cwd)
  ]);
  if (trackedResult.exitCode !== 0 || untrackedResult.exitCode !== 0) throw new Error("Git could not enumerate the worktree digest file set.");
  const tracked = trackedResult.stdout.split("\0").filter(Boolean).filter((file) => !(intentToAdd.has(file) && isProviderGeneratedPath(file)));
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean).filter((file) => !isProviderGeneratedPath(file));
  return [...new Set([...tracked, ...untracked])].sort();
}

/** Deterministic intent-to-add inventory (`git add -N`), parsed from porcelain v2 records. */
async function listIntentToAddPaths(cwd: string): Promise<Set<string>> {
  const result = await runExecutable("git", ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--no-renames"], { cwd, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error("Git could not classify intent-to-add entries in the worktree digest file set.");
  const paths = new Set<string>();
  for (const record of result.stdout.split("\0")) {
    if (!record.startsWith("1 ")) continue;
    const fields = record.split(" ");
    if (fields[1] !== ".A") continue;
    const file = fields.slice(8).join(" ");
    if (file) paths.add(file);
  }
  return paths;
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
