import path from "node:path";
import type { HarnessProjectConfig, ValidationCheck, ValidatorSpec } from "../core/types.js";
import { runShell, type ProcessResult } from "../utils/process.js";
import type { ValidationContext } from "./types.js";
import {
  ISOLATION_PROVIDER_UNAVAILABLE,
  assertSupportedIsolationProvider,
  runIsolatedCommand,
  validatorIsolationEnvironmentAllowlist,
  validatorIsolationNetwork,
  validatorIsolationRequired
} from "../security/isolation.js";

/**
 * Unified validator sandbox writable policy (Mechanism=DETERMINISTIC).
 *
 * Validators run with a read-only workspace and may persist only to the
 * configured evidence directory plus the directory of a declared evidenceFile
 * that lives inside the workspace. Anything else fails closed inside the
 * sandbox. Single owner for every validator kind: external.ts and commands.ts
 * reuse this helper so isolation means the same thing everywhere.
 */
export function validatorEvidenceWritablePaths(root: string, config: HarnessProjectConfig, options: { cwd?: string; evidenceFile?: string } = {}): string[] {
  const paths = new Set<string>();
  paths.add(path.resolve(root, config.evidence?.outputDir ?? ".harness/evidence"));
  if (typeof options.evidenceFile === "string" && options.evidenceFile.trim()) {
    const resolved = path.resolve(options.cwd ?? root, options.evidenceFile);
    if (resolved.startsWith(`${path.resolve(root)}${path.sep}`)) paths.add(path.dirname(resolved));
  }
  return [...paths].sort();
}

export async function runSpecCommand(context: ValidationContext, command: string, category: string, details: Record<string, unknown> = {}): Promise<ValidationCheck> {
  const rendered = renderTokens(command, context);
  const cwd = path.resolve(context.root, context.spec.workingDirectory ?? ".");
  const timeoutMs = (context.spec.timeoutSeconds ?? 900) * 1000;
  let result: ProcessResult;
  let isolation: Record<string, unknown> | undefined;
  if (validatorIsolationRequired(context.config, context.spec)) {
    try {
      assertSupportedIsolationProvider(context.config);
      const specOptions = (context.spec.options ?? {}) as Record<string, unknown>;
      const evidenceFileOption = typeof specOptions.evidenceFile === "string" ? specOptions.evidenceFile : undefined;
      const isolated = await runIsolatedCommand({
        root: context.root,
        command: rendered,
        cwd,
        workspaceRoot: context.root,
        writablePaths: validatorEvidenceWritablePaths(context.root, context.config, { cwd, evidenceFile: evidenceFileOption }),
        network: validatorIsolationNetwork(context.config),
        timeoutMs
      }, { environmentAllowlist: validatorIsolationEnvironmentAllowlist(context.config) });
      result = { exitCode: isolated.exitCode, stdout: isolated.stdout, stderr: isolated.stderr, durationMs: isolated.durationMs, timedOut: isolated.timedOut };
      isolation = isolated.isolation as unknown as Record<string, unknown>;
    } catch (error) {
      return isolationFailure(context, category, command, error);
    }
  } else {
    result = await runShell(rendered, { cwd, timeoutMs });
  }
  return {
    id: context.spec.id,
    category,
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    message: result.exitCode === 0 ? `${context.spec.adapter} validator passed.` : `${context.spec.adapter} validator failed with exit code ${result.exitCode}.`,
    durationMs: result.durationMs,
    details: { command: rendered, stdout: truncate(result.stdout), stderr: truncate(result.stderr), ...(isolation ? { isolation } : {}), ...details }
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

function isolationFailure(context: ValidationContext, category: string, command: string, error: unknown): ValidationCheck {
  const message = error instanceof Error ? error.message : String(error);
  const blocker = message.includes(ISOLATION_PROVIDER_UNAVAILABLE) ? ISOLATION_PROVIDER_UNAVAILABLE : "ISOLATION_UNAVAILABLE";
  return {
    id: context.spec.id,
    category,
    status: context.spec.required === false ? "WARN" : "FAIL",
    message: `Validator-command isolation could not be established; the ${context.spec.required === false ? "optional" : "required"} validator did not run: ${message}`,
    details: { blocker, command, isolationRequired: true }
  };
}

function truncate(value: string, max = 20_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… truncated …`;
}
