import path from "node:path";
import type { HarnessProjectConfig, ValidationCheck, ValidationCommand } from "../core/types.js";
import { runShell, type ProcessResult } from "../utils/process.js";
import {
  ISOLATION_PROVIDER_UNAVAILABLE,
  assertSupportedIsolationProvider,
  runIsolatedCommand,
  validatorIsolationEnvironmentAllowlist,
  validatorIsolationNetwork,
  validatorIsolationRequired
} from "../security/isolation.js";

export async function runValidationCommand(root: string, command: ValidationCommand, options: { config?: HarnessProjectConfig } = {}): Promise<ValidationCheck> {
  const cwd = path.resolve(root, command.workingDirectory ?? ".");
  const timeoutMs = (command.timeoutSeconds ?? 900) * 1000;
  const isolationRequired = options.config ? validatorIsolationRequired(options.config, { id: command.id, adapter: "command", command: command.command }) : false;
  let result: ProcessResult;
  let isolation: Record<string, unknown> | undefined;
  if (isolationRequired && options.config) {
    try {
      assertSupportedIsolationProvider(options.config);
      const isolated = await runIsolatedCommand({
        root,
        command: command.command,
        cwd,
        workspaceRoot: root,
        writablePaths: [root],
        network: validatorIsolationNetwork(options.config),
        timeoutMs
      }, { environmentAllowlist: validatorIsolationEnvironmentAllowlist(options.config) });
      result = { exitCode: isolated.exitCode, stdout: isolated.stdout, stderr: isolated.stderr, durationMs: isolated.durationMs, timedOut: isolated.timedOut };
      isolation = isolated.isolation as unknown as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocker = message.includes(ISOLATION_PROVIDER_UNAVAILABLE) ? ISOLATION_PROVIDER_UNAVAILABLE : "ISOLATION_UNAVAILABLE";
      return { id: `command.${command.id}`, category: "command", status: command.required === false ? "WARN" : "FAIL", message: `Validator-command isolation could not be established; the ${command.required === false ? "optional" : "required"} command did not run: ${message}`, details: { blocker, command: command.command, isolationRequired: true } };
    }
  } else {
    result = await runShell(command.command, { cwd, timeoutMs });
  }
  const passed = result.exitCode === 0;
  return {
    id: `command.${command.id}`,
    category: "command",
    status: passed ? "PASS" : (command.required === false ? "WARN" : "FAIL"),
    message: passed ? `${command.id} passed.` : `${command.id} failed with exit code ${result.exitCode}.`,
    durationMs: result.durationMs,
    details: {
      ...(passed
        ? { command: command.command, cwd, exitCode: result.exitCode, summary: summarizePassingOutput(result.stdout), stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) }
        : { command: command.command, cwd, exitCode: result.exitCode, stdout: trimOutput(result.stdout), stderr: trimOutput(result.stderr) }),
      ...(isolation ? { isolation } : {})
    }
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
