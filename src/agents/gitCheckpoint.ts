import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../utils/process.js";

export interface WorktreeCheckpoint { createdAt: string; files: Map<string, Buffer | undefined>; }

export async function createWorktreeCheckpoint(root: string): Promise<WorktreeCheckpoint> {
  const files = new Map<string, Buffer | undefined>();
  for (const relative of await changedPaths(root)) {
    const absolute = path.resolve(root, relative);
    try { files.set(relative, await fs.readFile(absolute)); } catch { files.set(relative, undefined); }
  }
  return { createdAt: new Date().toISOString(), files };
}

export async function rollbackWorktreeCheckpoint(root: string, checkpoint: WorktreeCheckpoint): Promise<string[]> {
  const current = new Set(await changedPaths(root));
  const all = new Set([...current, ...checkpoint.files.keys()]);
  const restored: string[] = [];
  for (const relative of all) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) && absolute !== path.resolve(root)) throw new Error(`Unsafe rollback path: ${relative}`);
    if (checkpoint.files.has(relative)) {
      const content = checkpoint.files.get(relative);
      if (content === undefined) await fs.rm(absolute, { recursive: true, force: true });
      else { await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content); }
      restored.push(relative);
      continue;
    }
    const tracked = await runProcess(`git cat-file -e ${quote(`HEAD:${relative}`)}`, { cwd: root, timeoutMs: 30_000 });
    if (tracked.exitCode === 0) {
      const restore = await runProcess(`git restore --source=HEAD --worktree --staged -- ${quote(relative)}`, { cwd: root, timeoutMs: 30_000 });
      if (restore.exitCode !== 0) throw new Error(`Unable to rollback ${relative}: ${restore.stderr || restore.stdout}`);
    } else await fs.rm(absolute, { recursive: true, force: true });
    restored.push(relative);
  }
  return restored.sort();
}

async function changedPaths(root: string): Promise<string[]> {
  const commands = ["git diff --name-only HEAD", "git diff --cached --name-only HEAD", "git ls-files --others --exclude-standard"];
  const paths = new Set<string>();
  for (const command of commands) {
    const result = await runProcess(command, { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Unable to inspect worktree for rollback checkpoint: ${result.stderr || result.stdout}`);
    for (const line of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) paths.add(line);
  }
  return [...paths].sort();
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
