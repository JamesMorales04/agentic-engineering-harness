import type { TaskRisk, ValidationCheck } from "../core/types.js";

export interface AuditReviewerPromptRequest {
  request: string;
  files?: string[];
  domains?: string[];
  risk?: TaskRisk;
}

export interface AuditReviewerValidationCheck extends ValidationCheck {
  failureClass?: string;
}

export interface AuditReviewerPromptInput {
  input: AuditReviewerPromptRequest;
  reviewer: string;
  checks: AuditReviewerValidationCheck[];
  dirtyPaths: string[];
}

interface CompactFailureSummary {
  testFilesFailed?: number;
  testFilesPassed?: number;
  testsFailed?: number;
  testsPassed?: number;
  failingTests?: string[];
  assertionErrors?: string[];
  expected?: string[];
  received?: string[];
}

const MAX_FAILURE_ITEMS = 6;
const MAX_EXCERPT_CHARS = 1_800;

export function compileAuditReviewerPrompt({
  input,
  reviewer,
  checks,
  dirtyPaths
}: AuditReviewerPromptInput): string {
  const evidence = checks.map(compactAuditValidationCheck);
  return [
    "[AEH_AUDIT_REVIEW_ASSIGNMENT]",
    `reviewer=${reviewer}`,
    "",
    "Request:",
    input.request,
    "",
    `Scope: ${(input.files ?? []).join(", ") || "repository-wide"}`,
    `Domains: ${(input.domains ?? []).join(", ") || "unspecified"}`,
    `Risk: ${input.risk ?? "low"}`,
    `Pre-existing dirty paths: ${dirtyPaths.join(", ") || "none"}`,
    "If a finding depends on a pre-existing dirty path, inspect the committed HEAD version rather than treating the local diff as source truth.",
    "",
    "Deterministic evidence packet (controller-derived; passing-test noise and raw bulk logs are intentionally omitted from model context):",
    JSON.stringify(evidence, null, 2)
  ].join("\n");
}

export function compactAuditValidationCheck(check: AuditReviewerValidationCheck): Record<string, unknown> {
  const details = check.details ?? {};
  const base: Record<string, unknown> = {
    id: check.id,
    category: check.category,
    status: check.status,
    message: check.message,
    durationMs: check.durationMs,
    failureClass: check.failureClass
  };

  if (check.status === "PASS" || check.status === "SKIP") {
    return {
      ...base,
      details: compactPassingDetails(details)
    };
  }

  const stdout = String(details.stdout ?? "");
  const stderr = String(details.stderr ?? "");
  const diagnosticText = stderr.trim() || stdout.trim();
  return {
    ...base,
    details: {
      command: details.command,
      cwd: details.cwd,
      exitCode: details.exitCode,
      summary: summarizeFailure(stdout, stderr),
      diagnosticExcerpt: failureExcerpt(diagnosticText),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      rawEvidenceOmittedFromPrompt: true
    }
  };
}

function compactPassingDetails(details: Record<string, unknown>): Record<string, unknown> {
  return {
    command: details.command,
    cwd: details.cwd,
    exitCode: details.exitCode,
    summary: details.summary,
    stdoutBytes: details.stdoutBytes,
    stderrBytes: details.stderrBytes
  };
}

function summarizeFailure(stdout: string, stderr: string): CompactFailureSummary {
  const text = `${stdout}\n${stderr}`;
  const summary: CompactFailureSummary = {};
  const testFiles = text.match(/Test Files\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed/i);
  const tests = text.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed/i);
  if (testFiles?.[1]) summary.testFilesFailed = Number(testFiles[1]);
  if (testFiles?.[2]) summary.testFilesPassed = Number(testFiles[2]);
  if (tests?.[1]) summary.testsFailed = Number(tests[1]);
  if (tests?.[2]) summary.testsPassed = Number(tests[2]);

  const failingTests = matches(stderr || stdout, /^\s*FAIL\s+(.+)$/gim);
  const assertions = matches(stderr || stdout, /^\s*AssertionError:\s*(.+)$/gim);
  const expected = matches(stderr || stdout, /^\s*Expected:\s*(.+)$/gim);
  const received = matches(stderr || stdout, /^\s*Received:\s*(.+)$/gim);
  if (failingTests.length) summary.failingTests = failingTests;
  if (assertions.length) summary.assertionErrors = assertions;
  if (expected.length) summary.expected = expected;
  if (received.length) summary.received = received;
  return summary;
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_FAILURE_ITEMS);
}

function failureExcerpt(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const selected = lines.filter((line) =>
    /(^\s*FAIL\s|AssertionError:|Expected:|Received:|\s❯\s|error|failed with exit code|permission denied|not found|timed out)/i.test(line)
  );
  const source = selected.length ? selected : lines.slice(-20);
  const compact = source.slice(0, 30).join("\n");
  return compact.length <= MAX_EXCERPT_CHARS
    ? compact
    : `${compact.slice(0, MAX_EXCERPT_CHARS)}\n...[diagnostic excerpt truncated]`;
}
