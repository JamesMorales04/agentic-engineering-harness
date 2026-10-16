import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, ValidationCheck, ValidationCommand } from "../core/types.js";
import { pinnedWorkspaceBinPaths, runShell, type ProcessResult } from "../utils/process.js";
import {
  ISOLATION_PROVIDER_UNAVAILABLE,
  assertSupportedIsolationProvider,
  runIsolatedCommand,
  validatorIsolationEnvironmentAllowlist,
  validatorIsolationNetwork,
  validatorIsolationRequired
} from "../security/isolation.js";
import { validatorEvidenceWritablePaths } from "./toolCommand.js";

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
        // Unified with external/toolCommand validators: read-only workspace,
        // only the evidence directory is writable. The previous `[root]`
        // binding made the whole candidate tree writable inside the sandbox.
        writablePaths: validatorEvidenceWritablePaths(root, options.config),
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
    // Trusted explicit marking (DETERMINISTIC): the validation root's own
    // pinned prefix, so suite commands (npm -> test runners -> fixture
    // validators in tmpdir roots without state) resolve the same pinned
    // tools. Managed-child scrubbing removes ambient markings at this
    // boundary and a detached monitor's frozen snapshot can be empty,
    // which otherwise breaks every tool-spawning fixture test even
    // though the workspace itself is fully provisioned. State-derived
    // only — never ambient — so hermeticity is preserved; the existing
    // nested re-emit carries the marking into the command subtree.
    // (No equivalent marking exists on the isolated path: sandboxes start
    // from an allowlisted environment by design.)
    const explicitBins = await pinnedWorkspaceBinPaths(root);
    result = await runShell(command.command, {
      cwd,
      timeoutMs,
      ...(explicitBins.length ? { toolchainExtraBinPaths: explicitBins } : {})
    });
  }
  const passed = result.exitCode === 0;
  // D19: persist the COMPLETE command output to a raw artifact file and cite
  // it in details (mirrors the external-validator rawArtifact pattern).
  // Attribution (testAttribution extractReporterTestsFromExecutionV1) reads
  // the raw file, never the bounded details copies: details.stdout is capped
  // at 12KB (and passing runs carry only a summary), so reporter JSON larger
  // than the cap — routine for Playwright output — would otherwise be
  // unparseable and every large or failing suite would misreport as
  // TEST_ATTRIBUTION_REPORTER_MISSING instead of attributing real results.
  // The evidence dir is git-ignored harness state, so raw files never enter
  // candidate digests or ChangeSets. Best-effort write: persistence failure
  // keeps the previous bounded-details behavior (attribution may then miss).
  // MECHANISM: DETERMINISTIC (fixed path derivation + verbatim bytes).
  let rawArtifactRel: string | undefined;
  try {
    const rawPath = path.resolve(root, options.config?.evidence?.outputDir ?? ".harness/evidence", `${command.id.replace(/[^A-Za-z0-9._-]/g, "-")}.raw`);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, "utf8");
    rawArtifactRel = path.relative(root, rawPath).replaceAll("\\", "/");
  } catch {
    rawArtifactRel = undefined;
  }
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
      ...(rawArtifactRel ? { rawArtifact: rawArtifactRel } : {}),
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
