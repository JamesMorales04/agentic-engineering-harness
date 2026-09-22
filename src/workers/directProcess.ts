import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { registerManagedProcessHandle } from "../utils/process.js";

const SAFE_RUNTIME_ENVIRONMENT = ["PATH", "NODE_PATH", "LANG", "LC_ALL", "CI", "TERM"] as const;

export interface DirectWorkerProcessOptions {
  cwd: string;
  timeoutMs: number;
  environment?: Record<string, string | undefined>;
  maxOutputBytes?: number;
  /** A shared isolated home used to prepare a real provider session before its first turn. */
  homeDirectory?: string;
}

export interface DirectWorkerHome {
  directory: string;
}

export interface DirectWorkerProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a direct runtime with an explicit environment. Direct workers must not
 * inherit the controller's ambient credentials or user runtime configuration.
 */
export async function runDirectWorkerProcess(
  command: string,
  args: readonly string[],
  config: HarnessProjectConfig,
  options: DirectWorkerProcessOptions
): Promise<DirectWorkerProcessResult> {
  const ownedHome = options.homeDirectory ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-home-"));
  const home = options.homeDirectory ?? ownedHome!;
  const environment = buildDirectWorkerEnvironment(config, options.environment, home);
  const started = Date.now();

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let forceSettleTimer: NodeJS.Timeout | undefined;
      let terminated = false;
      let timedOut = false;
      let outputLimit = false;
      let exited = false;
      let exitCode: number | null = null;
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
        forceSettleTimer = setTimeout(() => finish(124, true), 1_000);
        forceSettleTimer.unref();
      };
      const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
          outputLimit = true;
          terminate();
          return;
        }
        if (target === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      };

      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        void unregister().finally(() => reject(error));
      });
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        if (!settled && !forceSettleTimer) {
          forceSettleTimer = setTimeout(() => finish(code ?? 1, false), 1_000);
          forceSettleTimer.unref();
        }
      });
      child.once("close", (code) => {
        finish(code ?? exitCode ?? 1, false);
      });

      function finish(code: number, forced: boolean): void {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        if (forced || !exited) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        void unregister().finally(() => resolve({ exitCode: outputLimit || timedOut ? 124 : code, stdout, stderr, durationMs: Date.now() - started }));
      }
    });
  } finally {
    if (ownedHome) await fs.rm(ownedHome, { recursive: true, force: true });
  }
}

export async function createDirectWorkerHome(): Promise<DirectWorkerHome> {
  return { directory: await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-home-")) };
}

export async function removeDirectWorkerHome(home: DirectWorkerHome | undefined): Promise<void> {
  if (home) await fs.rm(home.directory, { recursive: true, force: true });
}

export function buildDirectWorkerEnvironment(
  config: HarnessProjectConfig,
  explicit: Record<string, string | undefined> = {},
  controlledHome = ""
): Record<string, string> {
  const sandbox = config.security?.sandbox;
  const allowlisted = new Set([
    ...SAFE_RUNTIME_ENVIRONMENT,
    ...(sandbox?.environmentAllowlist ?? []),
    ...(sandbox?.credentialEnvAllowlist ?? [])
  ]);
  const result: Record<string, string> = {};
  for (const name of allowlisted) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined) result[name] = value;
  }
  if (controlledHome) {
    result.HOME = controlledHome;
    result.XDG_CONFIG_HOME = path.join(controlledHome, ".config");
    result.XDG_CACHE_HOME = path.join(controlledHome, ".cache");
  }
  result.TMPDIR ??= os.tmpdir();
  return result;
}
