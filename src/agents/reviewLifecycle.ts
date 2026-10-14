import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedRoute } from "./types.js";
import { matchesValues, requiredReviewSpecializationsForRoute } from "./routing.js";
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
import { applyAnchoredCoveringGrantForBlocker, repairScopeBlockerValidationCheck } from "../candidates/repairScope.js";
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

/**
 * A reviewer turn that did not produce reviewable evidence: the provider session stopped on an
 * approval/permission prompt, the runtime exited non-zero, the reviewer attempted a mutation, or
 * its structured output contract was invalid. None of these can be repaired by changing the
 * implementation, so they must terminalize as a typed SYSTEM_FAILURE instead of entering the
 * autonomous remediation loop as synthetic critical findings (AEH-V2-0119).
 */
export interface ReviewerRoundFailureV1 {
  reviewer: string;
  kind: "RUNTIME" | "CONTRACT" | "MUTATION" | "TURN_DEADLINE" | "PERMISSION_WAIT";
  detail: string;
  sessionId?: string;
  exitCode?: number;
}

export interface ReviewRoundResult {
  findings: DedupedFindings;
  failures: ReviewerRoundFailureV1[];
}

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

export async function runReviewLifecycle(input: { root: string; stateRoot?: string; config: HarnessProjectConfig; contract: TaskContract; route: ResolvedRoute; reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>; leadSelection?: AgentExecutionSelection; repairerSelection?: AgentExecutionSelection; executionCatalog?: ExecutionCatalogV1; prepareRepairWorkspace?: (isolatedRoot: string) => Promise<void>; stageSelections?: Readonly<Record<string, AgentExecutionSelection | undefined>>; supervisorSelection?: AgentExecutionSelection; implementationSelection: AgentExecutionSelection; report: ValidationReport; candidateImpact?: CandidateImpactV1; candidateImpactAssessment?: CandidateImpactAssessmentRuntimeV1; candidateAssurance?: CandidateAssuranceCompilationV1; assuranceGateCheck?: ValidationCheck; recompileCandidateAssurance?: (impact: CandidateImpactV1 | undefined, report: ValidationReport) => Promise<{ compilation?: CandidateAssuranceCompilationV1; validationChecks: ValidationCheck[]; gateCheck: ValidationCheck }>; revalidate: () => Promise<ValidationReport>; onAmendedContract?: (contract: TaskContract) => void; }): Promise<ReviewLifecycleResult> {
  const { root, config, route, reviewerSelections, leadSelection, repairerSelection, executionCatalog, prepareRepairWorkspace, stageSelections, supervisorSelection, implementationSelection, onAmendedContract } = input;
  // H-NEW-14: mutable so a consult-only honored owner grant can adopt the
  // amended contract for the single bounded remediation retry below.
  let contract = input.contract;
  const stateRoot = input.stateRoot ?? root;
  let report = input.report;
  const sessions: WorkerSession[] = [];
  const checks: ValidationCheck[] = [];
  const qualityHistory: QualityState[] = [];
  const policy = config.workflow?.reviews;
  let candidateImpact = input.candidateImpact;
  let candidateAssurance = input.candidateAssurance;
  let assuranceGateCheck = input.assuranceGateCheck;
  // Defense in depth (independent-review boundary caveat): a BLOCKED
  // compilation must never produce review turns, even if this lifecycle is
  // invoked directly with a passing report and non-empty assignments. The
  // sole production caller guards on a PASS report, but the lifecycle itself
  // refuses blocked assurance first, before any candidate check or session.
  // MECHANISM: DETERMINISTIC.
  if (candidateAssurance?.status === "BLOCKED") {
    throw new Error(`REVIEW_ASSURANCE_BLOCKED: candidate assurance is BLOCKED (${candidateAssurance.blockers.join("; ") || "no blockers recorded"}); review turns require a READY compilation with satisfied specialization coverage.`);
  }
  const requiredAssignments = candidateAssurance?.reviewAssignments ?? [];
  if (policy?.enabled === false && requiredAssignments.length === 0) return emptyResult(report, checks, sessions);

  if (!report.candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: review requires a candidate-bound validation report.");
  checks.push(candidateIdentityCheck("candidate.workspace-identity.review-entry", await assertCurrentReviewCandidate(root, report.candidate)));
  if (assuranceGateCheck) checks.push(assuranceGateCheck);

  const isDirect = contract.routing?.route === "DIRECT";
  const runReviewers = requiredAssignments.length > 0 || !isDirect || policy?.directReview === true;
  // DETERMINISTIC: route review selectors → review turn (thread the requirement,
  // minimal — no routing redesign). The frozen route's required specialization
  // (e.g. high-assurance) is verified against every assurance-assigned reviewer
  // inside runReviewRound (fail closed, no silent substitution).
  const requiredReviewSpecializations = requiredReviewSpecializationsForRoute(route);
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
    const withValidationChecks = mergeChecksById(candidateReport, evaluation.validationChecks);
    return mergeReviewCheck(withValidationChecks, evaluation.gateCheck);
  };
  const stages = escalationStages(config);
  let stageIndex = 0;
  let remediationRounds = 0;
  let replanContext: PlannerOutput | undefined;
  let deduped = emptyFindings();
  if (reviewerNames.length) {
    const initialRound = await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, report, sessions, 0, checks, prepareRepairWorkspace, reviewerAssignments, requiredReviewSpecializations);
    if (initialRound.failures.length) return await reviewerProviderFailureResult(stateRoot, config, contract, initialRound.failures, remediationRounds, report, initialRound.findings, checks, sessions, qualityHistory);
    deduped = initialRound.findings;
  }
  let state = analyzeQualityState(deduped.findings, qualityHistory, config, report.candidate?.identityDigest);
  qualityHistory.push(state);
  await persistQualityState(stateRoot, config, contract.task.id, state);

  while (true) {
    const exception = detectHumanException(deduped.findings);
    if (exception?.humanRequired) return humanExceptionResult(exception, remediationRounds, report, deduped, checks, sessions, qualityHistory);
    // A SYSTEM_FAILURE finding (reviewer/runtime contract failure or an explicit model
    // classification) is a terminal system failure, never remediable implementation debt.
    if (exception) return await systemFailureResult(stateRoot, config, contract, `Review system failure (${exception.type}): ${exception.rationale}`, remediationRounds, report, deduped, checks, sessions, qualityHistory);

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

    // Deterministic execution budget: an autonomous remediation loop that repeatedly fails to reach
    // the Final Quality Gate must terminalize instead of running forever (AEH-V2-0119). A reviewer
    // provider stop surfaces as a synthetic critical finding, so without this bound a participant
    // runtime failure could remediate indefinitely without changing anything.
    if (remediationBudgetReached(remediationRounds, config)) {
      const budget = remediationBudgetRounds(config);
      const message = `Remediation budget of ${budget} round(s) is exhausted without satisfying the Final Quality Gate: ${state.gate.reasons.join("; ")}.`;
      checks.push({ id: "agent.remediation-budget", category: "agent-review", status: "FAIL", message, details: { round: remediationRounds, budget, state } });
      await recordEvent(stateRoot, config, "harness.quality.remediation-budget-exhausted", { taskId: contract.task.id, round: remediationRounds, budget, convergence: state.convergence, debtPoints: state.debtPoints });
      return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds: remediationRounds, report, findings: deduped, checks, sessions, qualityHistory, leadAccepted: false };
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
    const repairPrompt = `${buildRemediationPrompt(contract, stage, state, deduped.findings, replanContext)}\n\nYou are the canonical Repairer. Change implementation only within the frozen task scope. Do not change requirements, acceptance, validators, policy, or review outcomes. You cannot approve or accept the candidate. Out-of-scope blocker path (report, don't expand): if the fix needs files outside scope, return no changes and declare them via AEH_RESULT_JSON filesNeededOutsideScope[{path, reason}].`;
    let mutation = await executeRepairerCandidateMutation({
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
      execute: (isolatedRoot, participantId, prompt) => executeAgentPrompt(isolatedRoot, config, contract, remediationSelection, prompt, { outputContract: remediationSelection.outputContract ?? "implementer", phase: "repair", operationKind: currentOperationContext().kind, participantId, requireExecutionAuthority: true })
    });
    let remediation = mutation.session;
    sessions.push(remediation);
    // Review-remediation scopeBlocker: the bounded ledger-gated amendment
    // (suspend + approve/deny product choice + reseal, max 1/task) stays owned
    // solely by the run.ts validation-repair loop — this path NEVER suspends
    // (no dual suspensions, no budget overruns, no stage confusion). H-NEW-14
    // grant-consumption coverage (consult-only honor, never grant-creation):
    // an already-anchored covering owner grant is applied/reused here via the
    // amendment/apply path with exactly one bounded remediation retry; with
    // no covering grant this path still propagates BLOCKED fail-closed citing
    // the exact blocker (no amendment, no silent ignore) so the canonical
    // channel remains the sole suspension writer.
    if (mutation.scopeBlocker) {
      let honored: Awaited<ReturnType<typeof applyAnchoredCoveringGrantForBlocker>> | undefined;
      try {
        honored = await applyAnchoredCoveringGrantForBlocker({
          root,
          controlRoot: stateRoot,
          config,
          contract,
          blocker: mutation.scopeBlocker,
        });
      } catch {
        honored = undefined;
      }
      if (honored?.status === "AMENDED") {
        contract = honored.contract;
        onAmendedContract?.(honored.contract);
        await recordEvent(stateRoot, config, "harness.quality.repair-scope-amended", {
          taskId: contract.task.id,
          round: remediationRounds,
          blockerDigest: mutation.scopeBlocker.digest,
          exemptedPaths: honored.amendment.exemptedPaths,
          decisionId: honored.amendment.decisionId,
          requestId: honored.amendment.requestId,
          decidedActor: honored.amendment.decidedActor,
          reused: honored.reused,
        }).catch(() => undefined);
        const retryPrompt = `${buildRemediationPrompt(contract, stage, state, deduped.findings, replanContext)}\n\nYou are the canonical Repairer. Change implementation only within the frozen task scope. Do not change requirements, acceptance, validators, policy, or review outcomes. You cannot approve or accept the candidate. Out-of-scope blocker path (report, don't expand): if the fix needs files outside scope, return no changes and declare them via AEH_RESULT_JSON filesNeededOutsideScope[{path, reason}].`;
        mutation = await executeRepairerCandidateMutation({
          root,
          stateRoot,
          operationId,
          taskId: contract.task.id,
          workUnitId: `quality-repair:${contract.task.id}:${remediationRounds}:scope-amended-retry`,
          phase: "review-remediation",
          config,
          contract,
          selection: remediationSelection,
          executionCatalog,
          allowedScope: contract.scope?.allowed ?? ["**"],
          forbiddenScope: [...(contract.scope?.forbidden ?? []), ...(contract.scope?.frozen ?? []), ...(config.validation?.frozenPaths ?? [])],
          prompt: retryPrompt,
          prepareWorkspace: prepareRepairWorkspace,
          semanticAssessment: input.candidateImpactAssessment,
          scopeAmendment: honored.amendment,
          execute: (isolatedRoot, participantId, prompt) => executeAgentPrompt(isolatedRoot, config, contract, remediationSelection, prompt, { outputContract: remediationSelection.outputContract ?? "implementer", phase: "repair", operationKind: currentOperationContext().kind, participantId, requireExecutionAuthority: true })
        });
        remediation = mutation.session;
        sessions.push(remediation);
      }
      if (mutation.scopeBlocker) {
        const blockerCheck = repairScopeBlockerValidationCheck(mutation.scopeBlocker);
        checks.push(blockerCheck);
        await recordEvent(stateRoot, config, "harness.quality.repair-scope-blocked", {
          taskId: contract.task.id,
          round: remediationRounds,
          blockerDigest: mutation.scopeBlocker.digest,
          filesNeededOutsideScope: mutation.scopeBlocker.filesNeededOutsideScope,
        }).catch(() => undefined);
        return {
          status: "FAIL",
          finalState: "REQUIRES_PRODUCT_DECISION",
          humanRequired: true,
          rounds: remediationRounds,
          report,
          findings: deduped,
          checks,
          sessions,
          qualityHistory,
          leadAccepted: false,
        };
      }
    }
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

    const candidateRound = reviewerNames.length
      ? await runReviewRound(root, stateRoot, config, contract, reviewerSelections, implementationSelection, supervisorSelection, reviewerNames, candidateReport, sessions, qualityHistory.length, checks, prepareRepairWorkspace, reviewerAssignments, requiredReviewSpecializations)
      : { findings: emptyFindings(), failures: [] };
    if (candidateRound.failures.length) return await reviewerProviderFailureResult(stateRoot, config, contract, candidateRound.failures, remediationRounds, candidateReport, candidateRound.findings, checks, sessions, qualityHistory);
    const candidateFindings = candidateRound.findings;
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

/** Bounded autonomous remediation budget (deterministic execution policy, AEH-V2-0119). */
export function remediationBudgetRounds(config: HarnessProjectConfig): number {
  return config.workflow?.reviews?.escalation?.maxRounds ?? 6;
}

export function remediationBudgetReached(rounds: number, config: HarnessProjectConfig): boolean {
  return rounds >= remediationBudgetRounds(config);
}

/**
 * Deterministic reviewer assignment authority. Reviewers are read-only by
 * canonical role definition (canExecute:false, command-execute forbidden);
 * a selection carrying source-write OR shell authority contradicts the
 * Reviewer ceiling (execute exceeds it) and dies mid-review at capability
 * preparation — fail fast here with the assignment reason instead.
 */
export function assertReviewerSelectionAuthority(
  selection: AgentExecutionSelection,
  name: string,
  implementerLogicalAgent: string,
): void {
  if (!selection || selection.role !== "Reviewer") throw new Error(`REVIEW_AUTHORITY_REQUIRED: '${name}' is not a frozen canonical Reviewer selection.`);
  if (selection.logicalAgent === implementerLogicalAgent) throw new Error("REVIEW_INDEPENDENCE_REQUIRED: the Implementer cannot review its own candidate.");
  if (selection.permissions.write !== "deny") throw new Error(`REVIEW_AUTHORITY_REQUIRED: Reviewer '${name}' must have denied source-write authority.`);
  if (selection.permissions.shell === "allow") throw new Error(`REVIEW_AUTHORITY_REQUIRED: Reviewer '${name}' must have denied shell authority (execute exceeds the read-only Reviewer capability ceiling).`);
}

/**
 * DETERMINISTIC route-required specialization authority for the assurance path.
 * When the frozen route requires a reviewer specialization (e.g. high-assurance),
 * the assigned reviewer must hold it — verified against the frozen selection's
 * attested specializations with the shared routing matcher. Fail closed with no
 * silent substitution and no fallback to an ordinary reviewer. An empty
 * requirement keeps current behavior. Model reasoning never calls this.
 */
export function assertReviewerSpecializationAuthority(
  selection: AgentExecutionSelection,
  requiredSpecializations: readonly string[],
  name: string,
): void {
  const required = [...new Set(requiredSpecializations ?? [])].sort();
  if (!required.length) return;
  if (!selection) throw new Error(`REVIEW_SPECIALIZATION_REQUIRED: no frozen selection exists for reviewer '${name}' (required specialization(s): ${required.join(",")}).`);
  const have = [...(selection.specializations ?? [])];
  if (!matchesValues(have, [...required])) {
    throw new Error(`REVIEW_SPECIALIZATION_REQUIRED: Assigned Reviewer '${name}' does not satisfy required specialization(s) ${required.join(",")} (has: ${have.join(",") || "<none>"}). No silent substitution to an ordinary reviewer is allowed.`);
  }
}

/**
 * DETERMINISTIC collective specialization coverage for the assurance path.
 * When the frozen route requires reviewer specialization(s), the ROUND's
 * reviewer set must collectively cover EVERY required specialization (union of
 * satisfiedSpecializations across the round's reviewers). Per-reviewer
 * ANY-match checks alone admit a one-reviewer partial assignment for a
 * multi-specialization route (e.g. [high-assurance, typescript-node]) with the
 * other spec silently uncovered. Fail closed naming the uncovered specs with
 * no silent under-review. Empty requirement or empty assignment set keeps
 * current behavior (the assurance BLOCKED gate owns the empty case).
 * Model reasoning never calls this. Mechanism: DETERMINISTIC.
 */
export function assertReviewerSetSpecializationCoverage(
  assignments: readonly CandidateAssuranceReviewAssignmentV1[],
  requiredSpecializations: readonly string[],
): void {
  const required = [...new Set(requiredSpecializations ?? [])].sort();
  if (!required.length) return;
  if (!assignments.length) return;
  const uncovered = required.filter((spec) => !assignments.some((assignment) => matchesValues([...(assignment.satisfiedSpecializations ?? [])], [spec])));
  if (uncovered.length) {
    const covered = required.filter((spec) => !uncovered.includes(spec));
    throw new Error(`REVIEW_SPECIALIZATION_REQUIRED: Reviewer round does not collectively cover required specialization(s) ${required.join(",")} (uncovered: ${uncovered.join(",")}; covered: ${covered.join(",") || "<none>"}; ${assignments.length} assigned reviewer(s)). No silent under-review is allowed.`);
  }
}

async function runReviewRound(root: string, stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>, implementationSelection: AgentExecutionSelection, supervisorSelection: AgentExecutionSelection | undefined, reviewerNames: string[], report: ValidationReport, sessions: WorkerSession[], round: number, checks: ValidationCheck[], prepareReviewWorkspace?: (isolatedRoot: string) => Promise<void>, assuranceAssignments: readonly CandidateAssuranceReviewAssignmentV1[] = [], requiredReviewSpecializations: readonly string[] = []): Promise<ReviewRoundResult> {
  if (!report.candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
  const assuranceByIdentity = new Map(assuranceAssignments.map((assignment) => [assignment.reviewerIdentity, assignment]));
  // DETERMINISTIC collective coverage gate: the round's assigned reviewer SET
  // must cover every required specialization (union of satisfiedSpecializations).
  // Runs before any reviewer invocation so an under-covered round fails closed
  // without consuming provider turns. Per-reviewer checks below are retained.
  assertReviewerSetSpecializationCoverage(
    reviewerNames.map((name) => assuranceByIdentity.get(name)).filter((assignment): assignment is CandidateAssuranceReviewAssignmentV1 => Boolean(assignment)),
    requiredReviewSpecializations,
  );
  const outputs = await Promise.all(reviewerNames.map(async (name) => {
    const selection = reviewerSelections[name];
    assertReviewerSelectionAuthority(selection, name, implementationSelection.logicalAgent);
    // DETERMINISTIC assurance-path specialization gate: an assigned reviewer
    // must satisfy both the assignment-recorded satisfied specialization and
    // the frozen route requirement (fail closed, never substitute ordinary).
    const assignment = assuranceByIdentity.get(name);
    if (assignment) {
      assertReviewerSpecializationAuthority(selection, assignment.satisfiedSpecializations ?? [], name);
      assertReviewerSpecializationAuthority(selection, requiredReviewSpecializations, name);
    }
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
  const failures: ReviewerRoundFailureV1[] = [];
  for (const output of outputs) {
    sessions.push(output.session);
    rawFindings.push(...output.findings.map((finding) => ({ ...finding, id: `${output.reviewer}:${finding.id}` })));
    if (output.failure) failures.push(output.failure);
    const assignment = assuranceByIdentity.get(output.reviewer);
    if (assignment) {
      const identityMatches = output.session.logicalAgent === assignment.reviewerIdentity;
      const evidenceValid = output.valid && identityMatches;
      replaceSupersededReviewerChecksV1(checks, round, output.reviewer, {
        id: `candidate.assurance.reviewer.${round}.${output.reviewer}`,
        category: "candidate-assurance",
        status: evidenceValid ? "PASS" : "FAIL",
        message: evidenceValid ? `Configured independent Reviewer '${output.reviewer}' returned structured evidence for the assigned impact dimensions.` : `Assigned Reviewer '${output.reviewer}' did not return valid structured evidence from its exact configured identity.`,
        details: { reviewerIdentity: assignment.reviewerIdentity, observedReviewerIdentity: output.session.logicalAgent, provider: assignment.provider, actualProvider: output.session.provider, dimensions: assignment.dimensions, candidate: assignment.candidate, impactDigest: assignment.impactDigest, policyDigest: assignment.policyDigest, sessionId: output.session.id }
      });
    }
  }
  // A failed reviewer turn is terminal system evidence, not a finding to consolidate or remediate.
  // Short-circuit before the supervisor turn so a model cannot reclassify a provider stop into debt.
  if (failures.length) return { findings: dedupeFindings(rawFindings), failures };

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
  return { findings: deduped, failures: [] };
}

async function assertCurrentReviewCandidate(root: string, candidate: CandidateRevisionV1): Promise<CandidateWorkspaceIdentityEvidenceV1> {
  const operationId = currentOperationContext().id;
  if (!operationId) return assertWorkspaceMatchesCandidate(root, candidate);
  const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
  return assertWorkspaceMatchesCandidate(root, candidate, operation.candidateRevision ?? null);
}

async function runReviewer(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, name: string, report: ValidationReport, assignedDimensions: readonly string[], prepareReviewWorkspace?: (isolatedRoot: string) => Promise<void>): Promise<{ reviewer: string; session: WorkerSession; findings: NormalizedFinding[]; valid: boolean; failure?: ReviewerRoundFailureV1 }> {
  if (!selection) throw new Error(`REVIEW_EXECUTION_INVALID: no frozen selection exists for reviewer '${name}'.`);
  const candidate = report.candidate;
  if (!candidate) throw new Error("CANDIDATE_BINDING_REQUIRED: reviewer invocation requires a candidate-bound report.");
  // DETERMINISTIC: reviewer turns run under the short reviewer deadline
  // (default 15 min), not the 30-min participant default or the 8h fuse.
  // Local readers (not via the mocked agentPrompt module) keep unit mocks
  // that stub executeAgentPrompt working.
  const reviewerDeadlineMs = reviewerTurnDeadlineForConfig(config);
  const permissionTimeoutMs = permissionWaitTimeoutForConfig(config);
  const startedAt = Date.now();
  // DETERMINISTIC approval-wait gate on ACTUAL pending-prompt state: the
  // reviewer call carries the 15-min reviewer deadline, which is the ONLY
  // wall-clock bound on an active turn. A mid-turn timer must never cut a
  // reviewer turn with no pending approval prompt, and a lost Promise.race
  // cannot cancel the provider (executeIsolatedCandidateMutation keeps
  // awaiting + cleans up after settle) — so there is no mid-turn interrupt
  // here at all. The PERMISSION_WAIT_TIMEOUT fires only in settled
  // approval-wait state (isReviewerPermissionWaitStop + wait-start evidence
  // from the permission-gate producer) via classifyReviewerTurnOutcome
  // below: fenced session + PERMISSION_WAIT_EXHAUSTED, BLOCKED fail-closed,
  // rotation-friendly. Mechanism: DETERMINISTIC.
  const reviewerRun = executeIsolatedCandidateMutation({
    root,
    operationId: candidate.operationId,
    taskId: contract.task.id,
    workUnitId: `review:${contract.task.id}:${name}:${candidate.revision}`,
    candidate,
    config,
    contract,
    prepareWorkspace: prepareReviewWorkspace,
    execute: (isolatedRoot) => executeAgentPrompt(isolatedRoot, config, contract, selection, buildReviewerPrompt(contract, name, report, assignedDimensions), { outputContract: "reviewer", phase: "review", operationKind: currentOperationContext().kind, requireExecutionAuthority: true, providerTurnDeadlineMs: reviewerDeadlineMs })
  });
  // MID-TURN PERMISSION-WAIT WATCH (armed ONLY while a pending prompt holds):
  // the watch fires on elapsed-since-pending-start, never as a blind race on
  // every turn. Live pending observation is owned by the Paseo wait loops
  // (sdk.ts poll loop + native inspect), which stamp the true first-seen
  // pending-start into the diagnostic; this layer exposes no live provider
  // handle, so the watch runs deferred-armed (no live probe yet — clean turns
  // never arm it) and the settled approval-wait gate below stays authoritative:
  // only a turn stopped on a pending prompt (wait-start evidence from the
  // mid-turn capture) can exhaust the short timer. A reviewer turn with no
  // pending prompt never trips this path regardless of elapsed time; only the
  // reviewer deadline applies. A lost race cannot cancel the provider
  // (executeIsolatedCandidateMutation keeps awaiting + cleans up after
  // settle). Mechanism: DETERMINISTIC (watch) + DETERMINISTIC (settled gate).
  const watched = await awaitReviewerRunWithPermissionWatch(reviewerRun, {
    permissionTimeoutMs,
    // No live provider pending signal is exposed at this layer (the SDK wait
    // loops own mid-turn observation): the watch stays disarmed mid-turn and
    // the settled gate below enforces. The armed path is proven in-flight by
    // the liveTurnBounds watchdog tests with an injected pending probe.
    isPending: () => false,
  });
  // The settled session carries the approval-wait gate: only a turn stopped
  // on a pending prompt (permission-gate wait-start evidence) can exhaust
  // the short timer. A reviewer turn with no pending prompt never trips this
  // path regardless of elapsed time; only the reviewer deadline applies.
  const isolated = watched.kind === "settled"
    ? watched.value
    : {
        // Watchdog fired mid-wait while the prompt was still pending: fence
        // the session view and terminalize PERMISSION_WAIT_EXHAUSTED below.
        // The provider run keeps awaiting + cleans up after settle; this
        // settled view is the fenced record, never a mutation of the run.
        session: {
          id: `fenced-permission-wait:${contract.task.id}:${name}`,
          exitCode: 1,
          status: "permission",
          stdout: "",
          stderr: `PERMISSION_WAIT_EXHAUSTED: reviewer '${name}' approval wait exceeded the short timer mid-turn (timeoutMs=${permissionTimeoutMs}, pendingWaitMs=${watched.pendingWaitMs}); fenced BLOCKED fail-closed.`,
          finishedAt: new Date().toISOString(),
          permissionStopDiagnostic: { name: "UNKNOWN", scopeRelation: "UNKNOWN" },
          permissionWaitMs: watched.pendingWaitMs,
        },
      } as unknown as Awaited<typeof reviewerRun>;
  const session = isolated.session;
  const elapsedMs = Date.now() - startedAt;
  // Classify with the APPROVAL-WAIT duration, not the whole turn: provider
  // wait-start evidence wins, whole-turn elapsed is the fail-closed fallback.
  const permissionWaitMs = reviewerPermissionWaitMs(session, elapsedMs);
  const outcome = classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadlineMs, permissionTimeoutMs, permissionWaitMs);
  if (isolated.changeSet) {
    const detail = "Reviewer attempted to modify its isolated candidate snapshot; the output was rejected.";
    return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "MUTATION", detail, sessionId: session.id, exitCode: session.exitCode } };
  }
  // Typed permission-wait terminal: fail-closed BLOCKED, not a 30-min SYSTEM_FAILURE.
  if (outcome === "PERMISSION_WAIT_EXHAUSTED") {
    const detail = `PERMISSION_WAIT_EXHAUSTED: reviewer '${name}' stopped on a Paseo/external permission prompt within the short timer (timeoutMs=${permissionTimeoutMs}, permissionWaitMs=${permissionWaitMs}, elapsedMs=${elapsedMs}); BLOCKED fail-closed, safe to rotate with a narrower scope.`;
    return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "PERMISSION_WAIT", detail, sessionId: session.id, exitCode: session.exitCode } };
  }
  // Typed turn-deadline terminal: steady-output turns die at the reviewer
  // deadline, not at the 8h fuse.
  if (outcome === "TURN_DEADLINE_EXCEEDED") {
    const detail = `TURN_DEADLINE_EXCEEDED: reviewer '${name}' exceeded its wall-clock turn deadline (deadlineMs=${reviewerDeadlineMs}, elapsedMs=${elapsedMs}); steady-output turns die here, not at the operation hard deadline.`;
    return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "TURN_DEADLINE", detail, sessionId: session.id, exitCode: session.exitCode } };
  }
  if (session.exitCode !== 0) {
    const stop = (session.stderr || session.stdout || "no provider output").replace(/\s+/g, " ").trim().slice(0, 600);
    const detail = `Reviewer provider session stopped or exited with code ${session.exitCode}: ${stop}`;
    return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "RUNTIME", detail, sessionId: session.id, exitCode: session.exitCode } };
  }
  try {
    const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    return { reviewer: name, session, findings: output.findings, valid: true };
  } catch (error) {
    const detail = `Invalid reviewer output contract: ${String(error)}`;
    return { reviewer: name, session, findings: [syntheticFinding(name, detail)], valid: false, failure: { reviewer: name, kind: "CONTRACT", detail, sessionId: session.id, exitCode: session.exitCode } };
  }
}

function reviewerProviderFailureResult(stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, failures: readonly ReviewerRoundFailureV1[], rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[]): Promise<ReviewLifecycleResult> {
  const detail = failures.map((failure) => `${failure.reviewer} (${failure.kind}${failure.sessionId ? `, session ${failure.sessionId}` : ""}${failure.exitCode !== undefined ? `, exit ${failure.exitCode}` : ""}): ${failure.detail}`).join(" | ");
  // Fail-closed permission path: typed PERMISSION_WAIT_EXHAUSTED BLOCKED, not post-hoc SYSTEM_FAILURE.
  if (failures.some((failure) => failure.kind === "PERMISSION_WAIT")) {
    return blockedExternalResult(stateRoot, config, contract, `Reviewer permission wait exhausted; this is not remediable implementation debt. ${detail}`, rounds, report, findings, checks, sessions, qualityHistory);
  }
  return systemFailureResult(stateRoot, config, contract, `Reviewer provider turn failed; this is not remediable implementation debt. ${detail}`, rounds, report, findings, checks, sessions, qualityHistory);
}

async function blockedExternalResult(stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, message: string, rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[]): Promise<ReviewLifecycleResult> {
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, 1200);
  checks.push({ id: "agent.permission-wait-exhausted", category: "agent-review", status: "FAIL", message: bounded, details: { round: rounds } });
  qualityHistory.push(analyzeQualityState(findings.findings, qualityHistory, config, report.candidate?.identityDigest));
  await recordEvent(stateRoot, config, "harness.review.permission-wait-exhausted", { taskId: contract.task.id, round: rounds, message: bounded }).catch(() => undefined);
  return { status: "FAIL", finalState: "BLOCKED_EXTERNAL", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted: false };
}

async function systemFailureResult(stateRoot: string, config: HarnessProjectConfig, contract: TaskContract, message: string, rounds: number, report: ValidationReport, findings: DedupedFindings, checks: ValidationCheck[], sessions: WorkerSession[], qualityHistory: QualityState[]): Promise<ReviewLifecycleResult> {
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, 1200);
  checks.push({ id: "agent.system-failure", category: "agent-review", status: "FAIL", message: bounded, details: { round: rounds } });
  // Every returned lifecycle result carries at least one quality state; callers persist the review
  // summary from it and must not crash on a terminal failure path (AEH-V2-0120).
  qualityHistory.push(analyzeQualityState(findings.findings, qualityHistory, config, report.candidate?.identityDigest));
  await recordEvent(stateRoot, config, "harness.review.system-failure", { taskId: contract.task.id, round: rounds, message: bounded }).catch(() => undefined);
  return { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false, rounds, report, findings, checks, sessions, qualityHistory, leadAccepted: false };
}

/**
 * DETERMINISTIC reviewer-turn bound helpers (local so unit mocks that stub
 * the worker module keep working). Defaults match the worker module:
 * reviewer 15 min, permission-wait 5 min. Mechanism: DETERMINISTIC.
 */
export function reviewerTurnDeadlineForConfig(config: HarnessProjectConfig): number {
  const liveness = config.orchestration?.operations?.liveness as { reviewerTurnDeadlineMs?: unknown } | undefined;
  const configured = liveness?.reviewerTurnDeadlineMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(configured) || (configured as number) < 1) throw new Error("REVIEWER_TURN_DEADLINE_INVALID: reviewer-turn deadline must be a positive integer in milliseconds.");
  return configured as number;
}

export function permissionWaitTimeoutForConfig(config: HarnessProjectConfig): number {
  const liveness = config.orchestration?.operations?.liveness as { permissionWaitTimeoutMs?: unknown } | undefined;
  const configured = liveness?.permissionWaitTimeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(configured) || (configured as number) < 1) throw new Error("PERMISSION_WAIT_TIMEOUT_INVALID: permission-wait timeout must be a positive integer in milliseconds.");
  return configured as number;
}

export function isReviewerPermissionWaitStop(session: Pick<WorkerSession, "status" | "permissionStopDiagnostic" | "stderr" | "stdout">): boolean {  const status = (session.status ?? "").toLowerCase();
  if (status === "permission" || status === "waiting") return true;
  if (session.permissionStopDiagnostic) return true;
  return /PERMISSION_WAIT_EXHAUSTED|pending permission|waiting for approval|approval required/i.test(`${(session as { stderr?: unknown }).stderr ?? ""} ${(session as { stdout?: unknown }).stdout ?? ""}`);
}

export function classifyReviewerTurnOutcome(session: Pick<WorkerSession, "exitCode" | "status" | "stderr" | "stdout" | "finishedAt" | "permissionStopDiagnostic">, elapsedMs: number, deadlineMs: number, permissionTimeoutMs: number, permissionWaitMs?: number): "TURN_DEADLINE_EXCEEDED" | "PERMISSION_WAIT_EXHAUSTED" | "OTHER" {
  if (`${(session as { stderr?: unknown }).stderr ?? ""} ${(session as { stdout?: unknown }).stdout ?? ""}`.includes("TURN_DEADLINE_EXCEEDED")) return "TURN_DEADLINE_EXCEEDED";
  // DETERMINISTIC: the wait duration (permission-gate wait-start evidence,
  // else the explicitly-marked whole-turn fallback) decides against the
  // short timer — never the whole turn by default, so a brief late-turn
  // prompt is not misread as exhausted. The isReviewerPermissionWaitStop
  // check gates on ACTUAL pending-prompt state: a turn with no pending
  // prompt can never yield PERMISSION_WAIT_EXHAUSTED here.
  const waitMs = permissionWaitMs ?? reviewerPermissionWaitMs(session, elapsedMs);
  if (isReviewerPermissionWaitStop(session) && waitMs >= permissionTimeoutMs) return "PERMISSION_WAIT_EXHAUSTED";
  const text = `${(session as { stderr?: unknown }).stderr ?? ""} ${(session as { stdout?: unknown }).stdout ?? ""}`;
  const timedOut = (session as { exitCode?: unknown }).exitCode === 124 || ((session as { status?: unknown }).status !== undefined && String((session as { status?: unknown }).status).toLowerCase() === "timeout") || /timed out|timeout/i.test(text);
  if (timedOut && elapsedMs >= deadlineMs) return "TURN_DEADLINE_EXCEEDED";
  return "OTHER";
}

/**
 * DETERMINISTIC approval-wait duration for a settled reviewer turn. Local
 * mirror of the worker helper (kept local so unit mocks that stub the worker
 * module keep working). Precedence: explicit numeric wait evidence, then the
 * permission-gate producer's pending-observed marker
 * (`permissionStopDiagnostic.waitStartedAt`, stamped when the prompt went
 * pending), then the legacy top-level wait-start fields, and only last the
 * whole-turn elapsed fail-closed fallback for sessions with no wait-start
 * evidence at all. Mechanism: DETERMINISTIC.
 */
export function reviewerPermissionWaitMs(session: Pick<WorkerSession, "finishedAt" | "permissionStopDiagnostic">, elapsedMs: number): number {
  return reviewerPermissionWaitEvidence(session, elapsedMs).waitMs;
}

/**
 * DETERMINISTIC wait-evidence source for a settled reviewer turn. Produced
 * sessions (permission-gate diagnostic present) resolve to "evidence"; the
 * whole-turn elapsed applies only when no wait-start evidence exists and is
 * explicitly marked "fallback" so the classifier's fallback path is visible.
 * Mechanism: DETERMINISTIC.
 */
export function reviewerPermissionWaitEvidence(session: Pick<WorkerSession, "finishedAt" | "permissionStopDiagnostic">, elapsedMs: number): { waitMs: number; source: "evidence" | "fallback" } {
  const extended = session as Pick<WorkerSession, "finishedAt" | "permissionStopDiagnostic"> & { permissionWaitMs?: unknown; approvalWaitMs?: unknown; permissionWaitStartedAt?: unknown; approvalWaitStartedAt?: unknown };
  for (const candidate of [extended.permissionWaitMs, extended.approvalWaitMs]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return { waitMs: Math.max(0, candidate), source: "evidence" };
  }
  const gateStartedAt = extended.permissionStopDiagnostic?.waitStartedAt;
  if (typeof gateStartedAt === "string" && Number.isFinite(Date.parse(gateStartedAt))) {
    const endMs = Date.parse(extended.finishedAt ?? "");
    return { waitMs: Math.max(0, (Number.isFinite(endMs) ? endMs : Date.now()) - Date.parse(gateStartedAt)), source: "evidence" };
  }
  for (const candidate of [extended.permissionWaitStartedAt, extended.approvalWaitStartedAt]) {
    const startMs = typeof candidate === "number" ? candidate : Date.parse(String(candidate ?? ""));
    if (Number.isFinite(startMs)) {
      const endMs = Date.parse(extended.finishedAt ?? "");
      return { waitMs: Math.max(0, (Number.isFinite(endMs) ? endMs : Date.now()) - (startMs as number)), source: "evidence" };
    }
  }
  return { waitMs: elapsedMs, source: "fallback" };
}

/**
 * DETERMINISTIC mid-turn permission-wait watchdog. Armed ONLY while a pending
 * approval prompt holds: the watch starts at pending-start (the moment the
 * prompt became pending, observed mid-turn) and fires when
 * elapsed-since-pending-start reaches the short timer. A turn with no pending
 * prompt never arms the watch, so clean turns — however long — are untouched
 * and only the reviewer turn deadline applies. When the watch fires while the
 * prompt is still pending the caller must fence the session and terminalize
 * PERMISSION_WAIT_EXHAUSTED (BLOCKED fail-closed, rotation-friendly). If the
 * prompt clears before the timer, the watch disarms. The pending probe is
 * injected so the in-flight behavior is provable without a live provider.
 * Mechanism: DETERMINISTIC.
 */
export interface ReviewerPermissionWatchConfig {
  permissionTimeoutMs: number;
  /** Live pending-prompt signal, polled mid-wait. */
  isPending: () => boolean;
  /** Externally observed pending-start (epoch ms); when omitted the first poll that reports pending stamps the start. */
  pendingStartedAtMs?: number;
  pollMs?: number;
  now?: () => number;
}

export type ReviewerRunWatchResult<T> =
  | { kind: "settled"; value: T }
  | { kind: "permission-wait-exhausted"; pendingWaitMs: number };

export async function awaitReviewerRunWithPermissionWatch<T>(
  run: Promise<T>,
  config: ReviewerPermissionWatchConfig
): Promise<ReviewerRunWatchResult<T>> {
  const now = config.now ?? Date.now;
  const pollMs = Math.max(1, Math.floor(config.pollMs ?? 25));
  let pendingStartMs = config.pendingStartedAtMs;
  let settled: { value: T } | undefined;
  let settledFlag = false;
  void Promise.resolve(run).then(
    (value) => { settled = { value }; settledFlag = true; },
    () => { settledFlag = true; }
  );
  for (;;) {
    if (config.isPending()) {
      pendingStartMs ??= now();
      const pendingWaitMs = Math.max(0, now() - pendingStartMs);
      if (pendingWaitMs >= config.permissionTimeoutMs) {
        return { kind: "permission-wait-exhausted", pendingWaitMs };
      }
    } else {
      // No pending prompt: the watch is disarmed, never firing on clean turns.
      pendingStartMs = undefined;
    }
    if (settledFlag) {
      if (settled) return { kind: "settled", value: settled.value };
      // The run rejected: surface the rejection to the caller.
      return { kind: "settled", value: await run };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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

/**
 * Replace a reviewer's superseded round checks with the current round's check. A report carries
 * checks across review/remediation rounds; an earlier failed round for a superseded candidate is
 * not the current candidate's review state and must not poison the merged report status once a
 * newer round produced the current evidence. Exactly one current check remains per reviewer.
 */
export function replaceSupersededReviewerChecksV1(checks: ValidationCheck[], round: number, reviewer: string, check: ValidationCheck): void {
  const pattern = new RegExp(`^candidate\\.assurance\\.reviewer\\.(\\d+)\\.${reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(checks[index]!.id);
    if (match && Number(match[1]) < round) checks.splice(index, 1);
  }
  checks.push(check);
}

function mergeReviewCheck(report: ValidationReport, check: ValidationCheck): ValidationReport {
  return mergeChecksById(report, [check]);
}

function mergeChecksById(report: ValidationReport, extra: readonly ValidationCheck[]): ValidationReport {
  const byId = new Map(report.checks.map((existing) => [existing.id, existing]));
  for (const check of extra) byId.set(check.id, check);
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
  const changed = [...new Set((report.changedFiles ?? []).filter(Boolean))].slice(0, 50);
  const changedLine = changed.length ? ` The assembled candidate changed these files: ${changed.join(", ")}. Read them directly in this workspace.` : "";
  const requirements = (contract.requirements ?? []).slice(0, 20).map((requirement) => `${requirement.id}: ${requirement.description}`).join(" | ");
  const requirementsLine = requirements ? ` The sealed contract requirements are: ${requirements}.` : "";
  const boundary = " This is a read-only review turn: do not modify files and do not attempt to access paths outside this candidate workspace and the operation control root (for example /root, /home or /etc). An out-of-scope read stops the provider session and fails the operation; inspect the candidate files directly instead.";
  return `You are reviewer ${reviewer} for ${contract.task.id}. Inspect the assembled candidate against the sealed task contract, including the diff from ${contract.git?.baseRef ?? "main"} where a read-only command is available.${changedLine}${requirementsLine}${boundary} Deterministic validation currently reports ${report.status}.${assignment} Return findings with requiredCompetencies and reviewDimensions; never select a concrete agent or reviewer. Use exceptionType only when the issue cannot be resolved from the sealed requirements/repository without an external human decision or resource. Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object.`;
}
function buildRemediationPrompt(contract: TaskContract, stage: ReviewEscalationStage, state: QualityState, findings: NormalizedFinding[], replan?: PlannerOutput): string {
  return `Autonomously remediate review debt for ${contract.task.id}. Stage=${stage.name}. Current DebtScore=${formatDebtScore(state.debtScore)}; final gate requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3. Three notes equal one low. Do not change sealed contracts/specs/acceptance. Critical/high/medium findings are mandatory. Resolve low/note findings as needed to reach the final debt budget without broadening scope or creating regressions. ${replan ? `A stronger planner produced this advisory remediation plan (it does not override the sealed contract):\n${JSON.stringify(replan, null, 2)}\n` : ""}Findings:\n${JSON.stringify(findings, null, 2)}\nMake the smallest coherent changes and run focused checks. Do not ask the user unless a sealed requirement is contradictory, a product decision is genuinely missing, or an external credential/permission is required. Out-of-scope blocker path (report, don't expand): if the fix needs files outside the frozen scope, return no changes and declare them via AEH_RESULT_JSON filesNeededOutsideScope[{path, reason}]; silent expansion is rejected.`;
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
