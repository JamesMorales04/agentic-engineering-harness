import path from "node:path";
import type { ValidationCheck, ValidatorSpec } from "../core/types.js";
import { runProcess } from "../utils/process.js";
import type { ValidationContext } from "./types.js";

export async function runSpecCommand(context: ValidationContext, command: string, category: string, details: Record<string, unknown> = {}): Promise<ValidationCheck> {
  const rendered = renderTokens(command, context);
  const cwd = path.resolve(context.root, context.spec.workingDirectory ?? ".");
  const result = await runProcess(rendered, { cwd, timeoutMs: (context.spec.timeoutSeconds ?? 900) * 1000 });
  return {
    id: context.spec.id,
    category,
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    message: result.exitCode === 0 ? `${context.spec.adapter} validator passed.` : `${context.spec.adapter} validator failed with exit code ${result.exitCode}.`,
    durationMs: result.durationMs,
    details: { command: rendered, stdout: truncate(result.stdout), stderr: truncate(result.stderr), ...details }
  };
}

export function renderTokens(command: string, context: ValidationContext): string {
  return command
    .replaceAll("{taskId}", context.contract.task.id)
    .replaceAll("{baseRef}", context.baseRef)
    .replaceAll("{acceptance}", context.contract.source?.acceptance ?? "");
}

export function missingTool(spec: ValidatorSpec, tool: string, category: string): ValidationCheck {
  return {
    id: spec.id,
    category,
    status: spec.required ? "FAIL" : "WARN",
    message: `${tool} is not installed; ${spec.required ? "the required validator cannot run" : "optional validator skipped"}.`
  };
}

function truncate(value: string, max = 20_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… truncated …`;
}
