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
import {
  persistProviderLaneEvidenceV1,
  providerLaneUnavailableBlocker,
  PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED,
  VISUAL_COMPARISON_CONFIG_REQUIRED,
  VISUAL_REFERENCE_BASELINE_REQUIRED,
  type ProviderEvidenceLaneV1,
  type ProviderLaneArtifactKindV1,
  type ProviderLaneComparisonV1
} from "../validation/laneEvidence.js";

const browserLanes: Readonly<Record<string, ProviderEvidenceLaneV1>> = { playwright: "BROWSER", visual: "VISUAL" };

interface VisualComparisonBinding {
  baseline: string;
  comparison: ProviderLaneComparisonV1;
}

export async function runExternalToolValidator(context: ValidationContext): Promise<ValidationCheck> {
  const adapter = context.spec.adapter;
  const lane = browserLanes[adapter];
  const configured = context.spec.command?.trim();
  const defaults: Record<string, { tool: string; command?: string; category: string }> = {
    opengrep: { tool: "opengrep", command: "opengrep scan --json --error .", category: "security" },
    trivy: { tool: "trivy", command: "trivy fs --format json --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,misconfig,secret .", category: "security" },
    playwright: { tool: "", category: "e2e" },
    visual: { tool: "", category: "visual" },
    pact: { tool: "", category: "contract" },
    mutation: { tool: "", category: "test-quality" },
    property: { tool: "", category: "test-quality" },
    command: { tool: "", category: "custom" }
  };
  const definition = defaults[adapter] ?? { tool: "", category: "custom" };
  if (!configured && !definition.command && !lane) return { id: context.spec.id, category: definition.category, status: context.spec.required ? "FAIL" : "WARN", message: `${adapter} requires an explicit command in .harness/project.yaml.` };
  if (!configured && definition.tool && !(await commandExists(definition.tool, context.root))) return missingTool(context.spec, definition.tool, definition.category);
  const pinnedPlaywright = lane ? await pinnedPlaywrightExecutable(context.root) : undefined;
  if (lane && !configured && !pinnedPlaywright) {
    return laneUnavailable(context, lane, definition.category, `${providerLaneUnavailableBlocker(lane)}: the pinned candidate Playwright executable node_modules/.bin/playwright is absent; no bare npx fallback is allowed.`);
  }
  let visualBinding: VisualComparisonBinding | undefined;
  if (lane === "VISUAL") {
    const resolved = await resolveVisualComparisonBinding(context);
    if ("blocker" in resolved) {
      return { id: context.spec.id, category: definition.category, status: context.spec.required === false ? "SKIP" : "FAIL", message: `${resolved.blocker}: ${resolved.message}`, details: { blocker: resolved.blocker, lane, referenceRequired: true } };
    }
    visualBinding = resolved;
  }
  const command = configured ?? (lane && pinnedPlaywright ? `${quote(pinnedPlaywright)} test --grep "${context.contract.task.id}" --reporter=json` : definition.command!);
  const providerVersion = lane ? await playwrightVersion(configured ?? pinnedPlaywright, context.root) : "unknown";
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
  const providerUnavailable = lane ? playwrightUnavailableReason(`${result.stdout}\n${result.stderr}`) : undefined;
  if (lane && providerUnavailable) {
    return laneUnavailable(context, lane, definition.category, `${providerLaneUnavailableBlocker(lane)}: the real browser provider did not run: ${providerUnavailable}`, { command: rendered, exitCode: result.exitCode });
  }
  const failedByEvidence = findings.length > 0 && ["opengrep", "trivy", "playwright", "visual", "pact"].includes(adapter);
  const malformedEvidence = ["opengrep", "trivy", "playwright", "visual", "pact"].includes(adapter) && !parsedEvidence.valid;
  const failed = result.exitCode !== 0 || failedByEvidence || malformedEvidence;
  const status = failed ? context.spec.required === false ? "WARN" : "FAIL" : "PASS";
  if (lane && !context.candidate && context.spec.required === true && context.spec.options?.requireCandidateBoundEvidence === true) {
    return { id: context.spec.id, category: definition.category, status: "FAIL", message: `${PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED}: required ${adapter} validator ran without a current CandidateRevision binding.`, details: { command: rendered, blocker: PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED, lane, candidateBoundRequired: true } };
  }
  let laneEvidence: { artifact: string; digest: string; candidate: string; lane: ProviderEvidenceLaneV1 } | undefined;
  if (lane && context.candidate) {
    try {
      const evidence = await persistProviderLaneEvidenceV1({
        root: context.root,
        config: context.config,
        lane,
        checkId: context.spec.id,
        candidate: context.candidate,
        provider: { name: adapter === "visual" ? "playwright-visual" : "playwright", version: providerVersion, runtime: "playwright" },
        command: rendered,
        status,
        summary: `${lane} ${status}: ${findings.length} normalized finding(s); provider ${adapter} ${providerVersion}.`,
        findings,
        rawArtifactText: `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`,
        artifacts: visualBinding
          ? [...(await collectPlaywrightArtifacts(context.root, evidenceText)), { kind: "baseline" as const, path: visualBinding.baseline }]
          : await collectPlaywrightArtifacts(context.root, evidenceText),
        ...(visualBinding ? { comparison: visualBinding.comparison } : {}),
        startedAt: new Date(Date.now() - result.durationMs).toISOString(),
        finishedAt: new Date().toISOString()
      });
      laneEvidence = { artifact: evidence.artifact, digest: evidence.digest, candidate: `${evidence.candidate.candidateId} r${evidence.candidate.revision}`, lane };
    } catch (error) {
      return { id: context.spec.id, category: definition.category, status: context.spec.required === false ? "WARN" : "FAIL", message: `${lane} candidate-bound evidence could not be persisted: ${String(error)}`, details: { command: rendered, blocker: "PROVIDER_LANE_EVIDENCE_PERSIST_FAILED", lane, candidate: context.candidate } };
    }
  }
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
      ...(lane ? { lane } : {}),
      ...(isolation ? { isolation } : {}),
      ...(context.candidate ? { candidate: context.candidate } : {}),
      ...(laneEvidence ? { laneEvidence: { artifact: laneEvidence.artifact, digest: laneEvidence.digest, lane: laneEvidence.lane, candidate: laneEvidence.candidate } } : {}),
      ...(laneEvidence ? { artifact: laneEvidence.artifact } : {}),
      ...(sastEvidence ? { sastEvidence } : {}),
      ...(sastEvidence ? { artifact: sastEvidence.artifact } : {})
    }
  };
}

async function pinnedPlaywrightExecutable(root: string): Promise<string | undefined> {
  const executable = path.join(root, "node_modules", ".bin", "playwright");
  try {
    await fs.access(executable);
    return executable;
  } catch {
    return undefined;
  }
}

async function playwrightVersion(executable: string | undefined, root: string): Promise<string> {
  const raw = executable?.trim().split(/\s+/, 1)[0];
  const candidate = raw?.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  if (!candidate) return "unknown";
  try {
    const result = await runShell(`${quote(candidate)} --version`, { cwd: root, timeoutMs: 20_000 });
    const match = `${result.stdout}\n${result.stderr}`.match(/Version\s+([0-9][^\s]*)/i);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function playwrightUnavailableReason(output: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/Executable doesn't exist at ([^\s]+)/i, "the pinned Playwright browser executable is not installed"],
    [/please run the following command to download new browsers/i, "the pinned Playwright browser is not provisioned"],
    [/Looks like Playwright Test or Playwright was just installed or updated/i, "the Playwright installation requires browser provisioning"],
    [/browserType\.launch:.*Executable/i, "the Playwright browser could not launch"]
  ];
  for (const [pattern, reason] of patterns) if (pattern.test(output)) return reason;
  return undefined;
}

/**
 * A required VISUAL check must compare the rendered candidate against a
 * committed reference baseline and bind both the baseline identity and the
 * comparison configuration into its lane evidence. A missing or malformed
 * binding fails closed and never generates a baseline from the candidate.
 */
async function resolveVisualComparisonBinding(context: ValidationContext): Promise<VisualComparisonBinding | { blocker: string; message: string }> {
  const options = context.spec.options ?? {};
  const configured = typeof options.referenceBaseline === "string" ? options.referenceBaseline.trim() : "";
  if (!configured) return { blocker: VISUAL_REFERENCE_BASELINE_REQUIRED, message: "a required VISUAL check must declare options.referenceBaseline naming the committed baseline image it compares against; a baseline is never auto-generated from the candidate under validation." };
  const absolute = path.resolve(context.root, configured);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error("not a regular file");
  } catch {
    return { blocker: VISUAL_REFERENCE_BASELINE_REQUIRED, message: `declared visual reference baseline '${configured}' does not exist or is not a regular file; a missing baseline fails closed and is never generated from the candidate.` };
  }
  const raw = options.comparison && typeof options.comparison === "object" && !Array.isArray(options.comparison) ? options.comparison as Record<string, unknown> : undefined;
  const tool = typeof raw?.tool === "string" ? raw.tool.trim() : "";
  if (!tool) return { blocker: VISUAL_COMPARISON_CONFIG_REQUIRED, message: "a required VISUAL check must declare options.comparison with a non-empty tool describing the comparison that produced the verdict." };
  const comparisonOptions = raw?.options && typeof raw.options === "object" && !Array.isArray(raw.options) ? raw.options as Record<string, unknown> : {};
  return {
    baseline: absolute,
    comparison: { tool, ...(typeof raw?.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}), options: comparisonOptions }
  };
}

async function collectPlaywrightArtifacts(root: string, evidenceText: string): Promise<Array<{ kind: ProviderLaneArtifactKindV1; path: string }>> {
  const artifacts: Array<{ kind: ProviderLaneArtifactKindV1; path: string }> = [];
  const seen = new Set<string>();
  const push = (kind: ProviderLaneArtifactKindV1, candidate: unknown): void => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    const absolute = path.resolve(root, candidate);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    artifacts.push({ kind, path: absolute });
  };
  try {
    const report = JSON.parse(evidenceText) as { suites?: unknown };
    const visit = (suite: unknown): void => {
      if (!suite || typeof suite !== "object") return;
      const record = suite as { specs?: unknown[]; suites?: unknown[] };
      for (const spec of Array.isArray(record.specs) ? record.specs : []) {
        const tests = (spec as { tests?: unknown[] })?.tests;
        for (const test of Array.isArray(tests) ? tests : []) {
          const results = (test as { results?: unknown[] })?.results;
          for (const result of Array.isArray(results) ? results : []) {
            const attachments = (result as { attachments?: unknown[] })?.attachments;
            for (const attachment of Array.isArray(attachments) ? attachments : []) {
              const item = attachment as { name?: unknown; path?: unknown; contentType?: unknown };
              const name = typeof item.name === "string" ? item.name : "";
              const contentType = typeof item.contentType === "string" ? item.contentType : "";
              const kind = /trace/i.test(name) || /zip/.test(contentType) ? "trace" : /video/i.test(name) || /video/.test(contentType) ? "video" : /diff/i.test(name) ? "diff" : /png|jpe?g|image/i.test(`${name}${contentType}`) ? "screenshot" : "report";
              push(kind, item.path);
            }
          }
        }
      }
      for (const child of Array.isArray(record.suites) ? record.suites : []) visit(child);
    };
    for (const suite of Array.isArray(report.suites) ? report.suites : []) visit(suite);
  } catch {
    return artifacts;
  }
  const usable: typeof artifacts = [];
  for (const artifact of artifacts) {
    try {
      await fs.access(artifact.path);
      usable.push(artifact);
    } catch { /* attachment was not persisted for this run */ }
  }
  return usable;
}

function laneUnavailable(context: ValidationContext, lane: ProviderEvidenceLaneV1, category: string, message: string, details: Record<string, unknown> = {}): ValidationCheck {
  return {
    id: context.spec.id,
    category,
    status: context.spec.required === false ? "SKIP" : "FAIL",
    message,
    details: { ...details, blocker: providerLaneUnavailableBlocker(lane), lane, providerUnavailable: true }
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
