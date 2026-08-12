import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent, resolveRoute } from "../agents/routing.js";
import { dedupeFindings } from "../agents/findings.js";
import { reviewerOutputSchema, type NormalizedFinding } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { calculateQuality, evaluateFinalQualityGate, type QualityGateResult, type SeverityCounts } from "../agents/qualityConvergence.js";
import { createWorktreeCheckpoint, rollbackWorktreeCheckpoint } from "../agents/gitCheckpoint.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, TaskRisk, ValidationCheck, WorkerSession } from "../core/types.js";
import { runValidationCommand } from "../validators/commands.js";
import { runConfiguredValidators } from "../validators/registry.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { recordEvent } from "../telemetry/events.js";
import { runProcess } from "../utils/process.js";

export type AuditFailureClass = "NONE" | "ASSERTION_FAILURE" | "ENVIRONMENT_FAILURE" | "SANDBOX_DENIAL" | "MISSING_DEPENDENCY" | "TOOL_FAILURE";
export type AuditStatus = "CLEAN" | "FINDINGS" | "DEGRADED";

export interface AuditRequest {
  request: string;
  files?: string[];
  domains?: string[];
  risk?: TaskRisk;
  reviewers?: string[];
  auditId?: string;
}

export interface AuditValidationCheck extends ValidationCheck { failureClass: AuditFailureClass; }

export interface AuditReport {
  version: 1;
  auditId: string;
  intent: "audit";
  request: string;
  status: AuditStatus;
  startedAt: string;
  finishedAt: string;
  repository: { root: string; commit?: string; baseRef: string; dirtyPaths: string[] };
  reviewers: string[];
  validationChecks: AuditValidationCheck[];
  findings: NormalizedFinding[];
  counts: SeverityCounts;
  debtPoints: number;
  debtScore: number;
  qualityGate: QualityGateResult;
  productionSafe: boolean;
  sessions: WorkerSession[];
  restoredPaths: string[];
  controlPlaneSha256?: string;
}

const AUDIT_OUTPUT_DIR = ".harness/audits";
const MAX_AUDIT_REVIEWERS = 4;
const DEFAULT_AUDIT_REVIEWERS = ["code-quality-reviewer", "architecture-reviewer", "security-reviewer", "test-quality-reviewer", "test-reviewer"];

export async function runAudit(root: string, config: HarnessProjectConfig, input: AuditRequest): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const auditId = input.auditId ?? createAuditId(input.request);
  const baseRef = config.validation?.baseRef ?? "HEAD";
  const checkpoint = await createWorktreeCheckpoint(root);
  const dirtyPaths = [...checkpoint.files.keys()].sort();
  const commit = await gitCommit(root);
  const contract = auditContract(auditId, input, baseRef);
  const snapshot = await createControlPlaneSnapshot(root, config, auditId);
  const topology = await loadResolvedAgentTopology(root, config, config.agents?.activeProfile);
  const reviewers = selectAuditReviewers(topology, input);
  const sessions: WorkerSession[] = [];
  const validationChecks: AuditValidationCheck[] = [];
  const findings: NormalizedFinding[] = [];
  let restoredPaths: string[] = [];

  await recordEvent(root, config, "harness.audit.start", { auditId, request: input.request, reviewers, dirtyPaths, commit });
  try {
    for (const command of config.validation?.commands ?? []) validationChecks.push(classifyValidationCheck(await runValidationCommand(root, command)));
    validationChecks.push(...(await runConfiguredValidators(root, config, contract, baseRef, [])).map(classifyValidationCheck));
    const outputs = await Promise.all(reviewers.map((name) => runAuditReviewer(root, config, contract, topology, name, input, validationChecks, dirtyPaths)));
    for (const output of outputs) { sessions.push(output.session); findings.push(...output.findings); }
  } finally {
    restoredPaths = await rollbackWorktreeCheckpoint(root, checkpoint);
  }

  const deduped = dedupeFindings(findings);
  const quality = calculateQuality(deduped.findings, config);
  const qualityGate = evaluateFinalQualityGate(deduped.findings, config);
  const validationDegraded = validationChecks.some((check) => check.status === "FAIL" || check.status === "WARN");
  const status: AuditStatus = validationDegraded ? "DEGRADED" : deduped.findings.length ? "FINDINGS" : "CLEAN";
  const report: AuditReport = {
    version: 1,
    auditId,
    intent: "audit",
    request: input.request,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    repository: { root: path.resolve(root), commit, baseRef, dirtyPaths },
    reviewers,
    validationChecks,
    findings: deduped.findings,
    counts: quality.counts,
    debtPoints: quality.debtPoints,
    debtScore: quality.debtScore,
    qualityGate,
    productionSafe: !validationChecks.some((check) => check.status === "FAIL") && qualityGate.pass,
    sessions,
    restoredPaths,
    controlPlaneSha256: snapshot.compositeSha256
  };
  await persistAudit(root, report);
  await recordEvent(root, config, "harness.audit.finish", { auditId, status, findings: report.findings.length, debtPoints: report.debtPoints, productionSafe: report.productionSafe });
  return report;
}

export async function loadAuditReport(root: string, auditId: string): Promise<AuditReport> {
  return JSON.parse(await fs.readFile(path.resolve(root, AUDIT_OUTPUT_DIR, `${auditId}.json`), "utf8")) as AuditReport;
}

export function classifyValidationCheck(check: ValidationCheck): AuditValidationCheck { return { ...check, failureClass: classifyAuditFailure(check) }; }

export function classifyAuditFailure(check: ValidationCheck): AuditFailureClass {
  if (check.status === "PASS" || check.status === "SKIP") return "NONE";
  const details = check.details ?? {};
  const text = [check.message, String(details.stderr ?? ""), String(details.stdout ?? ""), String(details.error ?? "")].join("\n").toLowerCase();
  if (/\b(eperm|eacces|permission denied|operation not permitted|sandbox|seccomp|denied by policy)\b/.test(text)) return "SANDBOX_DENIAL";
  if (/\b(enoent|command not found|not found:|cannot find module|module not found|missing dependency|no such file or directory)\b/.test(text)) return "MISSING_DEPENDENCY";
  if (/\b(timeout|timed out|environment|out of memory|oom|resource temporarily unavailable|network unavailable|dns)\b/.test(text)) return "ENVIRONMENT_FAILURE";
  if (/\b(assert|assertion|expected .* received|expected .* to)\b/.test(text)) return "ASSERTION_FAILURE";
  return "TOOL_FAILURE";
}

function auditContract(auditId: string, input: AuditRequest, baseRef: string): TaskContract {
  return { version: 1, task: { id: auditId, title: `Audit: ${input.request.slice(0, 120)}` }, git: { baseRef }, scope: { allowed: input.files ?? [] }, routing: { intent: "audit", domains: input.domains ?? [], risk: input.risk ?? "low", reviewers: input.reviewers ?? [] }, constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false } };
}

function selectAuditReviewers(topology: ResolvedAgentTopology, input: AuditRequest): string[] {
  const routed = resolveRoute(topology, { intent: "audit", domains: input.domains ?? [], files: input.files ?? [], risk: input.risk ?? "low" }).reviewers;
  const requested = [...new Set([...(input.reviewers ?? []), ...routed, ...DEFAULT_AUDIT_REVIEWERS])];
  const available = requested.filter((name) => topology.agents[name]?.role === "reviewer" && !topology.agents[name]?.disabled);
  if (available.length) return available.slice(0, MAX_AUDIT_REVIEWERS);
  return Object.values(topology.agents).filter((agent) => agent.role === "reviewer" && !agent.disabled).map((agent) => agent.name).slice(0, MAX_AUDIT_REVIEWERS);
}

async function runAuditReviewer(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, reviewer: string, input: AuditRequest, checks: AuditValidationCheck[], dirtyPaths: string[]): Promise<{ session: WorkerSession; findings: NormalizedFinding[] }> {
  const base = executionSelectionForAgent(topology, reviewer);
  const selection: AgentExecutionSelection = { ...base, permissions: { ...base.permissions, write: "deny", gitWrite: "deny", delegate: "deny" } };
  const session = await executeAgentPrompt(root, config, contract, selection, buildAuditReviewerPrompt(input, reviewer, checks, dirtyPaths), { outputContract: "reviewer" });
  if (session.exitCode !== 0) return { session, findings: [syntheticFinding(reviewer, `Audit reviewer runtime exited with code ${session.exitCode}.`)] };
  try {
    const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    if (output.verdict === "FAIL" && output.findings.length === 0) return { session, findings: [syntheticFinding(reviewer, "Audit reviewer returned FAIL without a structured finding.")] };
    return { session, findings: output.findings };
  } catch (error) { return { session, findings: [syntheticFinding(reviewer, `Invalid audit reviewer output contract: ${String(error)}`)] }; }
}

function buildAuditReviewerPrompt(input: AuditRequest, reviewer: string, checks: AuditValidationCheck[], dirtyPaths: string[]): string {
  return `You are ${reviewer} performing an AEH read-only engineering AUDIT.\n\nRequest:\n${input.request}\n\nScope hints: ${(input.files ?? []).join(", ") || "repository-wide"}\nDomains: ${(input.domains ?? []).join(", ") || "unspecified"}\nRisk: ${input.risk ?? "low"}\n\nThis is analysis only. Do not edit, create, delete, format, stage or commit repository files. Findings must be concrete, evidenced and actionable. Do not report style-only noise already enforced by deterministic tooling. Do not silently dismiss a deterministic failure as environment noise; use the supplied failure classification as evidence and state uncertainty when code correctness cannot be established.\n\nThe worktree had these pre-existing dirty paths when the audit started: ${dirtyPaths.join(", ") || "none"}. Do not treat pre-existing local diffs as committed source truth; inspect HEAD versions when a finding depends on one of those paths.\n\nDeterministic validation evidence:\n${JSON.stringify(checks, null, 2)}\n\nReturn the reviewer output contract as native JSON when supported, otherwise exactly one marker line:\nAEH_RESULT_JSON={"verdict":"PASS|FAIL|PASS_WITH_WARNINGS","findings":[],"finalizationSafety":"SAFE|BLOCKED|RISK_KNOWN","followUp":[]}`;
}

function syntheticFinding(agent: string, evidence: string): NormalizedFinding { return { id: `AUDIT-${agent}-SYSTEM`, severity: "critical", category: "audit-system", location: { file: ".harness" }, evidence, impact: "The requested audit could not be completed reliably.", recommendedFix: "Repair the reviewer/runtime contract and rerun the audit.", suggestedAgent: agent, exceptionType: "SYSTEM_FAILURE" }; }

async function persistAudit(root: string, report: AuditReport): Promise<void> {
  const outputDir = path.resolve(root, AUDIT_OUTPUT_DIR); await fs.mkdir(outputDir, { recursive: true }); const file = path.join(outputDir, `${report.auditId}.json`); await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`); await fs.writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify({ auditId: report.auditId, report: path.relative(root, file), finishedAt: report.finishedAt }, null, 2)}\n`);
}

function createAuditId(request: string): string { const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); const hash = crypto.createHash("sha256").update(request).digest("hex").slice(0, 8); return `AUDIT-${stamp}-${hash}`; }
async function gitCommit(root: string): Promise<string | undefined> { const result = await runProcess("git rev-parse HEAD", { cwd: root, timeoutMs: 10_000 }); return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined; }
