import path from "node:path";
import type { ValidationCheck, ValidationCommand } from "../core/types.js";
import { runProcess } from "../utils/process.js";

export async function runValidationCommand(root: string, command: ValidationCommand): Promise<ValidationCheck> {
  const cwd = path.resolve(root, command.workingDirectory ?? ".");
  const result = await runProcess(command.command, {
    cwd,
    timeoutMs: (command.timeoutSeconds ?? 900) * 1000
  });

  return {
    id: `command.${command.id}`,
    category: "command",
    status: result.exitCode === 0 ? "PASS" : (command.required === false ? "WARN" : "FAIL"),
    message: result.exitCode === 0 ? `${command.id} passed.` : `${command.id} failed with exit code ${result.exitCode}.`,
    durationMs: result.durationMs,
    details: {
      command: command.command,
      cwd,
      exitCode: result.exitCode,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr)
    }
  };
}

function trimOutput(value: string): string {
  const max = 12000;
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
