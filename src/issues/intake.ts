import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { loadTaskContract } from "../core/config.js";
import { getCurrentBranch } from "../core/git.js";
import { createQuickContract, validateQuickTaskContract } from "../core/quick.js";
import { formatTraceabilityMatrix, validateSddChange } from "../core/sdd.js";
import { sealTask, verifyTaskSeal } from "../core/seal.js";
import { triageChange, type TriageEvidence, type TriageFlag } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { githubRequest, inferGithubRepository, loadDeliveryRecord, resolveGithubTokenOptional, seedDeliveryRecordFromIssue } from "../delivery/handoff.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";

export interface GithubIssueSnapshot {
  version: 1;
  provider: "github";
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  fetchedAt: string;
  contentSha256: string;
}
export interface IssueInspection { snapshot: GithubIssueSnapshot; evidence: TriageEvidence; preliminaryMode: "quick" | "spec"; reasons: string[]; acceptance: string[]; }
export interface IssuePreparationResult { taskId: string; mode: "quick" | "spec"; contract: TaskContract; snapshot: GithubIssueSnapshot; normalizedBy: "planner" | "deterministic"; traceability?: string; }

const flagSchema = z.enum(["architecture", "security", "authentication", "authorization", "schema", "migration", "public-api", "breaking-change", "new-dependency", "cross-module", "ambiguous"]);
const issuePlanSchema = z.object({
  classification: z.enum(["ready", "requires_product_decision", "spec_contradiction"]), rationale: z.string().min(1), problem: z.string().min(1), desiredOutcome: z.string().min(1),
  requirements: z.array(z.object({ text: z.string().min(1), source: z.enum(["explicit", "repository-derived"]).default("explicit"), validators: z.array(z.string().min(1)).optional() })).min(1),
  acceptance: z.array(z.object({ title: z.string().min(1), requirementIndexes: z.array(z.number().int().positive()).min(1), given: z.string().min(1), when: z.string().min(1), then: z.string().min(1) })).min(1),
  scope: z.object({ allowed: z.array(z.string().min(1)).default([]), forbidden: z.array(z.string().min(1)).default([]), domains: z.array(z.string().min(1)).default([]) }), risk: z.enum(["low", "medium", "high"]), flags: z.array(flagSchema).default([]),
  constraints: z.object({ breakingApiChanges: z.boolean(), newDependencies: z.boolean(), schemaChanges: z.boolean() }), design: z.object({ currentState: z.string().min(1), proposedDesign: z.string().min(1), risks: z.array(z.string()).default([]) }),
  tasks: z.array(z.object({ title: z.string().min(1), requirementIndexes: z.array(z.number().int().positive()).min(1), scope: z.array(z.string()).default([]) })).min(1), nonGoals: z.array(z.string()).default([]), unresolved: z.array(z.string()).default([])
});
export type IssueIntakePlan = z.infer<typeof issuePlanSchema>;
interface GithubIssueResponse { number: number; html_url: string; title: string; body?: string | null; state: string; labels?: Array<string | { name?: string | null }>; created_at: string; updated_at: string; pull_request?: unknown; }

export async function inspectGithubIssue(root: string, config: HarnessProjectConfig, issueNumber: number): Promise<IssueInspection> {
  if (config.workflow?.issueIntake?.enabled === false) throw new Error("GitHub issue intake is disabled by workflow.issueIntake.enabled=false.");
  const snapshot = await fetchGithubIssueSnapshot(root, config, issueNumber);
  if (config.workflow?.issueIntake?.requireOpen !== false && snapshot.state !== "open") throw new Error(`ISSUE_NOT_OPEN: GitHub issue #${issueNumber} is ${snapshot.state}.`);
  const acceptance = extractAcceptance(snapshot.body); const evidence = deriveTriageEvidence(snapshot); const decision = triageChange(config, evidence);
  return { snapshot, evidence, preliminaryMode: decision.mode, reasons: decision.reasons, acceptance };
}

export async function prepareGithubIssueTask(root: string, config: HarnessProjectConfig, issueNumber: number, options: { refresh?: boolean; force?: boolean; usePlanner?: boolean } = {}): Promise<IssuePreparationResult> {
  const inspection = await inspectGithubIssue(root, config, issueNumber); const snapshot = inspection.snapshot; const taskId = taskIdForIssue(issueNumber); const existing = await tryLoadTask(root, config, taskId);
  if (existing?.issue?.provider === "github") {
    if (existing.issue.repository !== snapshot.repository || existing.issue.number !== issueNumber) throw new Error(`ISSUE_SOURCE_MISMATCH: ${taskId} is already bound to a different issue.`);
    if (existing.issue.contentSha256 !== snapshot.contentSha256 && !options.refresh) throw new Error(`ISSUE_DRIFT: GitHub issue #${issueNumber} changed after it was frozen. Re-run with --refresh after reviewing the issue change.`);
    if (existing.issue.contentSha256 === snapshot.contentSha256 && !options.refresh) {
      const seal = await verifyTaskSeal(root, existing, config.validation?.requireSeal ?? true);
      if ((config.validation?.requireSeal ?? true) && seal.status !== "PASS") throw new Error(`LOCAL_CONTRACT_DRIFT: ${seal.message}`);
      await seedDeliveryRecordFromIssue(root, config, existing, { repository: snapshot.repository, issueNumber: snapshot.number, issueUrl: snapshot.url });
      return { taskId, mode: existing.mode ?? "spec", contract: existing, snapshot, normalizedBy: "deterministic" };
    }
    if (options.refresh) { const delivery = await loadDeliveryRecord(root, config, taskId); if (delivery?.paseo?.workspaceId && !options.force) throw new Error("ISSUE_REFRESH_BLOCKED: an implementation workspace already exists. Review/close that workspace or use --force explicitly."); }
  }

  const plannerNeeded = inspection.preliminaryMode === "spec" || inspection.acceptance.length === 0;
  const normalized = plannerNeeded && options.usePlanner !== false ? await normalizeIssueWithPlanner(root, config, snapshot).catch(() => ({ plan: normalizeIssueDeterministically(snapshot), normalizedBy: "deterministic" as const })) : { plan: normalizeIssueDeterministically(snapshot), normalizedBy: "deterministic" as const };
  const plan = normalized.plan;
  if (plan.classification === "spec_contradiction") throw new Error(`SPEC_CONTRADICTION: ${[plan.rationale, ...plan.unresolved].filter(Boolean).join("; ")}`);
  if (plan.classification === "requires_product_decision") throw new Error(`REQUIRES_PRODUCT_DECISION: ${[plan.rationale, ...plan.unresolved].filter(Boolean).join("; ")}`);

  const finalDecision = triageChange(config, { request: `${snapshot.title}\n${snapshot.body}`, files: plan.scope.allowed, domains: plan.scope.domains, risk: plan.risk, flags: plan.flags as TriageFlag[] });
  const snapshotPath = issueSnapshotPath(config, taskId); await writeSnapshot(root, snapshotPath, snapshot); const originatingBranch = await getCurrentBranch(root) ?? config.validation?.baseRef ?? "main";
  let contract: TaskContract; let traceability: string | undefined;
  if (finalDecision.quickEligible && plan.acceptance.length > 0) {
    const quick = await createQuickContract(root, config, taskId, { title: snapshot.title, request: `${snapshot.title}\n\n${snapshot.body}`.trim(), scope: plan.scope.allowed, acceptance: plan.acceptance.map((item) => `${item.title}: ${item.then}`), domains: plan.scope.domains, risk: "low", flags: [] });
    contract = { ...quick.contract, source: { ...(quick.contract.source ?? {}), issue: snapshotPath }, issue: issueMetadata(snapshot, snapshotPath), git: { ...quick.contract.git, baseRef: originatingBranch, originatingBranch }, scope: { ...quick.contract.scope, forbidden: plan.scope.forbidden } };
    await writeContract(root, config, contract); const quickValidation = validateQuickTaskContract(config, contract); if (!quickValidation.ok) throw new Error(`Issue-derived QuickContract failed validation: ${quickValidation.issues.join("; ")}`);
  } else {
    contract = await writeIssueDerivedSdd(root, config, snapshot, snapshotPath, plan, originatingBranch); const validation = await validateSddChange(root, taskId, config); if (!validation.ok) throw new Error(`Issue-derived SDD failed validation: ${[...validation.missing, ...validation.issues].join("; ")}`); traceability = formatTraceabilityMatrix(validation.requirements);
  }
  await sealTask(root, config, contract); await seedDeliveryRecordFromIssue(root, config, contract, { repository: snapshot.repository, issueNumber: snapshot.number, issueUrl: snapshot.url });
  return { taskId, mode: contract.mode ?? "spec", contract, snapshot, normalizedBy: normalized.normalizedBy, traceability };
}

export async function verifyGithubIssueDrift(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<{ ok: boolean; message: string; remote?: GithubIssueSnapshot }> {
  if (!contract.issue || contract.issue.provider !== "github" || config.workflow?.issueIntake?.verifyDriftOnRun === false) return { ok: true, message: "No GitHub issue drift check required." };
  let remote: GithubIssueSnapshot; try { remote = await fetchGithubIssueSnapshot(root, config, contract.issue.number, contract.issue.repository); } catch (error) { throw new Error(`BLOCKED_EXTERNAL: cannot verify GitHub issue #${contract.issue.number} before execution: ${String(error)}`); }
  if (remote.contentSha256 !== contract.issue.contentSha256) return { ok: false, message: `ISSUE_DRIFT: GitHub issue #${contract.issue.number} title/body changed after freeze (${contract.issue.contentSha256.slice(0, 12)} -> ${remote.contentSha256.slice(0, 12)}).`, remote };
  return { ok: true, message: `GitHub issue #${contract.issue.number} still matches the frozen intake snapshot.`, remote };
}
export function taskIdForIssue(issueNumber: number): string { if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("Issue number must be a positive integer."); return `GH-${issueNumber}`; }
export function issueContentSha256(title: string, body: string): string { return crypto.createHash("sha256").update(JSON.stringify({ title: title.trim(), body: body.replace(/\r\n/g, "\n").trim() })).digest("hex"); }

export function normalizeIssueDeterministically(snapshot: GithubIssueSnapshot): IssueIntakePlan {
  const acceptance = extractAcceptance(snapshot.body); const bullets = extractUsefulBullets(snapshot.body); const requirementTexts = unique((acceptance.length ? acceptance : bullets).filter(Boolean)).slice(0, 20); const fallbackRequirement = snapshot.body.trim() ? `${snapshot.title}: ${firstMeaningfulParagraph(snapshot.body)}` : snapshot.title;
  const requirements = (requirementTexts.length ? requirementTexts : [fallbackRequirement]).map((text) => ({ text, source: "explicit" as const, validators: ["gherkin"] })); const paths = extractFilePaths(snapshot.body); const domains = inferDomains(snapshot.labels, snapshot.body); const request = `${snapshot.title}\n${snapshot.body}`;
  const preliminary = triageChange({ version: 1, project: { name: "issue-normalizer" } }, { request, files: paths, domains, risk: inferRisk(snapshot.labels), flags: [] }); const risk = preliminary.quickEligible ? "low" as const : inferRisk(snapshot.labels) === "low" ? "medium" as const : inferRisk(snapshot.labels); const scenarios = requirements.map((item, index) => ({ title: `Satisfy requirement ${index + 1}`, requirementIndexes: [index + 1], given: `the repository is evaluated against frozen GitHub issue #${snapshot.number}`, when: "the issue implementation is completed", then: item.text })); const constraints = inferConstraints(request);
  return { classification: snapshot.body.trim() || snapshot.title.trim() ? "ready" : "requires_product_decision", rationale: "Requirements were normalized from the explicit issue text; repository-specific planning may refine implementation details without changing the frozen issue intent.", problem: firstMeaningfulParagraph(snapshot.body) || snapshot.title, desiredOutcome: snapshot.title, requirements, acceptance: scenarios, scope: { allowed: paths.length ? paths : ["**"], forbidden: [], domains }, risk, flags: inferFlags(request), constraints, design: { currentState: "Use the existing repository architecture and nearby implementation patterns as the baseline.", proposedDesign: "Implement the frozen issue requirements with the smallest architecture-consistent change; routed planning may choose concrete files and tests.", risks: [] }, tasks: requirements.map((_, index) => ({ title: `Implement requirement ${index + 1}`, requirementIndexes: [index + 1], scope: paths })), nonGoals: [], unresolved: [] };
}

async function normalizeIssueWithPlanner(root: string, config: HarnessProjectConfig, snapshot: GithubIssueSnapshot): Promise<{ plan: IssueIntakePlan; normalizedBy: "planner" }> {
  if (!config.agents) throw new Error("No agent topology configured for issue normalization."); const topology = await loadResolvedAgentTopology(root, config, config.agents.activeProfile); const plannerName = config.workflow?.issueIntake?.plannerAgent ?? Object.values(topology.agents).find((agent) => agent.role === "planner" && !agent.disabled)?.name ?? "planner"; if (!topology.agents[plannerName]) throw new Error(`Issue intake planner '${plannerName}' is not available.`);
  const selection = executionSelectionForAgent(topology, plannerName); const provisional: TaskContract = { version: 1, task: { id: taskIdForIssue(snapshot.number), title: snapshot.title }, git: { baseRef: config.validation?.baseRef ?? "main" }, scope: { allowed: ["**"], forbidden: [], frozen: [] }, routing: { intent: "plan", domains: [], risk: "medium" }, constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false } };
  const prompt = `Normalize GitHub issue #${snapshot.number} from ${snapshot.repository} into an engineering intake plan. You are read-only. Inspect the repository to resolve implementation details and existing conventions, but never invent a product decision that cannot be derived from the issue/repository. Classify as requires_product_decision or spec_contradiction only when genuinely unavoidable.\n\nFrozen issue snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nReturn exactly this JSON shape on one final line beginning AEH_RESULT_JSON=:\n${issuePlanContractDescription()}`;
  const session = await executeAgentPrompt(root, config, provisional, selection, prompt); if (session.exitCode !== 0) throw new Error(`Issue planner exited with ${session.exitCode}: ${session.stderr || session.stdout}`); return { plan: issuePlanSchema.parse(extractMarkedJson(session.stdout, session.stderr)), normalizedBy: "planner" };
}
async function fetchGithubIssueSnapshot(root: string, config: HarnessProjectConfig, issueNumber: number, repositoryOverride?: string): Promise<GithubIssueSnapshot> {
  const github = config.delivery?.github; const repository = repositoryOverride ?? github?.repository ?? await inferGithubRepository(root); const apiBase = (github?.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, ""); const token = resolveGithubTokenOptional(github?.tokenEnv); const issue = await githubRequest<GithubIssueResponse>(apiBase, token, `/repos/${repository}/issues/${issueNumber}`); if (issue.pull_request) throw new Error(`GitHub #${issueNumber} is a pull request, not an issue.`); const body = issue.body ?? "";
  return { version: 1, provider: "github", repository, number: issue.number, url: issue.html_url, title: issue.title, body, state: issue.state, labels: (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "").filter(Boolean), createdAt: issue.created_at, updatedAt: issue.updated_at, fetchedAt: new Date().toISOString(), contentSha256: issueContentSha256(issue.title, body) };
}
async function writeIssueDerivedSdd(root: string, config: HarnessProjectConfig, snapshot: GithubIssueSnapshot, snapshotPath: string, plan: IssueIntakePlan, originatingBranch: string): Promise<TaskContract> {
  const taskId = taskIdForIssue(snapshot.number); const specsDir = config.sdd?.specsDir ?? "specs"; const dir = path.join(root, specsDir, "changes", taskId); await fs.mkdir(dir, { recursive: true }); const requirementIds = plan.requirements.map((_, index) => `${taskId}-R${index + 1}`); const requirementLines = plan.requirements.map((item, index) => `- ${requirementIds[index]} — ${item.text} _(${item.source})_`).join("\n");
  const proposal = `# ${taskId}: ${snapshot.title}\n\n## Source\n\nGitHub issue #${snapshot.number}: ${snapshot.url}\nFrozen content SHA-256: \`${snapshot.contentSha256}\`\n\n## Problem\n\n${plan.problem}\n\n## Desired outcome\n\n${plan.desiredOutcome}\n\n## Requirements\n\n${requirementLines}\n\n## Scope\n\n${plan.scope.allowed.map((item) => `- \`${item}\``).join("\n") || "- Repository-defined scope"}\n\n## Non-goals\n\n${plan.nonGoals.map((item) => `- ${item}`).join("\n") || "- No additional behavior beyond the frozen issue requirements."}\n`;
  const spec = `# Specification: ${snapshot.title}\n\n## Frozen source\n\nGitHub issue #${snapshot.number}; content SHA-256 \`${snapshot.contentSha256}\`.\n\n## Requirements\n\n${plan.requirements.map((item, index) => `### ${requirementIds[index]}\n\n${item.text}\n\nSource classification: **${item.source}**.`).join("\n\n")}\n\n## Invariants\n\n- The frozen issue snapshot and this sealed SDD define the run intent.\n- Repository architecture/security invariants remain in force unless the issue explicitly authorizes a change.\n`;
  const design = `# Design: ${snapshot.title}\n\n## Current state\n\n${plan.design.currentState}\n\n## Proposed design\n\n${plan.design.proposedDesign}\n\n## Requirement mapping\n\n${requirementIds.map((id) => `- ${id} — implement using routed specialists within the declared scope.`).join("\n")}\n\n## Data/API impact\n\n- breakingApiChanges: ${plan.constraints.breakingApiChanges}\n- newDependencies: ${plan.constraints.newDependencies}\n- schemaChanges: ${plan.constraints.schemaChanges}\n\n## Risks and trade-offs\n\n${plan.design.risks.map((item) => `- ${item}`).join("\n") || "- No additional issue-specific risks were identified during intake."}\n`;
  const tasks = { version: 1, task: taskId, items: plan.tasks.map((item, index) => ({ id: index + 1, title: item.title, status: "pending", requirements: item.requirementIndexes.map((value) => requirementIds[value - 1]).filter(Boolean), scope: item.scope })) };
  const acceptance = `@${taskId}\nFeature: ${gherkinText(snapshot.title)}\n\n${plan.acceptance.map((item, index) => { const tags = item.requirementIndexes.map((value) => requirementIds[value - 1]).filter(Boolean).map((id) => `@${id}`).join(" "); return `  ${tags}\n  Scenario: ${gherkinText(item.title || `Acceptance ${index + 1}`)}\n    Given ${gherkinText(item.given)}\n    When ${gherkinText(item.when)}\n    Then ${gherkinText(item.then)}`; }).join("\n\n")}\n`;
  const files: Record<string, string> = { "proposal.md": proposal, "spec.md": spec, "design.md": design, "tasks.yaml": YAML.stringify(tasks), "acceptance.feature": acceptance }; for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content); const rel = (name: string) => path.relative(root, path.join(dir, name)).replaceAll("\\", "/");
  const contract: TaskContract = { version: 1, mode: "spec", task: { id: taskId, title: snapshot.title }, source: { proposal: rel("proposal.md"), spec: rel("spec.md"), design: rel("design.md"), tasks: rel("tasks.yaml"), acceptance: rel("acceptance.feature"), issue: snapshotPath }, issue: issueMetadata(snapshot, snapshotPath), git: { baseRef: originatingBranch, originatingBranch }, scope: { allowed: plan.scope.allowed.length ? plan.scope.allowed : ["**"], forbidden: plan.scope.forbidden, frozen: [] }, routing: { intent: "implement", domains: plan.scope.domains, risk: plan.risk }, requirements: plan.requirements.map((item, index) => ({ id: requirementIds[index], description: item.text, validators: item.validators?.length ? item.validators : ["gherkin"] })), constraints: plan.constraints, repair: { maxAttempts: config.orchestration?.worker?.maxRepairAttempts ?? 2 } };
  await writeContract(root, config, contract); return contract;
}
function issueMetadata(snapshot: GithubIssueSnapshot, snapshotPath: string): NonNullable<TaskContract["issue"]> { return { provider: "github", repository: snapshot.repository, number: snapshot.number, url: snapshot.url, state: snapshot.state, fetchedAt: snapshot.fetchedAt, updatedAt: snapshot.updatedAt, contentSha256: snapshot.contentSha256, snapshotPath }; }
async function writeContract(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> { const dir = path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${contract.task.id}.yaml`), YAML.stringify(contract)); }
async function writeSnapshot(root: string, relative: string, snapshot: GithubIssueSnapshot): Promise<void> { const file = path.resolve(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`); }
function issueSnapshotPath(config: HarnessProjectConfig, taskId: string): string { return path.posix.join((config.workflow?.issueIntake?.snapshotDir ?? ".harness/issues").replaceAll("\\", "/"), `${taskId}.json`); }
async function tryLoadTask(root: string, config: HarnessProjectConfig, taskId: string): Promise<TaskContract | undefined> { try { return await loadTaskContract(root, taskId, config); } catch { return undefined; } }
function deriveTriageEvidence(snapshot: GithubIssueSnapshot): TriageEvidence { const request = `${snapshot.title}\n${snapshot.body}`; return { request, files: extractFilePaths(snapshot.body), domains: inferDomains(snapshot.labels, snapshot.body), risk: inferRisk(snapshot.labels), flags: inferFlags(request) }; }
function inferRisk(labels: string[]): "low" | "medium" | "high" { const lower = labels.map((item) => item.toLowerCase()); if (lower.some((item) => /risk[:/-]?high|high[- ]risk|severity[:/-]?high/.test(item))) return "high"; if (lower.some((item) => /risk[:/-]?medium|medium[- ]risk|severity[:/-]?medium/.test(item))) return "medium"; return "low"; }
function inferDomains(labels: string[], body: string): string[] { const known = ["backend", "frontend", "web", "mobile", "data", "database", "api", "security", "auth", "architecture", "ops", "devops", "docs", "test", "e2e"]; const haystack = `${labels.join(" ")} ${body}`.toLowerCase(); return known.filter((domain) => new RegExp(`\\b${domain.replace("-", "[- ]")}\\b`, "i").test(haystack)); }
function inferFlags(request: string): TriageFlag[] { const flags: TriageFlag[] = []; const tests: Array<[TriageFlag, RegExp]> = [["architecture", /\barchitecture|architectural|cross[- ]module|large refactor\b/i], ["security", /\bsecurity|tenant isolation\b/i], ["authentication", /\bauthentication|login|sign[- ]in\b/i], ["authorization", /\bauthorization|permission|role|rbac\b/i], ["schema", /\bschema|table|column\b/i], ["migration", /\bmigration\b/i], ["public-api", /\bpublic api|api contract\b/i], ["breaking-change", /\bbreaking change|backward compat\b/i], ["new-dependency", /\bnew dependency|add dependency|package upgrade\b/i], ["cross-module", /\bcross[- ]module\b/i], ["ambiguous", /\bto be decided|tbd|unclear\b/i]]; for (const [flag, pattern] of tests) if (pattern.test(request)) flags.push(flag); return flags; }
function inferConstraints(request: string): { breakingApiChanges: boolean; newDependencies: boolean; schemaChanges: boolean } { return { breakingApiChanges: /\bbreaking change|break public api|incompatible api\b/i.test(request), newDependencies: /\badd (a )?(new )?dependenc|new dependency|install package\b/i.test(request), schemaChanges: /\bmigration|schema change|add (a )?(table|column)|alter table\b/i.test(request) }; }
function extractAcceptance(body: string): string[] { const sections = extractSections(body); const preferred = Object.entries(sections).filter(([heading]) => /accept|definition of done|expected|requirements?|success criteria/i.test(heading)).flatMap(([, lines]) => extractBullets(lines.join("\n"))); return unique(preferred).slice(0, 20); }
function extractUsefulBullets(body: string): string[] { return unique(extractBullets(body)).filter((item) => item.length >= 5).slice(0, 20); }
function extractBullets(text: string): string[] { return text.split(/\r?\n/).map((line) => line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/)?.[1]?.trim()).filter((value): value is string => Boolean(value)); }
function extractSections(body: string): Record<string, string[]> { const sections: Record<string, string[]> = { "": [] }; let current = ""; for (const line of body.split(/\r?\n/)) { const heading = line.match(/^#{1,6}\s+(.+?)\s*$/); if (heading) { current = heading[1].toLowerCase(); sections[current] ??= []; } else sections[current].push(line); } return sections; }
function extractFilePaths(body: string): string[] { const values = new Set<string>(); for (const match of body.matchAll(/`([^`]+)`/g)) { const value = match[1].trim(); if (looksLikePath(value)) values.add(value); } for (const match of body.matchAll(/(?:^|\s)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@*-]+(?:\.[A-Za-z0-9*]+)?)/gm)) if (looksLikePath(match[1])) values.add(match[1]); return [...values].slice(0, 20); }
function looksLikePath(value: string): boolean { return !value.includes(" ") && !value.startsWith("http") && (value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value)); }
function firstMeaningfulParagraph(body: string): string { return body.split(/\n\s*\n/).map((item) => item.replace(/^#+\s*/gm, "").trim()).find((item) => item && !/^[-*+]\s/.test(item))?.slice(0, 1000) ?? ""; }
function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function gherkinText(value: string): string { return value.replace(/\s+/g, " ").replace(/^\s*(Given|When|Then|And)\s+/i, "").trim().replace(/:/g, " - "); }
function issuePlanContractDescription(): string { return JSON.stringify({ classification: "ready | requires_product_decision | spec_contradiction", rationale: "string", problem: "string", desiredOutcome: "string", requirements: [{ text: "observable requirement", source: "explicit | repository-derived", validators: ["gherkin"] }], acceptance: [{ title: "scenario", requirementIndexes: [1], given: "precondition", when: "action", then: "observable result" }], scope: { allowed: ["repo/paths/or/globs"], forbidden: [], domains: ["backend"] }, risk: "low | medium | high", flags: ["architecture | security | authentication | authorization | schema | migration | public-api | breaking-change | new-dependency | cross-module | ambiguous"], constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false }, design: { currentState: "repository evidence", proposedDesign: "bounded approach", risks: [] }, tasks: [{ title: "task", requirementIndexes: [1], scope: ["paths"] }], nonGoals: [], unresolved: [] }, null, 2); }
