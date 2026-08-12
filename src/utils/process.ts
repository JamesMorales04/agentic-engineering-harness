import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const toolchainPathCache = new Map<string, string | undefined>();
export function clearToolchainEnvCache(): void { toolchainPathCache.clear(); }

export async function runProcess(
  command: string,
  options: { cwd: string; timeoutMs?: number; shell?: boolean; env?: Record<string, string | undefined>; toolchain?: boolean }
): Promise<ProcessResult> {
  const started = Date.now();
  const inherited = { ...process.env, ...(options.env ?? {}) };
  if (options.toolchain !== false) {
    const prefix = await toolchainPathPrefix(options.cwd);
    if (prefix) inherited.PATH = `${prefix}${path.delimiter}${inherited.PATH ?? ""}`;
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: options.shell ?? true,
      env: inherited,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: { toString(): string }) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: { toString(): string }) => { stderr += chunk.toString(); });

    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : undefined;

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  const result = await runProcess(`command -v ${shell(command)}`, { cwd });
  return result.exitCode === 0;
}

async function toolchainPathPrefix(cwd: string): Promise<string | undefined> {
  const key = path.resolve(cwd); if (toolchainPathCache.has(key)) return toolchainPathCache.get(key);
  const roots = await candidateRoots(key);
  for (const root of roots) {
    try {
      const state = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.state.json"), "utf8")) as { binPaths?: string[] };
      const valid: string[] = [];
      for (const item of state.binPaths ?? []) { try { await fs.access(item); valid.push(item); } catch { /* stale machine-local path */ } }
      const prefix = valid.length ? valid.join(path.delimiter) : undefined; toolchainPathCache.set(key, prefix); return prefix;
    } catch { /* try another root */ }
  }
  toolchainPathCache.set(key, undefined); return undefined;
}

async function candidateRoots(start: string): Promise<string[]> {
  const roots: string[] = []; let current = start;
  while (true) {
    roots.push(current);
    const gitFile = path.join(current, ".git");
    try {
      const stat = await fs.stat(gitFile);
      if (stat.isFile()) {
        const value = await fs.readFile(gitFile, "utf8"); const gitDir = value.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
        if (gitDir) {
          const absolute = path.resolve(current, gitDir); const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`; const index = absolute.indexOf(marker);
          if (index >= 0) roots.push(absolute.slice(0, index));
        }
      }
    } catch { /* not a worktree root */ }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return [...new Set(roots)];
}
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
