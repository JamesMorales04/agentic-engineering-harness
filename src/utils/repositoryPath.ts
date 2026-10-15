import fs from "node:fs/promises";
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
  const destination = repositoryPath(target, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}
