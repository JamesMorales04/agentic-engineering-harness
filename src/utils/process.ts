import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runProcess(
  command: string,
  options: { cwd: string; timeoutMs?: number; shell?: boolean; env?: Record<string, string | undefined> }
): Promise<ProcessResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: options.shell ?? true,
      env: { ...process.env, ...(options.env ?? {}) },
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
  const result = await runProcess(`command -v ${command}`, { cwd });
  return result.exitCode === 0;
}
