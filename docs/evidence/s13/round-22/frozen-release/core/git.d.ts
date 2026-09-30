import type { HarnessProjectConfig } from "./types.js";
export interface GitChangeOptions {
    ignoredPaths?: string[];
}
/**
 * Absolute git metadata roots of a worktree: the worktree-private git dir and the
 * shared common dir. These are the only git-internal paths a managed provider session
 * may touch outside its project root (AEH-V2-0116); source access stays governed by the
 * compiled tool ceiling.
 */
export declare function worktreeGitRoots(cwd: string): Promise<string[]>;
export declare function getCurrentBranch(cwd: string): Promise<string | undefined>;
export declare function resolveBaseRef(cwd: string, configured?: string): Promise<{
    ref: string;
    fallbackFrom?: string;
}>;
export declare function getOriginRemote(cwd: string): Promise<string | undefined>;
export declare function getChangedFiles(cwd: string, baseRef: string, options?: GitChangeOptions): Promise<string[]>;
/** Git pathspec exclusions for provider-owned scratch that must never enter a candidate ChangeSet. */
export declare function providerGeneratedPathspecExcludes(): string[];
/** Digest the actual current source tree, including unstaged and untracked files. */
export declare function computeWorktreeDigest(cwd: string): Promise<string>;
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
export declare function listWorktreeDigestPaths(cwd: string): Promise<string[]>;
export declare function getDiffStats(cwd: string, baseRef: string, options?: GitChangeOptions): Promise<{
    files: number;
    added: number;
    deleted: number;
}>;
/** Provider-owned outputs must not become product-scope changes during validation. */
export declare function generatedArtifactPaths(config: HarnessProjectConfig): string[];
