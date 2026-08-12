import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology, ResolvedRoute } from "./types.js";
import { executionSelectionForAgent } from "./routing.js";
import { validateExecutionCapabilities } from "./permissions.js";
import { dedupeFindings, type DedupedFindings } from "./findings.js";
import { orchestratorOutputSchema, plannerOutputSchema, reviewerOutputSchema, type NormalizedFinding, type PlannerOutput } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { analyzeQualityState, evaluateFinalQualityGate, formatDebtScore, type QualityState } from "./qualityConvergence.js";
import { escalationStages, nextEscalationIndex, resumeAfterReplan, selectionForStage } from "./escalation.js";
import { detectHumanException, detectRuntimeExternalException, diagnosisToException, exceptionDiagnosisSchema, type ExceptionDecision } from "./exceptionDetection.js";
import { createWorktreeCheckpoint, rollbackWorktreeCheckpoint } from "./gitCheckpoint.js";
import type { HarnessProjectConfig, ReviewEscalationStage, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { recordEvent } from "../telemetry/events.js";

export type ReviewFinalState = "ACCEPTED" | "SPEC_CONTRADICTION" | "REQUIRES_PRODUCT_DECISION" | "BLOCKED_EXTERNAL" | "SYSTEM_FAILURE";
export interface ReviewLifecycleResult {
  status: "PASS" | "FAIL";
  finalState: ReviewFinalState;
  humanRequired: boolean;
  rounds: number;
  report: ValidationReport;
  findings: DedupedFindings;
  checks: ValidationCheck[];
  sessions: WorkerSession[];
  qualityHistory: QualityState[];
  leadAccepted?: boolean;
  exception?: ExceptionDecision;
}

export async function runReviewLifecycle(input: { root: string; stateRoot?: string; config: HarnessProjectConfig; contract: TaskContract; topology: ResolvedAgentTopology; route: ResolvedRoute; implementationSelection: AgentExecutionSelection; report: ValidationReport; revalidate: () => Promise<ValidationReport>; }): Promise<ReviewLifecycleResult> {
  const { root, config, contract, topology, route, implementationSelection } = input;
  const stateRoot = input.stateRoot ?? root;
  let report = input.report;
  const sessions: WorkerSession[] = [];
  const checks: ValidationCheck[] = [];
  const qualityHistory: QualityState[] = [];
  const policy = config.workflow?.reviews;
  if (policy?.enabled === false) return emptyResult(report, checks, sessions);

  const isQuick = contract.mode === "quick";
  const runReviewers = !isQuick || policy?.reviewQuick === true;
  const reviewerNames = runReviewers ? route.reviewers : [];
  const stages = escalationStages(config);
  let stageIndex = 0;
  let remediationRounds = 0;
  let replanContext: PlannerOutput | undefined;
  let deduped = reviewerNames.length ? await runReviewRound(root, stateRoot, config, contract, topology, reviewerNames, report, sessions, 0) : emptyFindings();
  let state = analyzeQualityState(deduped.findings, qualityHistory, config);
  qualityHistory.push(state);
  await persistQualityState(stateRoot, config, contract.task.id, state);

  while (true) {
    const exception = detectHumanException(deduped.findings);
    if (exception?.humanRequired) return humanExceptionResult(exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);

    if (state.gate.pass) {
      checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "PASS", message: `Final Quality Gate passed: critical=${state.counts.critical}, high=${state.counts.high}, medium=${state.counts.medium}, low=${state.counts.low}, note=${state.counts.note}, DebtScore=${formatDebtScore(state.debtScore)}.`, details: { state } });
      const shouldLeadAccept = policy?.leadAcceptance !== false && (!isQuick || policy?.leadAcceptanceQuick === true);
      if (!shouldLeadAccept) return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory);
      const leadResult = await runLeadAcceptance(root, config, contract, topology, report, deduped, sessions);
      if (leadResult.accepted) {
        checks.push({ id: "agent.lead-acceptance", category: "agent-review", status: "PASS", message: `Lead ${leadResult.agent} accepted finalization.`, details: { summary: leadResult.summary } });
        return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory, true);
      }
      if (leadResult.externalException) return humanExceptionResult(leadResult.externalException, remediationRounds, report, deduped, checks, sessions, qualityHistory);
      if (leadResult.contractFailure) {
        checks.push({ id: "agent.lead-acceptance", category: "agent-review", status: "FAIL", message: leadResult.contractFailure });
        return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds: remediationRounds, report, findings: deduped, checks, sessions, qualityHistory, leadAccepted: false };
      }
      deduped = dedupeFindings(leadResult.unresolved.map((item, index) => leadFinding(index, item, implementationSelection.logicalAgent)));
      state = analyzeQualityState(deduped.findings, qualityHistory, config);
      qualityHistory.push(state);
      await persistQualityState(stateRoot, config, contract.task.id, state);
      stageIndex = Math.max(stageIndex, Math.min(2, Math.max(0, stages.length - 1)));
      continue;
    }

    checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "FAIL", message: `Quality Gate not yet satisfied: ${state.gate.reasons.join("; ")}. Autonomous remediation continues.`, details: { state } });
    stageIndex = nextEscalationIndex(state, stageIndex, config);
    const stage = stages[stageIndex] ?? { name: "normal", action: "remediate" };

    if (stage.action === "diagnose") {
      const diagnosis = await runDiagnosis(root, config, contract, topology, implementationSelection, stage, state, deduped, sessions);
      if (diagnosis?.humanRequired) return humanExceptionResult(diagnosis, remediationRounds, report, deduped, checks, sessions, qualityHistory);
      await recordEvent(stateRoot, config, "harness.quality.diagnosis", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, classification: diagnosis?.type ?? "IMPLEMENTATION_DEFECT" });
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    if (stage.action === "replan") {
      const replanned = await runAutonomousReplan(root, config, contract, topology, implementationSelection, stage, state, deduped, sessions);
      if (replanned.exception?.humanRequired) return humanExceptionResult(replanned.exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);
      if (replanned.plan) {
        replanContext = replanned.plan;
        await persistReplan(stateRoot, config, contract.task.id, remediationRounds, replanned.plan);
      }
      await recordEvent(stateRoot, config, "harness.quality.replan", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, tasks: replanned.plan?.tasks.length ?? 0 });
      stageIndex = resumeAfterReplan(config);
      continue;
    }

    const remediationSelection = selectionForStage(topology, implementationSelection, stage);
    const transport = remediationSelection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : remediationSelection.transport;
    const capabilityIssues = validateExecutionCapabilities(remediationSelection, transport);
    if (capabilityIssues.length) throw new Error(`Quality remediation agent ${remediationSelection.logicalAgent} is not executable: ${capabilityIssues.join("; ")}`);

    const checkpoint = await createWorktreeCheckpoint(root);
    remediationRounds += 1;
    const remediation = await executeAgentPrompt(root, config, contract, remediationSelection, buildRemediationPrompt(contract, stage, state, deduped.findings, replanContext));
    sessions.push(remediation);
    const runtimeException = detectRuntimeExternalException(remediation);
    if (runtimeException?.humanRequired) {
      const restored = await rollbackWorktreeCheckpoint(root, checkpoint);
      report = await input.revalidate();
      await recordEvent(stateRoot, config, "harness.quality.rollback", { taskId: contract.task.id, round: remediationRounds, reason: "external-exception", stage: stage.name, restored });
      return humanExceptionResult(runtimeException, remediationRounds, report, deduped, checks, sessions, qualityHistory);
    }
    if (remediation.exitCode !== 0) {
      const restored = await rollbackWorktreeCheckpoint(root, checkpoint);
      await recordEvent(stateRoot, config, "harness.quality.rollback", { taskId: contract.task.id, round: remediationRounds, reason: "remediation-runtime-failure", stage: stage.name, restored });
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    const candidateReport = await input.revalidate();
    if (candidateReport.status === "FAIL") {
      const restored = await rollbackWorktreeCheckpoint(root, checkpoint);
      report = await input.revalidate();
      await recordEvent(stateRoot, config, "harness.quality.rollback", { taskId: contract.task.id, round: remediationRounds, reason: "deterministic-regression", stage: stage.name, restored });
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    const candidateFindings = reviewerNames.length ? await runReviewRound(root, stateRoot, config, contract, topology, reviewerNames, candidateReport, sessions, qualityHistory.length) : emptyFindings();
    const candidateState = analyzeQualityState(candidateFindings.findings, qualityHistory, config);
    await persistQualityState(stateRoot, config, contract.task.id, candidateState);

    if (candidateState.convergence === "REGRESSING") {
      const restored = await rollbackWorktreeCheckpoint(root, checkpoint);
      report = await input.revalidate();
      await persistRejectedState(stateRoot, config, contract.task.id, candidateState, stage.name, restored);
      await recordEvent(stateRoot, config, "harness.quality.rollback", { taskId: contract.task.id, round: remediationRounds, reason: "review-debt-regression", stage: stage.name, beforeDebtPoints: state.debtPoints, candidateDebtPoints: candidateState.debtPoints, restored });
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    report = candidateReport;
    deduped = candidateFindings;
    state = candidateState;
    qualityHistory.push(state);
    await recordEvent(stateRoot, config, "harness.review.round", { taskId: contract.task.id, round: remediationRounds, reviewers: reviewerNames, findings: deduped.outputCount, debtPoints: state.debtPoints, debtScore: state.debtScore, convergence: state.convergence, resolved: state.resolved.length, persistent: state.persistent.length, introduced: state.introduced.length, stage: stage.name, agent: remediationSelection.logicalAgent, model: remediationSelection.modelId });
  }
}

async function runReviewRound(root: string, stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, reviewerNames: string[], report: ValidationReport, sessions: WorkerSession[], round: number): Promise<DedupedFindings> {
  const findings: NormalizedFinding[] = [];
  const outputs = await Promise.all(reviewerNames.map(async (name) => runReviewer(root, config, contract, topology, name, report)));
  for (const output of outputs) { sessions.push(output.session); findings.push(...output.findings); }
  const deduped = dedupeFindings(findings);
  await persistFindings(stateRoot, config, contract.task.id, round, deduped);
  return deduped;
}

async function runReviewer(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, name: string, report: ValidationReport): Promise<{ session: WorkerSession; findings: NormalizedFinding[] }> {
  const selection = executionSelectionForAgent(topology, name);
  const session = await executeAgentPrompt(root, config, contract, selection, buildReviewerPrompt(contract, name, report));
  if (session.exitCode !== 0) return { session, findings: [syntheticFinding(name, `Reviewer runtime exited with code ${session.exitCode}.`)] };
  try {
    const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    if (output.verdict === "FAIL" && output.findings.length === 0) return { session, findings: [syntheticFinding(name, "Reviewer returned FAIL without a structured finding.")] };
    return { session, findings: output.findings };
  } catch (error) { return { session, findings: [syntheticFinding(name, `Invalid reviewer output contract: ${String(error)}`)] }; }
}

async function runDiagnosis(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, fallback: AgentExecutionSelection, stage: ReviewEscalationStage, state: QualityState, findings: DedupedFindings, sessions: WorkerSession[]): Promise<ExceptionDecision | undefined> {
  const selection = selectionForStage(topology, fallback, stage);
  const session = await executeAgentPrompt(root, config, contract, selection, buildDiagnosisPrompt(contract, state, findings));
  sessions.push(session);
  const external = detectRuntimeExternalException(session); if (external) return external;
  if (session.exitCode !== 0) return undefined;
  try { return diagnosisToException(exceptionDiagnosisSchema.parse(extractMarkedJson(session.stdout, session.stderr))); } catch { return undefined; }
}

async function runAutonomousReplan(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, fallback: AgentExecutionSelection, stage: ReviewEscalationStage, state: QualityState, findings: DedupedFindings, sessions: WorkerSession[]): Promise<{ plan?: PlannerOutput; exception?: ExceptionDecision }> {
  const selection = selectionForStage(topology, fallback, stage);
  const session = await executeAgentPrompt(root, config, contract, selection, buildReplanPrompt(contract, state, findings));
  sessions.push(session);
  const external = detectRuntimeExternalException(session); if (external) return { exception: external };
  if (session.exitCode !== 0) return {};
  try { return { plan: plannerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr)) }; } catch { return {}; }
}

async function runLeadAcceptance(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, report: ValidationReport, findings: DedupedFindings, sessions: WorkerSession[]): Promise<{ accepted: boolean; agent: string; summary?: string; unresolved: string[]; contractFailure?: string; externalException?: ExceptionDecision }> {
  const lead = Object.values(topology.agents).find((agent) => agent.role === "orchestrator" && !agent.disabled);
  if (!lead) return { accepted: false, agent: "<missing>", unresolved: [], contractFailure: "Lead acceptance is enabled but no orchestrator agent is available." };
  const selection = executionSelectionForAgent(topology, lead.name);
  const session = await executeAgentPrompt(root, config, contract, selection, buildLeadPrompt(contract, report, findings));
  sessions.push(session);
  const externalException = detectRuntimeExternalException(session); if (externalException) return { accepted: false, agent: lead.name, unresolved: [], externalException };
  try {
    const parsed = orchestratorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    const accepted = session.exitCode === 0 && parsed.finalizationSafe === true && parsed.unresolved.length === 0;
    return { accepted, agent: lead.name, summary: parsed.summary, unresolved: parsed.unresolved.length ? parsed.unresolved : accepted ? [] : [parsed.summary || "Lead did not declare finalization safe."] };
  } catch (error) { return { accepted: false, agent: lead.name, unresolved: [], contractFailure: `Lead output contract was invalid: ${String(error)}` }; }
}

function buildReviewerPrompt(contract: TaskContract, reviewer: string, report: ValidationReport): string {
  return `You are reviewer ${reviewer} for ${contract.task.id}. Inspect the actual git diff from ${contract.git?.baseRef ?? "main"}, relevant source/tests, and the sealed task contract. Do not modify files. Deterministic validation currently reports ${report.status}. Return {"verdict":"PASS|FAIL|PASS_WITH_WARNINGS","findings":[{"id":"...","severity":"critical|high|medium|low|note","category":"...","location":{"file":"...","startLine":1,"endLine":1},"evidence":"...","impact":"...","recommendedFix":"...","suggestedAgent":"...","exceptionType":"IMPLEMENTATION_DEFECT|SPEC_CONTRADICTION|REQUIRES_PRODUCT_DECISION|BLOCKED_EXTERNAL|SYSTEM_FAILURE (optional)"}],"finalizationSafety":"SAFE|BLOCKED|RISK_KNOWN","followUp":[]}. Use exceptionType only when the issue cannot be resolved from the sealed requirements/repository without an external human decision or resource. Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object.`;
}
function buildRemediationPrompt(contract: TaskContract, stage: ReviewEscalationStage, state: QualityState, findings: NormalizedFinding[], replan?: PlannerOutput): string {
  return `Autonomously remediate review debt for ${contract.task.id}. Stage=${stage.name}. Current DebtScore=${formatDebtScore(state.debtScore)}; final gate requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3. Three notes equal one low. Do not change sealed contracts/specs/acceptance. Critical/high/medium findings are mandatory. Resolve low/note findings as needed to reach the final debt budget without broadening scope or creating regressions. ${replan ? `A stronger planner produced this advisory remediation plan (it does not override the sealed contract):\n${JSON.stringify(replan, null, 2)}\n` : ""}Findings:\n${JSON.stringify(findings, null, 2)}\nMake the smallest coherent changes and run focused checks. Do not ask the user unless a sealed requirement is contradictory, a product decision is genuinely missing, or an external credential/permission is required.`;
}
function buildDiagnosisPrompt(contract: TaskContract, state: QualityState, findings: DedupedFindings): string {
  return `Diagnose why quality remediation for ${contract.task.id} is not converging. Current convergence=${state.convergence}, DebtScore=${formatDebtScore(state.debtScore)}. Inspect the sealed contract/spec, actual diff, tests and findings. Classify ONLY as IMPLEMENTATION_DEFECT, SPEC_CONTRADICTION, REQUIRES_PRODUCT_DECISION, BLOCKED_EXTERNAL, or SYSTEM_FAILURE. Prefer IMPLEMENTATION_DEFECT when the repository/spec already determines the answer. Human intervention is justified only for true contradictions, missing product decisions, or unavailable external credentials/permissions. Return {"classification":"...","rationale":"...","recommendedAction":"..."}. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildReplanPrompt(contract: TaskContract, state: QualityState, findings: DedupedFindings): string {
  return `Create a new implementation strategy for ${contract.task.id} because remediation is ${state.convergence}. The sealed TaskContract/spec is immutable and authoritative; replan implementation only. Current DebtScore=${formatDebtScore(state.debtScore)}. Return the normal planner output contract with tasks[{id,summary,agent,scope,dependencies,acceptance,risk}], affectedAreas, requiredReviewers, validationGates, fallbackRouting and outOfScopeImprovements. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildLeadPrompt(contract: TaskContract, report: ValidationReport, findings: DedupedFindings): string { return `You are the lead engineer performing final semantic acceptance for ${contract.task.id}. The deterministic report and Final Quality Gate have passed. Inspect the actual final diff, sealed requirements/QuickContract and reviewer evidence. Do not modify files. Deterministic status=${report.status}. Remaining findings=${JSON.stringify(findings.findings)}. Return {"summary":"...","delegatedAgents":[],"validationStatus":"${report.status}","unresolved":[],"finalizationSafe":true|false}. If something is unresolved, state it concretely; the Harness will attempt autonomous replanning/remediation rather than immediately asking the user. Final line: AEH_RESULT_JSON=<json>.`; }

function syntheticFinding(agent: string, evidence: string): NormalizedFinding { return { id: `REVIEW-${agent}-${Date.now()}`, severity: "critical", category: "review-contract", location: { file: "<review-output>" }, evidence, impact: "The review cannot be trusted as valid evidence.", recommendedFix: "Repair or rerun the reviewer output contract.", suggestedAgent: agent, exceptionType: "SYSTEM_FAILURE" }; }
function leadFinding(index: number, text: string, agent: string): NormalizedFinding { return { id: `LEAD-${index + 1}`, severity: "medium", category: "lead-unresolved", location: { file: "<lead-acceptance>" }, evidence: text, impact: "Lead semantic acceptance is not yet safe.", recommendedFix: "Replan and remediate the unresolved semantic concern without changing sealed requirements.", suggestedAgent: agent, exceptionType: "IMPLEMENTATION_DEFECT" }; }
function emptyFindings(): DedupedFindings { return { inputCount: 0, outputCount: 0, findings: [], merges: [] }; }
async function persistFindings(root: string, config: HarnessProjectConfig, taskId: string, round: number, findings: DedupedFindings): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-round-${round}.json`), `${JSON.stringify(findings, null, 2)}\n`); }
async function persistQualityState(root: string, config: HarnessProjectConfig, taskId: string, state: QualityState): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-quality-${state.round}.json`), `${JSON.stringify(state, null, 2)}\n`); }
async function persistRejectedState(root: string, config: HarnessProjectConfig, taskId: string, state: QualityState, stage: string, restored: string[]): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-rejected-${Date.now()}.json`), `${JSON.stringify({ stage, state, restored }, null, 2)}\n`); }
async function persistReplan(root: string, config: HarnessProjectConfig, taskId: string, round: number, plan: PlannerOutput): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-replan-${round}.json`), `${JSON.stringify(plan, null, 2)}\n`); }
function humanExceptionResult(exception: ExceptionDecision, rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[]): ReviewLifecycleResult { const nextChecks = [...checks, { id: "agent.human-on-exception", category: "agent-review", status: "FAIL" as const, message: `${exception.type}: ${exception.rationale}`, details: { exception } }]; return { status: "FAIL", finalState: exception.type, humanRequired: true, rounds, report, findings, checks: nextChecks, sessions, qualityHistory, exception }; }
function successResult(rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[], leadAccepted?: boolean): ReviewLifecycleResult { return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted }; }
function emptyResult(report: ValidationReport, checks: ValidationCheck[], sessions: WorkerSession[]): ReviewLifecycleResult { const gate = evaluateFinalQualityGate([], { version: 1, project: { name: "disabled" } }); const state: QualityState = { round: 0, counts: gate.counts, debtPoints: gate.debtPoints, debtScore: gate.debtScore, fingerprint: "", findingFingerprints: [], resolved: [], persistent: [], introduced: [], convergence: "CONVERGED", gate }; return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds: 0, report, findings: emptyFindings(), checks, sessions, qualityHistory: [state] }; }
