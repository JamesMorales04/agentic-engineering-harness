import path from "node:path";
import type { ValidationCheck, ValidationCommand } from "../core/types.js";
import { runProcess } from "../utils/process.js";

export async function runValidationCommand(root: string, command: ValidationCommand): Promise<ValidationCheck> {
  const cwd = path.resolve(root, command.workingDirectory ?? ".");
  const result = await runProcess(command.command, {
    cwd,
    timeoutMs: (command.timeoutSeconds ?? 900) * 1000
  });
  const passed = result.exitCode === 0;
  return {
    id: `command.${command.id}`,
    category: "command",
    status: passed ? "PASS" : (command.required === false ? "WARN" : "FAIL"),
    message: passed ? `${command.id} passed.` : `${command.id} failed with exit code ${result.exitCode}.`,
    durationMs: result.durationMs,
    details: passed
      ? { command: command.command, cwd, exitCode: result.exitCode, summary: summarizePassingOutput(result.stdout), stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) }
      : { command: command.command, cwd, exitCode: result.exitCode, stdout: trimOutput(result.stdout), stderr: trimOutput(result.stderr) }
  };
}

function summarizePassingOutput(stdout: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const files = stdout.match(/Test Files\s+(\d+) passed/i);
  const tests = stdout.match(/Tests\s+(\d+) passed/i);
  if (files) summary.testFilesPassed = Number(files[1]);
  if (tests) summary.testsPassed = Number(tests[1]);
  if (stdout.includes("typecheck") || stdout.includes("tsc -p")) summary.typecheck = "PASS";
  if (stdout.includes("build") && stdout.includes("tsc -p")) summary.build = "PASS";
  return summary;
}

function trimOutput(value: string): string {
  const max = 12000;
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
