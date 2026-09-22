import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface ManagedProcessHandle {
  pid: number;
  processGroupId: number;
}

const toolchainPathCache = new Map<string, string | undefined>();
export function clearToolchainEnvCache(): void { toolchainPathCache.clear(); }

export async function runProcess(
  command: string,
  options: { cwd: string; timeoutMs?: number; shell?: boolean; env?: Record<string, string | undefined>; toolchain?: boolean; stdin?: string | Buffer; signal?: AbortSignal }
): Promise<ProcessResult> {
  const started = Date.now();
  const inherited = { ...process.env, ...(options.env ?? {}) };
  // Controller identity is authoritative only inside the controller/AEH
  // process itself. Never leak it into arbitrary shell commands such as
  // npm test, whose explicit repository root must remain authoritative.
  // The managed-agent envelope is authoritative only inside the process that
  // owns it. Repository commands and tools must not inherit it: otherwise a
  // bounded child can be mistaken for an AEH participant and re-enter the
  // controller, or observe another operation's routing state.
  for (const name of [
    "AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_OPERATION_WORKSPACE_ID",
    "AEH_MANAGED_AGENT", "AEH_LOGICAL_AGENT", "AEH_AGENT_ROLE", "AEH_PARENT_OPERATION_ID", "AEH_PARENT_OPERATION_KIND", "AEH_AGENT_PHASE",
    "AEH_INTERACTIVE_LEAD", "AEH_ORCHESTRATION_ALLOWED", "AEH_ALLOW_NESTED_OPERATION", "AEH_OPERATION_SUPERVISOR", "AEH_PARENT_AGENT_ID",
    "AEH_SUPERVISOR_GENERATION", "AEH_CONTEXT_OPERATION_ID", "AEH_CONTEXT_PHASE", "AEH_CONTEXT_ROOT", "AEH_ENTRY_FILE"
  ]) delete inherited[name];
  if (options.toolchain !== false) {
    const prefix = await toolchainPathPrefix(options.cwd);
    if (prefix) inherited.PATH = `${prefix}${path.delimiter}${inherited.PATH ?? ""}`;
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: options.shell ?? true,
      env: inherited,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: { toString(): string }) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: { toString(): string }) => { stderr += chunk.toString(); });
    if (options.stdin !== undefined) {
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin?.end(options.stdin);
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let terminated = false;
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let unregister: () => Promise<void> = async () => undefined;
    const registered = registerManagedProcessHandle(child.pid);
    void registered.then((cleanup) => {
      unregister = cleanup;
      if (settled) void unregister();
    });
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      killTimer.unref();
      forceSettleTimer = setTimeout(() => finish(exitCode ?? 124, exitSignal ?? "SIGKILL", true), 1_000);
      forceSettleTimer.unref();
    };
    if (options.timeoutMs) timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    const onAbort = (): void => terminate();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      void unregister().finally(() => reject(error));
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (!settled && !forceSettleTimer) {
        forceSettleTimer = setTimeout(() => finish(code ?? 1, signal, false), 1_000);
        forceSettleTimer.unref();
      }
    });
    child.on("close", (code: number | null) => {
      finish(code ?? exitCode ?? 1, exitSignal, false);
    });

    function finish(code: number, signal: NodeJS.Signals | null, forced: boolean): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (forced || !exited) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }
      void unregister().finally(() => resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut
      }));
    }
  });
}

export async function listManagedProcessHandles(root: string, operationId: string): Promise<ManagedProcessHandle[]> {
  const directory = managedProcessDirectory(root, operationId);
  let entries: string[];
  try { entries = await fs.readdir(directory); } catch { return []; }
  const handles: ManagedProcessHandle[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as Partial<ManagedProcessHandle>;
      if (Number.isInteger(value.pid) && Number(value.pid) > 0) {
        handles.push({ pid: Number(value.pid), processGroupId: Number.isInteger(value.processGroupId) && Number(value.processGroupId) > 0 ? Number(value.processGroupId) : Number(value.pid) });
      }
    } catch { /* stale or partially-written handle */ }
  }
  return handles;
}

export async function clearManagedProcessHandles(root: string, operationId: string): Promise<void> {
  await fs.rm(managedProcessDirectory(root, operationId), { recursive: true, force: true }).catch(() => undefined);
}

export async function terminateManagedProcessGroup(pid: number, graceMs = 250): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32") {
        try { process.kill(-pid, value); }
        catch { process.kill(pid, value); }
      } else process.kill(pid, value);
    } catch { /* process already exited */ }
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signal("SIGKILL");
}

export async function registerManagedProcessHandle(pid: number | undefined): Promise<() => Promise<void>> {
  const operationId = process.env.AEH_OPERATION_ID?.trim();
  const controlRoot = process.env.AEH_CONTROL_ROOT?.trim();
  if (!pid || !operationId || !controlRoot || process.env.AEH_OPERATION_STATE_REDIRECT !== "1") return async () => undefined;
  const directory = managedProcessDirectory(controlRoot, operationId);
  const file = path.join(directory, `${pid}.json`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return async () => { await fs.rm(file, { force: true }).catch(() => undefined); };
  } catch {
    return async () => undefined;
  }
}

function managedProcessDirectory(root: string, operationId: string): string {
  const safeOperationId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.resolve(root, ".harness", "operations", `${safeOperationId}.processes`);
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
