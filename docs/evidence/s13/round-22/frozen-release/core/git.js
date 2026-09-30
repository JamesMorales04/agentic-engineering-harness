import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "../utils/process.js";
async function namesFrom(args, cwd) {
    const result = await runExecutable("git", args, { cwd });
    if (result.exitCode !== 0)
        return [];
    return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
/**
 * Absolute git metadata roots of a worktree: the worktree-private git dir and the
 * shared common dir. These are the only git-internal paths a managed provider session
 * may touch outside its project root (AEH-V2-0116); source access stays governed by the
 * compiled tool ceiling.
 */
export async function worktreeGitRoots(cwd) {
    const [gitDir, commonDir] = await Promise.all([
        runExecutable("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeoutMs: 15_000 }),
        runExecutable("git", ["rev-parse", "--git-common-dir"], { cwd, timeoutMs: 15_000 })
    ]);
    const roots = new Set();
    if (gitDir.exitCode === 0 && gitDir.stdout.trim())
        roots.add(path.resolve(gitDir.stdout.trim()));
    if (commonDir.exitCode === 0 && commonDir.stdout.trim()) {
        const value = commonDir.stdout.trim();
        roots.add(path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value));
    }
    return [...roots].sort();
}
export async function getCurrentBranch(cwd) {
    const result = await runExecutable("git", ["branch", "--show-current"], { cwd });
    const branch = result.exitCode === 0 ? result.stdout.trim() : "";
    return branch || undefined;
}
export async function resolveBaseRef(cwd, configured = "HEAD") {
    const candidates = [...new Set([configured, await getCurrentBranch(cwd), "HEAD"].filter((value) => Boolean(value)))];
    for (const candidate of candidates) {
        const result = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`], { cwd, timeoutMs: 15_000 });
        if (result.exitCode === 0 && result.stdout.trim())
            return { ref: candidate, fallbackFrom: candidate === configured ? undefined : configured };
    }
    throw new Error(`No resolvable Git base ref found; configured baseRef=${configured}.`);
}
export async function getOriginRemote(cwd) {
    const result = await runExecutable("git", ["remote", "get-url", "origin"], { cwd });
    const remote = result.exitCode === 0 ? result.stdout.trim() : "";
    return remote || undefined;
}
export async function getChangedFiles(cwd, baseRef, options = {}) {
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
export function providerGeneratedPathspecExcludes() {
    return PROVIDER_GENERATED_PREFIXES.flatMap((prefix) => [`:(exclude)${prefix}`, `:(exclude)${prefix}/**`]);
}
function isProviderGeneratedPath(file) {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    return PROVIDER_GENERATED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
/** Digest the actual current source tree, including unstaged and untracked files. */
export async function computeWorktreeDigest(cwd) {
    let files;
    try {
        files = await listWorktreeDigestPaths(cwd);
    }
    catch {
        files = await fallbackSourceFiles(cwd);
    }
    const hash = crypto.createHash("sha256");
    for (const file of files) {
        const normalized = file.replaceAll("\\", "/");
        hash.update(`path\0${normalized}\0`);
        try {
            const stat = await fs.lstat(path.resolve(cwd, file));
            if (stat.isSymbolicLink())
                hash.update(`symlink\0${await fs.readlink(path.resolve(cwd, file))}\0`);
            else
                hash.update(await fs.readFile(path.resolve(cwd, file)));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            hash.update("missing\0");
        }
    }
    return hash.digest("hex");
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
export async function listWorktreeDigestPaths(cwd) {
    const [trackedResult, untrackedResult, intentToAdd] = await Promise.all([
        runExecutable("git", ["ls-files", "-z", "--cached"], { cwd, timeoutMs: 15_000 }),
        runExecutable("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd, timeoutMs: 15_000 }),
        listIntentToAddPaths(cwd)
    ]);
    if (trackedResult.exitCode !== 0 || untrackedResult.exitCode !== 0)
        throw new Error("Git could not enumerate the worktree digest file set.");
    const tracked = trackedResult.stdout.split("\0").filter(Boolean).filter((file) => !(intentToAdd.has(file) && isProviderGeneratedPath(file)));
    const untracked = untrackedResult.stdout.split("\0").filter(Boolean).filter((file) => !isProviderGeneratedPath(file));
    return [...new Set([...tracked, ...untracked])].sort();
}
/** Deterministic intent-to-add inventory (`git add -N`), parsed from porcelain v2 records. */
async function listIntentToAddPaths(cwd) {
    const result = await runExecutable("git", ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--no-renames"], { cwd, timeoutMs: 15_000 });
    if (result.exitCode !== 0)
        throw new Error("Git could not classify intent-to-add entries in the worktree digest file set.");
    const paths = new Set();
    for (const record of result.stdout.split("\0")) {
        if (!record.startsWith("1 "))
            continue;
        const fields = record.split(" ");
        if (fields[1] !== ".A")
            continue;
        const file = fields.slice(8).join(" ");
        if (file)
            paths.add(file);
    }
    return paths;
}
async function fallbackSourceFiles(root) {
    const files = [];
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if ([".git", ".harness", "dist", "node_modules"].includes(entry.name))
                continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
                await visit(absolute);
            else if (entry.isFile() || entry.isSymbolicLink())
                files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
        }
    }
    await visit(root);
    return files.sort();
}
export async function getDiffStats(cwd, baseRef, options = {}) {
    const baseCommit = await resolveCommit(cwd, baseRef);
    const result = baseCommit ? await runExecutable("git", ["diff", "--numstat", "--no-ext-diff", `${baseCommit}...HEAD`], { cwd }) : { stdout: "", stderr: "", exitCode: 1, durationMs: 0 };
    const worktree = await runExecutable("git", ["diff", "--numstat"], { cwd });
    const staged = await runExecutable("git", ["diff", "--cached", "--numstat"], { cwd });
    const rows = [result.stdout, worktree.stdout, staged.stdout].join("\n").split(/\r?\n/).filter(Boolean);
    let added = 0;
    let deleted = 0;
    for (const row of rows) {
        const [a, d, ...fileParts] = row.split(/\s+/);
        if (isIgnoredPath(fileParts.join(" "), options.ignoredPaths ?? []))
            continue;
        if (a && a !== "-")
            added += Number(a) || 0;
        if (d && d !== "-")
            deleted += Number(d) || 0;
    }
    const changed = await getChangedFiles(cwd, baseRef, options);
    return { files: changed.length, added, deleted };
}
async function resolveCommit(cwd, ref) {
    const result = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, timeoutMs: 15_000 });
    const commit = result.stdout.trim();
    return result.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit : undefined;
}
/** Provider-owned outputs must not become product-scope changes during validation. */
export function generatedArtifactPaths(config) {
    const codeIntelligence = config.codeIntelligence;
    const paths = config.context?.semanticRetrieval?.provider === "serena" ? [".serena"] : [];
    if (codeIntelligence?.provider === "graphify")
        paths.push("graphify-out", codeIntelligence.graphPath ?? "graphify-out/graph.json", codeIntelligence.snapshotDir ?? ".harness/graphify");
    return paths;
}
function isIgnoredPath(file, ignoredPaths) {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    return ignoredPaths.some((ignored) => {
        const prefix = ignored.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
    });
}
//# sourceMappingURL=git.js.map