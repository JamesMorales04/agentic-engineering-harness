import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedRoute } from "./types.js";
import { validateExecutionCapabilities } from "./permissions.js";
import { dedupeFindings, type DedupedFindings } from "./findings.js";
import { orchestratorOutputSchema, plannerOutputSchema, reviewerOutputSchema, type NormalizedFinding, type PlannerOutput } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { analyzeQualityState, evaluateFinalQualityGate, formatDebtScore, type QualityState } from "./qualityConvergence.js";
import { escalationStages, nextEscalationIndex, resumeAfterReplan } from "./escalation.js";
import { detectHumanException, detectRuntimeExternalException, diagnosisToException, exceptionDiagnosisSchema, type ExceptionDecision } from "./exceptionDetection.js";
import type { HarnessProjectConfig, ReviewEscalationStage, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { executeRepairerCandidateMutation, rejectRepairCandidateChangeSet } from "../candidates/repair.js";
import { executeIsolatedCandidateMutation } from "../candidates/direct.js";
import { assertWorkspaceMatchesCandidate, type CandidateWorkspaceIdentityEvidenceV1 } from "../candidates/identity.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import { recordEvent } from "../telemetry/events.js";
import { currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1 } from "../candidates/assembler.js";
import type { CandidateAssuranceCompilationV1, CandidateAssuranceReviewAssignmentV1 } from "../architecture/candidateAssurance.js";
import { consolidateWithOperationSupervisor, maybeRotateOperationSupervisor } from "../operations/supervisor.js";

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

export async function runReviewLifecycle(input: { root: string; stateRoot?: string; config: HarnessProjectConfig; contract: TaskContract; route: ResolvedRoute; reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>; leadSelection?: AgentExecutionSelection; repairerSelection?: AgentExecutionSelection; executionCatalog?: ExecutionCatalogV1; prepareRepairWorkspace?: (isolatedRoot: string) => Promise<void>; stageSelections?: Readonly<Record<string, AgentExecutionSelection | undefined>>; supervisorSelection?: AgentExecutionSelection; implementationSelection: AgentExecutionSelection; report: ValidationReport; candidateImpact?: CandidateImpactV1; candidateImpactAssessment?: CandidateImpactAssessmentRuntimeV1; candidateAssurance?: CandidateAssuranceCompilationV1; assuranceGateCheck?: ValidationCheck; recompileCandidateAssurance?: (impact: CandidateImpactV1 | undefined, report: ValidationReport) => Promise<{ compilation?: CandidateAssuranceCompilationV1; validationChecks: ValidationCheck[]; gateCheck: ValidationCheck }>; revalidate: () => Promise<ValidationReport>; }): Promise<ReviewLifecycleResult> {
  const { root, config, contract, route, reviewerSelections, leadSelection, repairerSelection, executionCatalog, prepareRepairWorkspace, stageSelections, supervisorSelection, implementationSelection } = input;
  const stateRoot = input.stateRoot ?? root;
  let report = input.report;
  const sessions: WorkerSession[] = [];
  const checks: ValidationCheck[] = [];
  const qualityHistory: QualityState[] = [];
  const policy = config.workflow?.reviews;
  let candidateImpact = input.candidateImpact;
  let candidateAssurance = input.candidateAssurance;
  let assuranceGateCheck = input.assuranceGateCheck;
  const requiredAssignments = candidateAssurance?.reviewAssignments ?? [];
  if (policy?.enabled === false && requiredAssignments.length === 0) return emptyResult(report, checks, sessions);

  if (!report.candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: review requires a candidate-bound validation report.");
  checks.push(candidateIdentityCheck("candidate.workspace-identity.review-entry", await assertCurrentReviewCandidate(root, report.candidate)));
  if (assuranceGateCheck) checks.push(assuranceGateCheck);

  const isDirect = contract.routing?.route === "DIRECT";
  const runReviewers = requiredAssignments.length > 0 || !isDirect || policy?.directReview === true;
  let reviewerAssignments = requiredAssignments;
  let reviewerNames = requiredAssignments.length
    ? requiredAssignments.map((assignment) => assignment.reviewerIdentity)
    : runReviewers ? route.reviewers : [];
  const recompileCandidate = async (impact: CandidateImpactV1 | undefined, candidateReport: ValidationReport): Promise<ValidationReport> => {
    if (!input.recompileCandidateAssurance) return candidateReport;
    const evaluation = await input.recompileCandidateAssurance(impact, candidateReport);
    candidateImpact = impact;
    candidateAssurance = evaluation.compilation;
    assuranceGateCheck = evaluation.gateCheck;
    reviewerAssignments = candidateAssurance?.reviewAssignments ?? [];
    reviewerNames = reviewerAssignments.length
      ? reviewerAssignments.map((assignment) => assignment.reviewerIdentity)
      : runReviewers ? route.reviewers : [];
    const prior = checks.findIndex((check) => check.id === evaluation.gateCheck.id);
    if (prior >= 0) checks[prior] = evaluation.gateCheck;
    else checks.push(evaluation.gateCheck);
    return mergeReviewCheck(candidateReport, evaluation.gateCheck);
  };
  const stages = escalationStages(config);
  let stageIndex = 0;
  let remediationRounds = 0;
  let replanContext: PlannerOutput | undefined;
  let deduped = reviewerNames.length ? await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, report, sessions, 0, checks, prepareRepairWorkspace, reviewerAssignments) : emptyFindings();
  let state = analyzeQualityState(deduped.findings, qualityHistory, config, report.candidate?.identityDigest);
  qualityHistory.push(state);
  await persistQualityState(stateRoot, config, contract.task.id, state);

  while (true) {
    const exception = detectHumanException(deduped.findings);
    if (exception?.humanRequired) return humanExceptionResult(exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);

    if (state.gate.pass) {
      checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "PASS", message: `Final Quality Gate passed: critical=${state.counts.critical}, high=${state.counts.high}, medium=${state.counts.medium}, low=${state.counts.low}, note=${state.counts.note}, DebtScore=${formatDebtScore(state.debtScore)}.`, details: { state } });
      const shouldLeadAccept = policy?.leadAcceptance !== false && (!isDirect || policy?.leadAcceptanceDirect === true);
      if (!shouldLeadAccept) return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory);

      if (currentOperationContext().id) {
        // The durable operation is bound to the actual interactive lead. Do not
        // synthesize a second hidden orchestrator session inside the RUN. The
        // controller uses the bound Lead for candidate-bound semantic evidence
        // in the S6 AcceptanceOracle phase before any delivery effects.
        checks.push({
          id: "agent.interactive-lead-acceptance",
          category: "agent-review",
          status: "PASS",
          message: "Deterministic quality checks passed; bound Lead semantic evidence and the controller-owned AcceptanceOracle run afterward before delivery. This quality check is not product acceptance."
        });
        return successResult(remediationRounds, report, deduped, checks, sessions, qualityHistory);
      }

      // Synchronous/non-controller compatibility path.
      const leadResult = await runLeadAcceptance(root, config, contract, leadSelection, report, deduped, sessions);
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
      state = analyzeQualityState(deduped.findings, qualityHistory, config, report.candidate?.identityDigest);
      qualityHistory.push(state);
      await persistQualityState(stateRoot, config, contract.task.id, state);
      stageIndex = Math.max(stageIndex, Math.min(2, Math.max(0, stages.length - 1)));
      continue;
    }

    checks.push({ id: "agent.final-quality-gate", category: "agent-review", status: "FAIL", message: `Quality Gate not yet satisfied: ${state.gate.reasons.join("; ")}. Autonomous remediation continues.`, details: { state } });
    stageIndex = nextEscalationIndex(state, stageIndex, config);
    const stage = stages[stageIndex] ?? { name: "normal", action: "remediate" };

    if (stage.action === "diagnose") {
      const diagnosis = await runDiagnosis(root, config, contract, stageSelections?.[stage.name] ?? implementationSelection, state, deduped, sessions);
      if (diagnosis?.humanRequired) return humanExceptionResult(diagnosis, remediationRounds, report, deduped, checks, sessions, qualityHistory);
      await recordEvent(stateRoot, config, "harness.quality.diagnosis", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, classification: diagnosis?.type ?? "IMPLEMENTATION_DEFECT" });
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    if (stage.action === "replan") {
      const replanned = await runAutonomousReplan(root, config, contract, stageSelections?.[stage.name] ?? implementationSelection, state, deduped, sessions);
      if (replanned.exception?.humanRequired) return humanExceptionResult(replanned.exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);
      if (replanned.plan) {
        replanContext = replanned.plan;
        await persistReplan(stateRoot, config, contract.task.id, remediationRounds, replanned.plan);
      }
      await recordEvent(stateRoot, config, "harness.quality.replan", { taskId: contract.task.id, round: remediationRounds, stage: stage.name, workUnits: replanned.plan?.workUnits.length ?? 0 });
      stageIndex = resumeAfterReplan(config);
      continue;
    }

    const remediationSelection = repairerSelection;
    if (!remediationSelection || !executionCatalog) throw new Error("REPAIR_AUTHORITY_REQUIRED: review remediation requires a frozen Repairer selection and compiled role binding.");
    const transport = remediationSelection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : remediationSelection.transport;
    const capabilityIssues = validateExecutionCapabilities(remediationSelection, transport);
    if (remediationSelection.role !== "Repairer") throw new Error("REPAIR_AUTHORITY_REQUIRED: quality remediation may only be performed by the canonical Repairer role.");
    if (capabilityIssues.length) throw new Error(`Quality Repairer ${remediationSelection.logicalAgent} is not executable: ${capabilityIssues.join("; ")}`);

    remediationRounds += 1;
    const operationId = currentOperationContext().id;
    if (!operationId) throw new Error("REPAIR_AUTHORITY_REQUIRED: quality remediation requires a managed operation.");
    const repairPrompt = `${buildRemediationPrompt(contract, stage, state, deduped.findings, replanContext)}\n\nYou are the canonical Repairer. Change implementation only within the frozen task scope. Do not change requirements, acceptance, validators, policy, or review outcomes. You cannot approve or accept the candidate.`;
    const mutation = await executeRepairerCandidateMutation({
      root,
      stateRoot,
      operationId,
      taskId: contract.task.id,
      workUnitId: `quality-repair:${contract.task.id}:${remediationRounds}`,
      phase: "review-remediation",
      config,
      contract,
      selection: remediationSelection,
      executionCatalog,
      allowedScope: contract.scope?.allowed ?? ["**"],
      forbiddenScope: [...(contract.scope?.forbidden ?? []), ...(contract.scope?.frozen ?? []), ...(config.validation?.frozenPaths ?? [])],
      prompt: repairPrompt,
      prepareWorkspace: prepareRepairWorkspace,
      semanticAssessment: input.candidateImpactAssessment,
      execute: (isolatedRoot, participantId) => executeAgentPrompt(isolatedRoot, config, contract, remediationSelection, repairPrompt, { phase: "repair", operationKind: currentOperationContext().kind, participantId, requireExecutionAuthority: true })
    });
    const remediation = mutation.session;
    sessions.push(remediation);
    const rejectMutation = async (reason: string): Promise<void> => {
      let restoredImpact = candidateImpact;
      if (mutation.changeSet) {
        const restored = await rejectRepairCandidateChangeSet({
          root,
          stateRoot,
          operationId,
          taskId: contract.task.id,
          workUnitId: `quality-repair:${contract.task.id}:${remediationRounds}:reject`,
          config,
          contract,
          rejectedChangeSet: mutation.changeSet,
          allowedScope: contract.scope?.allowed ?? ["**"],
          forbiddenScope: [...(contract.scope?.forbidden ?? []), ...(contract.scope?.frozen ?? []), ...(config.validation?.frozenPaths ?? [])],
          prepareWorkspace: prepareRepairWorkspace,
          semanticAssessment: input.candidateImpactAssessment
        });
        restoredImpact = restored.impact;
      }
      report = await input.revalidate();
      report = await recompileCandidate(restoredImpact, report);
      await recordEvent(stateRoot, config, "harness.quality.candidate-rejected", { taskId: contract.task.id, round: remediationRounds, reason, candidateRevision: report.candidate?.revision, candidateDigest: report.candidate?.sourceDigest });
    };
    const runtimeException = detectRuntimeExternalException(remediation);
    if (runtimeException?.humanRequired) {
      await rejectMutation("external-exception");
      return humanExceptionResult(runtimeException, remediationRounds, report, deduped, checks, sessions, qualityHistory);
    }
    if (remediation.exitCode !== 0) {
      await rejectMutation("repairer-runtime-failure");
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    let candidateReport = await input.revalidate();
    candidateReport = await recompileCandidate(mutation.impact ?? candidateImpact, candidateReport);
    const expectedCandidate = mutation.candidate?.identityDigest ?? report.candidate?.identityDigest;
    const observedCandidate = candidateReport.candidate?.identityDigest;
    if (expectedCandidate !== observedCandidate && (expectedCandidate !== undefined || observedCandidate !== undefined)) {
      throw new Error(`V2_CANDIDATE_BINDING_REJECTED: Repairer candidate identity drifted during review remediation (expected ${expectedCandidate}, observed ${observedCandidate}).`);
    }
    if (candidateReport.status === "FAIL") {
      await rejectMutation("deterministic-regression");
      stageIndex = Math.min(stageIndex + 1, Math.max(0, stages.length - 1));
      continue;
    }

    const candidateFindings = reviewerNames.length ? await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, candidateReport, sessions, qualityHistory.length, checks, prepareRepairWorkspace, reviewerAssignments) : emptyFindings();
    const candidateState = analyzeQualityState(candidateFindings.findings, qualityHistory, config, candidateReport.candidate?.identityDigest);
    await persistQualityState(stateRoot, config, contract.task.id, candidateState);

    if (candidateState.convergence === "REGRESSING") {
      await rejectMutation("review-debt-regression");
      await persistRejectedState(stateRoot, config, contract.task.id, candidateState, stage.name, [report.candidate ? `candidate-r${report.candidate.revision}` : "candidate-unknown"]);
      await recordEvent(stateRoot, config, "harness.quality.candidate-rejected", { taskId: contract.task.id, round: remediationRounds, reason: "review-debt-regression", stage: stage.name, beforeDebtPoints: state.debtPoints, candidateDebtPoints: candidateState.debtPoints, candidateRevision: report.candidate?.revision });
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

async function runReviewRound(root: string, stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>, implementationSelection: AgentExecutionSelection, supervisorSelection: AgentExecutionSelection | undefined, reviewerNames: string[], report: ValidationReport, sessions: WorkerSession[], round: number, checks: ValidationCheck[], prepareReviewWorkspace?: (isolatedRoot: string) => Promise<void>, assuranceAssignments: readonly CandidateAssuranceReviewAssignmentV1[] = []): Promise<DedupedFindings> {
  if (!report.candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
  const assuranceByIdentity = new Map(assuranceAssignments.map((assignment) => [assignment.reviewerIdentity, assignment]));
  const outputs = await Promise.all(reviewerNames.map(async (name) => {
    const selection = reviewerSelections[name];
    if (!selection || selection.role !== "Reviewer") throw new Error(`REVIEW_AUTHORITY_REQUIRED: '${name}' is not a frozen canonical Reviewer selection.`);
    if (selection.logicalAgent === implementationSelection.logicalAgent) throw new Error("REVIEW_INDEPENDENCE_REQUIRED: the Implementer cannot review its own candidate.");
    if (selection.permissions.write !== "deny") throw new Error(`REVIEW_AUTHORITY_REQUIRED: Reviewer '${name}' must have denied source-write authority.`);
    const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
    const capabilityIssues = validateExecutionCapabilities(selection, transport);
    if (capabilityIssues.length) throw new Error(`REVIEW_EXECUTION_INVALID: Reviewer '${name}' is not executable: ${capabilityIssues.join("; ")}`);
    const identityEvidence = await assertCurrentReviewCandidate(root, report.candidate!);
    checks.push(candidateIdentityCheck(`candidate.workspace-identity.reviewer-${round}-${name}`, identityEvidence));
    return runReviewer(root, config, contract, selection, name, report, assuranceByIdentity.get(name)?.dimensions ?? [], prepareReviewWorkspace);
  }));
  const afterReviewerIdentity = await assertCurrentReviewCandidate(root, report.candidate);
  checks.push(candidateIdentityCheck(`candidate.workspace-identity.after-review-${round}`, afterReviewerIdentity));
  const rawFindings: NormalizedFinding[] = [];
  for (const output of outputs) {
    sessions.push(output.session);
    rawFindings.push(...output.findings.map((finding) => ({ ...finding, id: `${output.reviewer}:${finding.id}` })));
    const assignment = assuranceByIdentity.get(output.reviewer);
    if (assignment) {
      const identityMatches = output.session.logicalAgent === assignment.reviewerIdentity;
      const evidenceValid = output.valid && identityMatches;
      checks.push({
        id: `candidate.assurance.reviewer.${round}.${output.reviewer}`,
        category: "candidate-assurance",
        status: evidenceValid ? "PASS" : "FAIL",
        message: evidenceValid ? `Configured independent Reviewer '${output.reviewer}' returned structured evidence for the assigned impact dimensions.` : `Assigned Reviewer '${output.reviewer}' did not return valid structured evidence from its exact configured identity.`,
        details: { reviewerIdentity: assignment.reviewerIdentity, observedReviewerIdentity: output.session.logicalAgent, provider: assignment.provider, actualProvider: output.session.provider, dimensions: assignment.dimensions, candidate: assignment.candidate, impactDigest: assignment.impactDigest, policyDigest: assignment.policyDigest, sessionId: output.session.id }
      });
    }
  }

  let deduped: DedupedFindings;
  const operationId = currentOperationContext().id;
  if (operationId) {
    const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
    const sourceArtifacts = outputs.map((output) => output.session.id ? operation.participants[output.session.id]?.resultArtifact : undefined).filter((value): value is string => Boolean(value));
    const consolidation = await consolidateWithOperationSupervisor(root, config, contract, supervisorSelection, {
      key: `review-round-${round}`,
      purpose: `quality review round ${round}`,
      findings: rawFindings,
      sourceArtifacts,
      deterministicEvidence: report
    });
    sessions.push(consolidation.session);
    deduped = dedupeFindings(consolidation.output.consolidatedFindings);
    await maybeRotateOperationSupervisor(root, config, contract, supervisorSelection);
  } else {
    deduped = dedupeFindings(rawFindings);
  }
  const afterConsolidationIdentity = await assertCurrentReviewCandidate(root, report.candidate);
  checks.push(candidateIdentityCheck(`candidate.workspace-identity.after-review-consolidation-${round}`, afterConsolidationIdentity));
  await persistFindings(stateRoot, config, contract.task.id, round, deduped);
  return deduped;
}

async function assertCurrentReviewCandidate(root: string, candidate: CandidateRevisionV1): Promise<CandidateWorkspaceIdentityEvidenceV1> {
  const operationId = currentOperationContext().id;
  if (!operationId) return assertWorkspaceMatchesCandidate(root, candidate);
  const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
  return assertWorkspaceMatchesCandidate(root, candidate, operation.candidateRevision ?? null);
}

async function runReviewer(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, name: string, report: ValidationReport, assignedDimensions: readonly string[], prepareReviewWorkspace?: (isolatedRoot: string) => Promise<void>): Promise<{ reviewer: string; session: WorkerSession; findings: NormalizedFinding[]; valid: boolean }> {
  if (!selection) throw new Error(`REVIEW_EXECUTION_INVALID: no frozen selection exists for reviewer '${name}'.`);
  const candidate = report.candidate;
  if (!candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
  const isolated = await executeIsolatedCandidateMutation({
    root,
    operationId: candidate.operationId,
    taskId: contract.task.id,
    workUnitId: `review:${contract.task.id}:${name}:${candidate.revision}`,
    candidate,
    config,
    contract,
    prepareWorkspace: prepareReviewWorkspace,
    execute: (isolatedRoot) => executeAgentPrompt(isolatedRoot, config, contract, selection, buildReviewerPrompt(contract, name, report, assignedDimensions), { outputContract: "reviewer", phase: "review", operationKind: currentOperationContext().kind, requireExecutionAuthority: true })
  });
  const session = isolated.session;
  if (isolated.changeSet) {
    return { reviewer: name, session, findings: [syntheticFinding(name, "Reviewer attempted to modify its isolated candidate snapshot; the output was rejected.")], valid: false };
  }
  if (session.exitCode !== 0) return { reviewer: name, session, findings: [syntheticFinding(name, `Reviewer runtime exited with code ${session.exitCode}.`)], valid: false };
  try {
    const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    if (output.verdict === "FAIL" && output.findings.length === 0) return { reviewer: name, session, findings: [syntheticFinding(name, "Reviewer returned FAIL without a structured finding.")], valid: false };
    return { reviewer: name, session, findings: output.findings, valid: true };
  } catch (error) {
    return { reviewer: name, session, findings: [syntheticFinding(name, `Invalid reviewer output contract: ${String(error)}`)], valid: false };
  }
}

function candidateIdentityCheck(id: string, evidence: CandidateWorkspaceIdentityEvidenceV1): ValidationCheck {
  return {
    id,
    category: "candidate-identity",
    status: "PASS",
    message: `Workspace digest matches CandidateRevision ${evidence.candidateId} r${evidence.candidateRevision}.`,
    details: { ...evidence }
  };
}

function mergeReviewCheck(report: ValidationReport, check: ValidationCheck): ValidationReport {
  const byId = new Map(report.checks.map((existing) => [existing.id, existing]));
  byId.set(check.id, check);
  const checks = [...byId.values()];
  return { ...report, checks, status: checks.some((item) => item.status === "FAIL") ? "FAIL" : "PASS" };
}

async function runDiagnosis(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, state: QualityState, findings: DedupedFindings, sessions: WorkerSession[]): Promise<ExceptionDecision | undefined> {
  const session = await executeAgentPrompt(root, config, contract, selection, buildDiagnosisPrompt(contract, state, findings), { phase: "diagnosis", operationKind: currentOperationContext().kind, requireExecutionAuthority: true });
  sessions.push(session);
  const external = detectRuntimeExternalException(session);
  if (external) return external;
  if (session.exitCode !== 0) return undefined;
  try { return diagnosisToException(exceptionDiagnosisSchema.parse(extractMarkedJson(session.stdout, session.stderr))); }
  catch { return undefined; }
}

async function runAutonomousReplan(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, state: QualityState, findings: DedupedFindings, sessions: WorkerSession[]): Promise<{ plan?: PlannerOutput; exception?: ExceptionDecision }> {
  const session = await executeAgentPrompt(root, config, contract, selection, buildReplanPrompt(contract, state, findings), { outputContract: "planner", phase: "replanning", operationKind: currentOperationContext().kind, requireExecutionAuthority: true });
  sessions.push(session);
  const external = detectRuntimeExternalException(session);
  if (external) return { exception: external };
  if (session.exitCode !== 0) return {};
  try { return { plan: plannerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr)) }; }
  catch { return {}; }
}

async function runLeadAcceptance(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, report: ValidationReport, findings: DedupedFindings, sessions: WorkerSession[]): Promise<{ accepted: boolean; agent: string; summary?: string; unresolved: string[]; contractFailure?: string; externalException?: ExceptionDecision }> {
  if (!selection) return { accepted: false, agent: "<missing>", unresolved: [], contractFailure: "Lead acceptance is enabled but no frozen Lead/Director selection is available." };
  const session = await executeAgentPrompt(root, config, contract, selection, buildLeadPrompt(contract, report, findings), { phase: "lead-acceptance", requireExecutionAuthority: true });
  sessions.push(session);
  const externalException = detectRuntimeExternalException(session);
  if (externalException) return { accepted: false, agent: selection.logicalAgent, unresolved: [], externalException };
  try {
    const parsed = orchestratorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    const accepted = session.exitCode === 0 && parsed.finalizationSafe === true && parsed.unresolved.length === 0;
    return { accepted, agent: selection.logicalAgent, summary: parsed.summary, unresolved: parsed.unresolved.length ? parsed.unresolved : accepted ? [] : [parsed.summary || "Lead did not declare finalization safe."] };
  } catch (error) {
    return { accepted: false, agent: selection.logicalAgent, unresolved: [], contractFailure: `Lead output contract was invalid: ${String(error)}` };
  }
}

function buildReviewerPrompt(contract: TaskContract, reviewer: string, report: ValidationReport, assignedDimensions: readonly string[] = []): string {
  const assignment = assignedDimensions.length ? ` Your frozen independent review assignment covers these impact dimensions: ${assignedDimensions.join(", ")}. Inspect each assigned dimension against the assembled candidate.` : "";
  return `You are reviewer ${reviewer} for ${contract.task.id}. Inspect the actual git diff from ${contract.git?.baseRef ?? "main"}, relevant source/tests, and the sealed task contract. Do not modify files. Deterministic validation currently reports ${report.status}.${assignment} Return findings with requiredCompetencies and reviewDimensions; never select a concrete agent or reviewer. Use exceptionType only when the issue cannot be resolved from the sealed requirements/repository without an external human decision or resource. Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object.`;
}
function buildRemediationPrompt(contract: TaskContract, stage: ReviewEscalationStage, state: QualityState, findings: NormalizedFinding[], replan?: PlannerOutput): string {
  return `Autonomously remediate review debt for ${contract.task.id}. Stage=${stage.name}. Current DebtScore=${formatDebtScore(state.debtScore)}; final gate requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3. Three notes equal one low. Do not change sealed contracts/specs/acceptance. Critical/high/medium findings are mandatory. Resolve low/note findings as needed to reach the final debt budget without broadening scope or creating regressions. ${replan ? `A stronger planner produced this advisory remediation plan (it does not override the sealed contract):\n${JSON.stringify(replan, null, 2)}\n` : ""}Findings:\n${JSON.stringify(findings, null, 2)}\nMake the smallest coherent changes and run focused checks. Do not ask the user unless a sealed requirement is contradictory, a product decision is genuinely missing, or an external credential/permission is required.`;
}
function buildDiagnosisPrompt(contract: TaskContract, state: QualityState, findings: DedupedFindings): string {
  return `Diagnose why quality remediation for ${contract.task.id} is not converging. Current convergence=${state.convergence}, DebtScore=${formatDebtScore(state.debtScore)}. Inspect the sealed contract/spec, actual diff, tests and findings. Classify ONLY as IMPLEMENTATION_DEFECT, SPEC_CONTRADICTION, REQUIRES_PRODUCT_DECISION, BLOCKED_EXTERNAL, or SYSTEM_FAILURE. Prefer IMPLEMENTATION_DEFECT when the repository/spec already determines the answer. Human intervention is justified only for true contradictions, missing product decisions, or unavailable external credentials/permissions. Return {"classification":"...","rationale":"...","recommendedAction":"..."}. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildReplanPrompt(contract: TaskContract, state: QualityState, findings: DedupedFindings): string {
  return `Create a new implementation WorkGraph for ${contract.task.id} because remediation is ${state.convergence}. The sealed TaskContract/spec is immutable and authoritative; replan implementation only. Current DebtScore=${formatDebtScore(state.debtScore)}. Return workUnits[{id,objective,scope,dependencies,requirementRefs,acceptanceRefs,competencies,riskTags,changeKinds,risk}], reviewDimensions, typed validationRequirements and outOfScopeImprovements. Never select a concrete agent, reviewer, validator, tool or command. Final line: AEH_RESULT_JSON=<json>. Findings=${JSON.stringify(findings.findings)}`;
}
function buildLeadPrompt(contract: TaskContract, report: ValidationReport, findings: DedupedFindings): string {
  return `You are the lead engineer performing final semantic acceptance for ${contract.task.id}. The deterministic report and Final Quality Gate have passed. Inspect the actual final diff, sealed requirements and reviewer evidence. Do not modify files. Deterministic status=${report.status}. Remaining findings=${JSON.stringify(findings.findings)}. Return {"summary":"...","delegatedAgents":[],"validationStatus":"${report.status}","unresolved":[],"finalizationSafe":true|false}. If something is unresolved, state it concretely; the Harness will attempt autonomous replanning/remediation rather than immediately asking the user. Final line: AEH_RESULT_JSON=<json>.`;
}

function syntheticFinding(agent: string, evidence: string): NormalizedFinding {
  return { id: `REVIEW-${agent}-${Date.now()}`, severity: "critical", category: "review-contract", location: { file: "<review-output>" }, evidence, impact: "The review cannot be trusted as valid evidence.", recommendedFix: "Repair or rerun the reviewer output contract.", requiredCompetencies: ["review-contract"], reviewDimensions: ["evidence-integrity"], exceptionType: "SYSTEM_FAILURE" };
}
function leadFinding(index: number, text: string, agent: string): NormalizedFinding {
  return { id: `LEAD-${index + 1}`, severity: "medium", category: "lead-unresolved", location: { file: "<lead-acceptance>" }, evidence: text, impact: "Lead semantic acceptance is not yet safe.", recommendedFix: "Replan and remediate the unresolved semantic concern without changing sealed requirements.", requiredCompetencies: ["semantic-acceptance"], reviewDimensions: ["requirements"], exceptionType: "IMPLEMENTATION_DEFECT" };
}
function emptyFindings(): DedupedFindings { return { inputCount: 0, outputCount: 0, findings: [], merges: [] }; }
async function persistFindings(root: string, config: HarnessProjectConfig, taskId: string, round: number, findings: DedupedFindings): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-round-${round}.json`), `${JSON.stringify(findings, null, 2)}\n`); }
async function persistQualityState(root: string, config: HarnessProjectConfig, taskId: string, state: QualityState): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-quality-${state.round}.json`), `${JSON.stringify(state, null, 2)}\n`); }
async function persistRejectedState(root: string, config: HarnessProjectConfig, taskId: string, state: QualityState, stage: string, restored: string[]): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-rejected-${Date.now()}.json`), `${JSON.stringify({ stage, state, restored }, null, 2)}\n`); }
async function persistReplan(root: string, config: HarnessProjectConfig, taskId: string, round: number, plan: PlannerOutput): Promise<void> { const dir = path.resolve(root, config.agents?.findingsDir ?? ".harness/findings"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${taskId}-replan-${round}.json`), `${JSON.stringify(plan, null, 2)}\n`); }
function humanExceptionResult(exception: ExceptionDecision, rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[]): ReviewLifecycleResult { const nextChecks = [...checks, { id: "agent.human-on-exception", category: "agent-review", status: "FAIL" as const, message: `${exception.type}: ${exception.rationale}`, details: { exception } }]; return { status: "FAIL", finalState: exception.type, humanRequired: true, rounds, report, findings, checks: nextChecks, sessions, qualityHistory, exception }; }
function successResult(rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[], leadAccepted?: boolean): ReviewLifecycleResult { return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted }; }
function emptyResult(report: ValidationReport, checks: ValidationCheck[], sessions: WorkerSession[]): ReviewLifecycleResult { const gate = evaluateFinalQualityGate([], { version: 1, project: { name: "disabled" } }); const state: QualityState = { round: 0, counts: gate.counts, debtPoints: gate.debtPoints, debtScore: gate.debtScore, fingerprint: "", findingFingerprints: [], resolved: [], persistent: [], introduced: [], convergence: "CONVERGED", gate }; return { status: "PASS", finalState: "ACCEPTED", humanRequired: false, rounds: 0, report, findings: emptyFindings(), checks, sessions, qualityHistory: [state] }; }
