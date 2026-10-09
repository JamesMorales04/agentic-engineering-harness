import type { ValidationFinding } from "../core/types.js";
import { sha256Canonical } from "../core/digest.js";

export interface NormalizedFinding extends ValidationFinding {}
export interface ToolEvidenceParseResult { findings: NormalizedFinding[]; valid: boolean; }

interface TrivyReport {
  SchemaVersion: number;
  Trivy: { Version: string };
  ArtifactName: string;
  ArtifactType: string;
  Results?: TrivyResult[] | null;
}

interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Packages?: unknown[] | null;
  Vulnerabilities?: unknown[] | null;
  Misconfigurations?: unknown[] | null;
  Secrets?: unknown[] | null;
}

export function normalizeOpengrepOutput(value: unknown): NormalizedFinding[] {
  const results = record(value).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const result = record(item); const extra = record(result.extra); const start = record(result.start); const end = record(result.end); const metadata = record(extra.metadata);
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "opengrep", kind: "finding", rule: stringValue(result.check_id), severity: stringValue(metadata.severity ?? extra.severity), file: stringValue(result.path), line: numberValue(start.line), endLine: numberValue(end.line), column: numberValue(start.col), endColumn: numberValue(end.col), message: stringValue(extra.message), category: stringValue(metadata.category), cwe: listValue(metadata.cwe) };
    return [{ ...finding, fingerprint: findingFingerprint(finding) }];
  });
}

export function normalizeTrivyOutput(value: unknown): NormalizedFinding[] {
  const results = record(value).Results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const result = record(item); const target = stringValue(result.Target); const findings: NormalizedFinding[] = [];
    for (const [key, kind] of [["Vulnerabilities", "vulnerability"], ["Misconfigurations", "misconfiguration"], ["Secrets", "secret"]] as const) {
      for (const item of Array.isArray(result[key]) ? result[key] : []) {
        const value = record(item); const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "trivy", kind, rule: stringValue(value.VulnerabilityID ?? value.ID ?? value.RuleID), severity: stringValue(value.Severity), package: stringValue(value.PkgName ?? value.Resource), installedVersion: stringValue(value.InstalledVersion), fixedVersion: stringValue(value.FixedVersion), target, file: stringValue(value.Target ?? target), message: stringValue(value.Title ?? value.Message), category: stringValue(result.Class) };
        findings.push({ ...finding, fingerprint: findingFingerprint(finding) });
      }
    }
    return findings;
  });
}

export function normalizePlaywrightOutput(value: unknown): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const visitSuite = (suite: unknown, project?: string): void => {
    const recordSuite = record(suite); const specs = Array.isArray(recordSuite.specs) ? recordSuite.specs : [];
    for (const spec of specs) {
      const specRecord = record(spec); const tests = Array.isArray(specRecord.tests) ? specRecord.tests : [];
      for (const test of tests) {
        const testRecord = record(test); const results = Array.isArray(testRecord.results) ? testRecord.results : [];
        for (const result of results) {
          const resultRecord = record(result); const status = stringValue(resultRecord.status);
          if (status && ["passed", "expected", "skipped"].includes(status)) continue;
          const error = record(resultRecord.error); const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "playwright", kind: "failed-test", rule: stringValue(specRecord.title), message: stringValue(error.message ?? resultRecord.error) ?? "Playwright test failed.", durationMs: numberValue(resultRecord.duration), status, details: { project: project ?? stringValue(testRecord.projectName), attachments: normalizeAttachments(resultRecord.attachments) } };
          findings.push({ ...finding, fingerprint: findingFingerprint(finding) });
        }
      }
    }
    for (const child of Array.isArray(recordSuite.suites) ? recordSuite.suites : []) visitSuite(child, project ?? stringValue(recordSuite.title));
  };
  for (const suite of Array.isArray(record(value).suites) ? record(value).suites : []) visitSuite(suite);
  return findings;
}

export function normalizePactOutput(value: unknown): NormalizedFinding[] {
  // Additive Track F branch: the approved public-api contract validator emits
  // a versioned interaction array via `node scripts/publicApiContract.mjs
  // --json`. It is accepted exactly (marker + version 1 + well-formed
  // interactions); every other shape below stays byte-identical and strict.
  if (hasPublicApiContractMarker(value)) return normalizePublicApiContractOutput(value);
  const root = record(value); const candidates = [...(Array.isArray(root.interactions) ? root.interactions : []), ...(Array.isArray(root.interactionResults) ? root.interactionResults : []), ...(Array.isArray(root.tests) ? root.tests : []), ...(Array.isArray(root.failures) ? root.failures : []), ...(Array.isArray(root.errors) ? root.errors : [])];
  return candidates.flatMap((item) => {
    const result = record(item); const status = stringValue(result.status ?? result.result); const message = stringValue(result.error ?? result.message ?? result.failure); if ((!status && !message) || (status && ["ok", "passed", "success", "verified", "true"].includes(status.toLocaleLowerCase()))) return [];
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "pact", kind: "contract-failure", rule: stringValue(result.description ?? result.id ?? result.name), message, status, details: { consumer: result.consumer, provider: result.provider, pact: result.pact } };
    return [{ ...finding, fingerprint: findingFingerprint(finding) }];
  });
}

export function parseToolEvidence(adapter: string, stdout: string): NormalizedFinding[] {
  return parseToolEvidenceResult(adapter, stdout).findings;
}

/**
 * Structured evidence envelope emitted by `node
 * scripts/publicApiContract.mjs --json`: `{ version: 1, tool:
 * "aeh-public-api-contract", interactions: [{ id, name, status: "pass"|"fail",
 * evidence }], summary }`. Acceptance is exact: marker + version 1 +
 * well-formed interactions. Anything else with the marker present fail-closes
 * (explicit finding, never a silent zero-finding PASS), and payloads without
 * the marker never reach this branch.
 */
export const PUBLIC_API_CONTRACT_EVIDENCE_TOOL = "aeh-public-api-contract" as const;
export const PUBLIC_API_CONTRACT_EVIDENCE_VERSION = 1 as const;

export function hasPublicApiContractMarker(value: unknown): boolean {
  return record(value).tool === PUBLIC_API_CONTRACT_EVIDENCE_TOOL;
}

export function isPublicApiContractEvidence(value: unknown): boolean {
  const root = record(value);
  if (root.tool !== PUBLIC_API_CONTRACT_EVIDENCE_TOOL || root.version !== PUBLIC_API_CONTRACT_EVIDENCE_VERSION) return false;
  if (!Array.isArray(root.interactions)) return false;
  return root.interactions.every((item) => {
    const check = record(item);
    return typeof check.id === "string" && check.id.length > 0
      && typeof check.name === "string"
      && (check.status === "pass" || check.status === "fail")
      && typeof check.evidence === "string";
  });
}

export function normalizePublicApiContractOutput(value: unknown): NormalizedFinding[] {
  const root = record(value);
  if (root.version !== PUBLIC_API_CONTRACT_EVIDENCE_VERSION) {
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "pact", kind: "contract-failure", rule: "PUBLIC-API-CONTRACT-EVIDENCE", message: `unsupported public-api contract evidence version ${String(root.version ?? "missing")}: this harness accepts version ${PUBLIC_API_CONTRACT_EVIDENCE_VERSION} only; refresh the validator instead of accepting stale evidence.`, status: "failed" };
    return [{ ...finding, fingerprint: findingFingerprint(finding) }];
  }
  if (!isPublicApiContractEvidence(value)) {
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "pact", kind: "contract-failure", rule: "PUBLIC-API-CONTRACT-EVIDENCE", message: "malformed public-api contract evidence: the versioned interaction array is missing or not well-formed; a silent zero-interaction run must never satisfy a requirement.", status: "failed" };
    return [{ ...finding, fingerprint: findingFingerprint(finding) }];
  }
  return (root.interactions as unknown[]).flatMap((item) => {
    const check = record(item);
    if (check.status === "pass") return [];
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "pact", kind: "contract-failure", rule: stringValue(check.id), message: stringValue(check.evidence) ?? stringValue(check.name) ?? "Public API contract check failed.", status: "failed", details: { check: check.id, name: check.name } };
    return [{ ...finding, fingerprint: findingFingerprint(finding) }];
  });
}

export function parseToolEvidenceResult(adapter: string, stdout: string): ToolEvidenceParseResult {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch {
    const findings = adapter === "pact" ? normalizePactJunit(stdout) : [];
    return { findings, valid: adapter === "pact" && /<testsuite\b|<testcase\b/i.test(stdout) };
  }
  if (adapter === "opengrep") return { findings: normalizeOpengrepOutput(value), valid: hasArrayField(value, "results") };
  if (adapter === "trivy") return parseTrivyEvidence(value);
  if (adapter === "playwright") return { findings: normalizePlaywrightOutput(value), valid: hasArrayField(value, "suites") };
  if (adapter === "pact") {
    // Versioned public-api contract evidence is valid only when it conforms
    // exactly; a present-but-malformed (or version-drifted) payload is invalid
    // and still yields fail-closed findings via normalizePactOutput above.
    if (hasPublicApiContractMarker(value)) return { findings: normalizePublicApiContractOutput(value), valid: isPublicApiContractEvidence(value) };
    return { findings: normalizePactOutput(value), valid: hasAnyArrayField(value, ["interactions", "interactionResults", "tests", "failures", "errors"]) };
  }
  return { findings: [], valid: true };
}

function normalizePactJunit(xml: string): NormalizedFinding[] {
  if (!/<testsuite\b|<testcase\b/i.test(xml)) return [];
  const findings: NormalizedFinding[] = [];
  for (const testcase of xml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/gi)) {
    const attrs = attributes(testcase[1] ?? ""); const body = testcase[2] ?? "";
    const failure = body.match(/<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/i);
    if (!failure) continue;
    const failureAttrs = attributes(failure[1] ?? "");
    const finding: Omit<NormalizedFinding, "fingerprint"> = { tool: "pact", kind: "contract-failure", rule: attrs.name, message: stripXml(failure[2] ?? "") || failureAttrs.message, status: "failed", durationMs: attrs.time ? Number(attrs.time) * 1000 : undefined, details: { classname: attrs.classname } };
    findings.push({ ...finding, fingerprint: findingFingerprint(finding) });
  }
  return findings;
}

function normalizeAttachments(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of ["name", "path", "contentType", "sha1"]) if (typeof record[key] === "string") result[key] = record[key] as string;
    return Object.keys(result).length ? [result] : [];
  });
}

function attributes(value: string): Record<string, string> { const result: Record<string, string> = {}; for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g)) result[match[1]] = match[2]; return result; }
function stripXml(value: string): string { return value.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim(); }

export function findingFingerprint(finding: Omit<NormalizedFinding, "fingerprint"> | NormalizedFinding): string {
  const value = { tool: finding.tool, kind: finding.kind, rule: finding.rule, severity: finding.severity, file: finding.file, line: finding.line, endLine: finding.endLine, package: finding.package, target: finding.target, message: finding.message };
  return sha256Canonical(value);
}

function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function hasArrayField(value: unknown, field: string): boolean { return Array.isArray(record(value)[field]); }
function hasAnyArrayField(value: unknown, fields: string[]): boolean { return fields.some((field) => hasArrayField(value, field)); }
function parseTrivyEvidence(value: unknown): ToolEvidenceParseResult {
  return isTrivyReport(value) ? { findings: normalizeTrivyOutput(value), valid: true } : { findings: [], valid: false };
}
function isTrivyReport(value: unknown): value is TrivyReport {
  const root = record(value); const metadata = record(root.Trivy);
  if (root.SchemaVersion !== 2 || typeof metadata.Version !== "string" || typeof root.ArtifactName !== "string" || typeof root.ArtifactType !== "string") return false;
  if (!("Results" in root) || root.Results === null) return true;
  return Array.isArray(root.Results) && root.Results.every(isTrivyResult);
}
function isTrivyResult(value: unknown): value is TrivyResult {
  const result = record(value);
  if (!("Target" in result || "Class" in result || "Type" in result)) return false;
  for (const field of ["Target", "Class", "Type"] as const) if (field in result && typeof result[field] !== "string") return false;
  for (const field of ["Packages", "Vulnerabilities", "Misconfigurations", "Secrets"] as const) if (field in result && result[field] !== null && !Array.isArray(result[field])) return false;
  return true;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function listValue(value: unknown): string[] | undefined { if (Array.isArray(value)) return value.map(String); if (typeof value === "string") return [value]; return undefined; }
