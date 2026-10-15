import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";

/** Resolve a repository-relative artifact without permitting lexical escapes. */
export function repositoryPath(root: string, relative: string): string {
  if (!relative.trim() || path.isAbsolute(relative)) throw new Error(`Repository artifact path must be relative: ${relative}`);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relative);
  const within = path.relative(absoluteRoot, absolute);
  if (within.startsWith("..") || path.isAbsolute(within)) throw new Error(`Repository artifact path escapes the project root: ${relative}`);
  return absolute;
}

/** Resolve an existing repository artifact and reject symlink escapes. */
export async function existingRepositoryPath(root: string, relative: string): Promise<string> {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  const candidate = await fs.realpath(repositoryPath(absoluteRoot, relative));
  const within = path.relative(absoluteRoot, candidate);
  if (within.startsWith("..") || path.isAbsolute(within)) throw new Error(`Repository artifact path escapes the project root: ${relative}`);
  return candidate;
}

export type IgnoreVerdict = "ignored" | "tracked-visible" | "unknown";

/**
 * Git-ignore verdict for a root-relative path (DETERMINISTIC): "ignored" when
 * git excludes it from the candidate digest file set, "tracked-visible" when
 * git would include it, "unknown" when git cannot answer (not a repository,
 * git missing). Used to keep repair-evidence writes digest-neutral: writing
 * a digest-visible file into the execution root after candidate binding
 * breaks the verify-time identity check.
 */
export async function ignoreVerdict(root: string, relative: string): Promise<IgnoreVerdict> {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", relative], { timeout: 15_000, stdio: "ignore" });
    return "ignored";
  } catch (error) {
    const code = (error as { status?: unknown }).status;
    if (code === 1) return "tracked-visible";
    return "unknown";
  }
}
/**
 * Write file content contained inside a root (DETERMINISTIC): lexical
 * containment plus per-component directory creation that refuses symlinks,
 * so a pre-existing symlink at the file or in any parent directory can
 * neither redirect the write outside the root nor cause directory creation
 * outside the root before detection. Throws fail-closed.
 */
export async function writeContainedFile(root: string, relative: string, content: string | Buffer): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const destination = repositoryPath(absoluteRoot, relative);
  // Component-wise descent: create each missing level only after proving the
  // current level is a real directory (never follow a symlink, never create
  // through one). A recursive mkdir would create descendants outside the root
  // through a symlinked parent before any check could reject the write.
  let cursor = path.parse(destination).root;
  const absoluteParts = destination.split(path.sep);
  for (let index = 1; index < absoluteParts.length - 1; index += 1) {
    cursor = path.join(cursor, absoluteParts[index]!);
    if (cursor.length < absoluteRoot.length) continue;
    let stat: Stats;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(cursor);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("REPAIR_EVIDENCE_ESCAPE: write path traverses a non-directory or symlink.");
    }
  }
  try {
    if ((await fs.lstat(destination)).isSymbolicLink()) {
      throw new Error("REPAIR_EVIDENCE_ESCAPE: write destination is a symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || String((error as Error).message).startsWith("REPAIR_EVIDENCE_ESCAPE")) throw error;
  }
  await fs.writeFile(destination, content);
  return destination;
}

/**
 * Materialize repair evidence into an isolated task workspace
 * (DETERMINISTIC): the validation report artifact a repair prompt points at
 * must resolve where the Repairer runs. Copies
 * `<reportsDir>/<taskId>.json` when present; absent reports are a no-op
 * (pre-validation planning contexts carry no repair evidence). Copy failures
 * throw fail-closed — a repairer must never run against a dangling pointer.
 */
export async function materializeRepairEvidence(
  root: string,
  target: string,
  config: HarnessProjectConfig,
  taskId: string,
): Promise<boolean> {
  if (!taskId.trim() || taskId.includes("..") || taskId.includes("/") || taskId.includes("\\")) {
    throw new Error("REPAIR_EVIDENCE_PATH_INVALID: repair evidence task id must be a plain artifact name.");
  }
  const relative = `${config.sdd?.reportsDir ?? ".harness/reports"}/${taskId}.json`;
  const source = await existingRepositoryPath(root, relative).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!source) return false;
  const absoluteTarget = path.resolve(target);
  await writeContainedFile(absoluteTarget, relative, await fs.readFile(source));
  return true;
}
