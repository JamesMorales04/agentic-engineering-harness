import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck } from "../core/types.js";
import { commandExists, runShell, type ProcessResult } from "../utils/process.js";
import type { ValidationContext } from "./types.js";
import { missingTool } from "./toolCommand.js";
import { parseToolEvidenceResult } from "./toolEvidence.js";
import {
  ISOLATION_PROVIDER_UNAVAILABLE,
  assertSupportedIsolationProvider,
  runIsolatedCommand,
  validatorIsolationEnvironmentAllowlist,
  validatorIsolationNetwork,
  validatorIsolationRequired,
  type IsolationExecutionEvidenceV1
} from "../security/isolation.js";
import {
  SAST_ADAPTERS,
  SAST_CANDIDATE_BINDING_REQUIRED,
  extractSastToolVersion,
  persistSastEvidenceV1,
  type SastAdapterV1
} from "../security/sastEvidence.js";

export async function runExternalToolValidator(context: ValidationContext): Promise<ValidationCheck> {
  const adapter = context.spec.adapter;
  const configured = context.spec.command?.trim();
  const defaults: Record<string, { tool: string; command?: string; category: string }> = {
    opengrep: { tool: "opengrep", command: "opengrep scan --json --error .", category: "security" },
    trivy: { tool: "trivy", command: "trivy fs --format json --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,misconfig,secret .", category: "security" },
    playwright: { tool: "npx", command: "npx playwright test --grep \"{taskId}\" --reporter=json", category: "e2e" },
    pact: { tool: "", category: "contract" },
    mutation: { tool: "", category: "test-quality" },
    property: { tool: "", category: "test-quality" },
    command: { tool: "", category: "custom" }
  };
  const definition = defaults[adapter] ?? { tool: "", category: "custom" };
  if (!configured && !definition.command) return { id: context.spec.id, category: definition.category, status: context.spec.required ? "FAIL" : "WARN", message: `${adapter} requires an explicit command in .harness/project.yaml.` };
  if (!configured && definition.tool && !(await commandExists(definition.tool, context.root))) return missingTool(context.spec, definition.tool, definition.category);
  const command = configured ?? definition.command!;
  const rendered = command.replaceAll("{taskId}", context.contract.task.id).replaceAll("{baseRef}", context.baseRef).replaceAll("{acceptance}", context.contract.source?.acceptance ?? "");
  const cwd = path.resolve(context.root, context.spec.workingDirectory ?? ".");
  const timeoutMs = (context.spec.timeoutSeconds ?? 900) * 1000;
  const isolationRequired = validatorIsolationRequired(context.config, context.spec);
  if (isolationRequired) {
    try {
      assertSupportedIsolationProvider(context.config);
    } catch (error) {
      return isolationFailure(context, definition.category, rendered, error);
    }
  }
  let result: ProcessResult;
  let isolation: IsolationExecutionEvidenceV1 | undefined;
  if (isolationRequired) {
    try {
      const isolated = await runIsolatedCommand({
        root: context.root,
        command: rendered,
        cwd,
        workspaceRoot: context.root,
        writablePaths: validatorWritablePaths(context, cwd),
        network: validatorIsolationNetwork(context.config),
        timeoutMs
      }, { environmentAllowlist: validatorIsolationEnvironmentAllowlist(context.config) });
      result = { exitCode: isolated.exitCode, stdout: isolated.stdout, stderr: isolated.stderr, durationMs: isolated.durationMs, timedOut: isolated.timedOut };
      isolation = isolated.isolation;
    } catch (error) {
      return isolationFailure(context, definition.category, rendered, error);
    }
  } else {
    result = await runShell(rendered, { cwd, timeoutMs });
  }
  const evidenceFile = typeof context.spec.options?.evidenceFile === "string" ? path.resolve(cwd, context.spec.options.evidenceFile) : undefined;
  const evidenceText = evidenceFile ? await fs.readFile(evidenceFile, "utf8").catch(() => result.stdout) : result.stdout;
  const parsedEvidence = parseToolEvidenceResult(adapter, evidenceText);
  const findings = parsedEvidence.findings;
  const rawPath = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence", `${context.spec.id.replace(/[^A-Za-z0-9._-]/g, "-")}.raw`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, "utf8");
  const failedByEvidence = findings.length > 0 && ["opengrep", "trivy", "playwright", "pact"].includes(adapter);
  const malformedEvidence = ["opengrep", "trivy", "playwright", "pact"].includes(adapter) && !parsedEvidence.valid;
  const failed = result.exitCode !== 0 || failedByEvidence || malformedEvidence;
  const status = failed ? context.spec.required === false ? "WARN" : "FAIL" : "PASS";
  const sastAdapter = SAST_ADAPTERS.includes(adapter as SastAdapterV1) ? adapter as SastAdapterV1 : undefined;
  if (sastAdapter && !context.candidate && context.spec.required === true && context.spec.options?.requireCandidateBoundEvidence === true) {
    return { id: context.spec.id, category: definition.category, status: "FAIL", message: `${SAST_CANDIDATE_BINDING_REQUIRED}: required ${adapter} validator ran without a current CandidateRevision binding.`, details: { command: rendered, blocker: SAST_CANDIDATE_BINDING_REQUIRED, candidateBoundRequired: true } };
  }
  let sastEvidence: { artifact: string; digest: string; candidate: string } | undefined;
  if (sastAdapter && context.candidate) {
    try {
      const evidence = await persistSastEvidenceV1({
        root: context.root,
        config: context.config,
        checkId: context.spec.id,
        adapter: sastAdapter,
        candidate: context.candidate,
        command: rendered,
        tool: { name: adapter, version: extractSastToolVersion(sastAdapter, evidenceText) },
        status,
        findings,
        rawArtifactText: `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`,
        isolation,
        startedAt: new Date(Date.now() - result.durationMs).toISOString(),
        finishedAt: new Date().toISOString()
      });
      sastEvidence = { artifact: evidence.artifact, digest: evidence.digest, candidate: `${evidence.candidate.candidateId} r${evidence.candidate.revision}` };
    } catch (error) {
      const message = `Candidate-bound SAST evidence could not be persisted: ${String(error)}`;
      return { id: context.spec.id, category: definition.category, status: context.spec.required === false ? "WARN" : "FAIL", message, details: { command: rendered, blocker: "SAST_EVIDENCE_PERSIST_FAILED", candidate: context.candidate, isolation } };
    }
  }
  return {
    id: context.spec.id,
    category: definition.category,
    status,
    message: failed ? `${adapter} validator ${status === "WARN" ? "degraded" : "failed"}${malformedEvidence ? " with malformed evidence" : findings.length ? ` with ${findings.length} normalized finding(s)` : ` with exit code ${result.exitCode}`}.` : `${adapter} validator passed.`,
    durationMs: result.durationMs,
    details: {
      command: rendered,
      rawArtifact: path.relative(context.root, rawPath).replaceAll("\\", "/"),
      evidenceFormat: evidenceFile ? context.spec.options?.evidenceFormat ?? "json-or-junit" : "stdout-json",
      exitCode: result.exitCode,
      stderr: boundedDiagnostic(result.stderr),
      findings,
      findingCount: findings.length,
      isolationRequired,
      ...(isolation ? { isolation } : {}),
      ...(context.candidate ? { candidate: context.candidate } : {}),
      ...(sastEvidence ? { sastEvidence } : {}),
      ...(sastEvidence ? { artifact: sastEvidence.artifact } : {})
    }
  };
}

function validatorWritablePaths(context: ValidationContext, cwd: string): string[] {
  const paths = new Set<string>();
  const evidenceDir = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence");
  paths.add(evidenceDir);
  const evidenceFile = typeof context.spec.options?.evidenceFile === "string" ? path.resolve(cwd, context.spec.options.evidenceFile) : undefined;
  if (evidenceFile && path.resolve(evidenceFile).startsWith(`${path.resolve(context.root)}${path.sep}`)) paths.add(path.dirname(evidenceFile));
  return [...paths].sort();
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

function boundedDiagnostic(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_997)}...`;
}
