import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, RecoveryMap, ResolvedRoute } from "../agents/types.js";
import { auditAgentTopology } from "../agents/audit.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { classifyFailureDecision, classifyFailureWithSemanticAssessment, formatRecoveryAction, resolveRecoveryStep } from "../agents/recovery.js";
import { executionSelectionForAgent, selectExecutionForTask, selectAgentNames, selectionWithModelOverride } from "../agents/routing.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import { runReviewLifecycle } from "../agents/reviewLifecycle.js";
import type { SeverityCounts } from "../agents/qualityConvergence.js";
import { executePlannerWaves, type PlannerWaveResult } from "../agents/waveExecutor.js";
import { escalationStages, selectionForStage } from "../agents/escalation.js";
import type { PlannerOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, RunMetrics, TaskContract, ValidationCheck, ValidationCommand, ValidationReport, WorkerSession, ValidatorSpec } from "./types.js";
import { loadTaskContract } from "./config.js";
import { validateSddChange } from "./sdd.js";
import { sealTask, verifyTaskSeal } from "./seal.js";
import { verifyTask } from "./verify.js";
import { createRepairPacket, writeRepairPacket } from "./repair.js";
import { createWorkerExecutor } from "../workers/factory.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { buildRepairPrompt } from "../workers/prompt.js";
import { snapshotGraph } from "../validators/graphify.js";
import { recordEvent } from "../telemetry/events.js";
import { extractUsageMetrics } from "../metrics/usage.js";
import { buildRunMetrics, countHumanInterventions } from "../metrics/runMetrics.js";
import { deliveryWorkspacePath } from "../delivery/handoff.js";
import { deliveryFinalizationFailure, finalizeAcceptedIssue, type DeliveryFinalizationResult } from "../delivery/finalize.js";
import { verifyGithubIssueDrift } from "../issues/intake.js";
import { createControlPlaneSnapshot, detectControlPlaneDrift, materializeControlPlaneSnapshot, type ControlPlaneSnapshot } from "./controlPlane.js";
import { resolveOrganizationPolicyBundles, withOrganizationPolicies } from "../policy/bundles.js";
import { buildRequirementEvidenceGraph, evidenceValidationCheck, type RequirementEvidenceGraph } from "../evidence/graph.js";
import { enforceSandboxPolicy } from "../security/sandbox.js";
import { assertCurrentControllerOwner, bindOperationCandidate, currentOperationContext, loadOperation, resolveOperationStateRoot, setOperationStage } from "../operations/state.js";
import { ensureOperationSupervisor, maybeRotateOperationSupervisor, settleDrainingSupervisorGenerations } from "../operations/supervisor.js";
import { createMemoryProvider } from "../providers/memory.js";
import { buildAcceptedOperationCandidates } from "../memory/candidates.js";
import { compileExecutionCatalog, type ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import { assembleCandidateChangeSet, type CandidateImpactAssessmentRuntimeV1 } from "../candidates/assembler.js";
import { executeIsolatedCandidateMutation } from "../candidates/direct.js";
import { executeRepairerCandidateMutation } from "../candidates/repair.js";
import { bindAssembledCandidate } from "../candidates/binding.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1, type SemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import { discoverProjectStackProfile, type ProjectStackProfileV1 } from "../participants/stack.js";
import { compileCandidateAssuranceV1, candidateImpactValidationRequirementsV1, candidateAssuranceProviderAdapterV1, type CandidateAssuranceCompilationV1, type CandidateAssurancePolicyV1 } from "../architecture/candidateAssurance.js";
import { resolveValidationRequirements, validationRequirementKindValues, type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import type { CandidateImpactV1 } from "../candidates/assembler.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertResolvedOperationPolicyV1, compileResolvedOperationPolicy, type ResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { bindResolvedOperationPolicy, currentControllerEpoch } from "../operations/state.js";
import { runValidationCommand } from "../validators/commands.js";
import { runConfiguredValidators } from "../validators/registry.js";
import { providerSpecFor, runCapabilityValidator } from "../providers/validation/registry.js";
import { runExternalToolValidator } from "../validators/external.js";
import type { ValidationProviderContext } from "../providers/validation/types.js";
import { buildAcceptanceEvidenceBundleV1, currentObjectiveIdentityV1, evaluateAcceptanceOracleV1, leadAcceptanceRequiredV1, persistAcceptanceOracleArtifactV1, type AcceptanceOracleDispositionV1, type EvidenceBundleV1 } from "../architecture/acceptanceOracle.js";
import { requestManagedLeadAcceptance } from "../agents/managedLeadAcceptance.js";
import { evaluateObjectiveCompletionV1, type ObjectiveCompletionInputV1 } from "../architecture/objectiveCompletion.js";

export interface CandidateAssuranceEvaluationV1 {
  compilation?: CandidateAssuranceCompilationV1;
  validationChecks: ValidationCheck[];
  gateCheck: ValidationCheck;
}

export interface TaskRunResult {
  taskId: string;
  status: "PASS" | "FAIL";
  attempts: number;
  worker: WorkerSession;
  report: ValidationReport;
  metrics: RunMetrics;
  routing?: { profile?: string; ruleIds: string[]; agent: string; runtime: string; model: string; nativeAgent?: string; reviewers: string[]; implementationRoute?: string; assurance?: string; };
  planning?: { used: boolean; workUnits: number; waves: number; distributed: boolean; graphUsed?: boolean; compilerDigest?: string; };
  controlPlane?: { sha256: string; gitCommit?: string; drifted: boolean; changed: string[]; missing: string[]; added: string[]; };
  evidence?: { sha256: string; complete: boolean; requirements: number; reasons: string[]; };
  candidateAssurance?: CandidateAssuranceEvaluationV1;
  acceptanceOracle?: AcceptanceOracleDispositionV1;
  acceptanceOracleArtifact?: string;
  evidenceBundle?: EvidenceBundleV1;
  objectiveCompletion?: ObjectiveCompletionInputV1;
  objectiveCompletionDecision?: ReturnType<typeof evaluateObjectiveCompletionV1>;
  review?: { status: "PASS" | "FAIL"; finalState: string; humanRequired: boolean; rounds: number; findings: number; debtScore: number; debtPoints: number; counts: SeverityCounts; convergence: string; leadAccepted?: boolean; reviewerSessions: number; };
  delivery?: DeliveryFinalizationResult;
}

interface FrozenExecutionBoundaryV1 {
  route?: ResolvedRoute;
  selection?: AgentExecutionSelection;
  plannerSelection?: AgentExecutionSelection;
  librarianSelection?: AgentExecutionSelection;
  supervisorSelection?: AgentExecutionSelection;
  repairerSelection?: AgentExecutionSelection;
  reviewerSelections?: Record<string, AgentExecutionSelection>;
  leadSelection?: AgentExecutionSelection;
  stageSelections?: Record<string, AgentExecutionSelection | undefined>;
  executionCatalog?: ExecutionCatalogV1;
  recovery?: RecoveryMap;
}

export async function runTask(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: { profile?: string; planning?: PlannerOutput; semanticRuntime?: SemanticAssessmentRuntimeV1 }): Promise<TaskRunResult> {
  const controlRoot = path.resolve(root);
  const operationStateRoot = resolveOperationStateRoot(root);
  const operationId = currentOperationContext().id;
  const policyResolution = await resolveOrganizationPolicyBundles(controlRoot, config);
  const effectiveConfig = withOrganizationPolicies(config, policyResolution);
  const workspaceRoot = path.resolve(await deliveryWorkspacePath(controlRoot, effectiveConfig, contract.task.id) ?? controlRoot);
  const effectiveContract = workspaceRoot === controlRoot ? contract : await loadTaskContract(workspaceRoot, contract.task.id, effectiveConfig);
  const semanticRuntime = options?.semanticRuntime ?? (operationId ? await createSemanticAssessmentRuntimeV1(workspaceRoot, effectiveConfig, { profile: options?.profile }) : undefined);
  let projectStack: ProjectStackProfileV1 | undefined;
  if (operationId && semanticRuntime) {
    const operation = await loadOperation(operationStateRoot, operationId);
    const binding = await createSemanticRepositoryBindingV1(workspaceRoot, effectiveConfig, { operationId, candidate: operation.candidateRevision });
    projectStack = await discoverProjectStackProfile(workspaceRoot, { semanticAssessment: { service: semanticRuntime.service, binding } });
    await recordEvent(controlRoot, effectiveConfig, "harness.semantic.stack-assessed", { taskId: effectiveContract.task.id, inputDigest: projectStack.inputDigest, assessmentDigest: projectStack.assessmentDigest, bindingDigest: projectStack.bindingDigest, policyRevision: projectStack.policyRevision, unknowns: projectStack.unknowns });
  }
  const impactAssessmentRuntime: CandidateImpactAssessmentRuntimeV1 | undefined = operationId && semanticRuntime
    ? { service: semanticRuntime.service, policyRevision: semanticRuntime.policyRevision, repositoryBinding: await createSemanticRepositoryBindingV1(workspaceRoot, effectiveConfig, { operationId }) }
    : undefined;
  const implementationRoute = effectiveContract.routing?.route ?? "DIRECT";
  const assurance = effectiveContract.routing?.assurance ?? "STANDARD";
  if (implementationRoute === "NO_AGENT") throw new Error(`NO_AGENT_ROUTE: task ${effectiveContract.task.id} is explicitly non-mutating and cannot enter implementation execution.`);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const issueDrift = await verifyGithubIssueDrift(controlRoot, effectiveConfig, effectiveContract);
  if (!issueDrift.ok) throw new Error(issueDrift.message);
  if (effectiveContract.issue) await recordEvent(controlRoot, effectiveConfig, "harness.issue.drift-check", { taskId: effectiveContract.task.id, issue: effectiveContract.issue.number, repository: effectiveContract.issue.repository, ok: true, contentSha256: effectiveContract.issue.contentSha256 });
  if (implementationRoute === "FORMAL_SDD") {
    const trace = await validateSddChange(workspaceRoot, effectiveContract.task.id, effectiveConfig);
    if (!trace.ok) throw new Error(`SDD validation failed before delegation:\n${[...trace.missing, ...trace.issues].map((item) => `- ${item}`).join("\n")}`);
  }
  if (workspaceRoot === controlRoot) await sealTask(controlRoot, effectiveConfig, effectiveContract);
  else {
    const seal = await verifyTaskSeal(workspaceRoot, effectiveContract, effectiveConfig.validation?.requireSeal ?? true);
    if (seal.status === "FAIL") throw new Error(`Delivery workspace trust check failed before delegation: ${seal.message}`);
  }

  const executionBoundary = await resolveExecutionBoundary(controlRoot, effectiveConfig, effectiveContract, options?.profile);
  const route = executionBoundary.route;
  let selection = executionBoundary.selection;
  const plannerSelection = executionBoundary.plannerSelection;
  const librarianSelection = executionBoundary.librarianSelection;
  const supervisorSelection = executionBoundary.supervisorSelection;
  if (selection) selection = enforceSandboxPolicy(selection, effectiveConfig, effectiveContract.routing?.risk ?? "low").selection;
  let assurancePolicySource: ResolvedOperationPolicyV1 | undefined = operationId
    ? (await loadOperation(operationStateRoot, operationId)).resolvedOperationPolicy
    : undefined;

  const directReviewEnabled = implementationRoute === "DIRECT" && effectiveConfig.workflow?.reviews?.directReview === true && Boolean(route?.reviewers.length);
  if (operationId && supervisorSelection && (implementationRoute !== "DIRECT" || directReviewEnabled)) {
    await runStage(operationStateRoot, operationId, "supervision", "RUNNING");
    await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection, { required: true, forceMaterialize: true });
    await runStage(operationStateRoot, operationId, "supervision", "COMPLETED");
  }

  let controller: ControlPlaneSnapshot | undefined;
  try { controller = await createControlPlaneSnapshot(controlRoot, effectiveConfig, effectiveContract.task.id); }
  catch (error) {
    if (effectiveConfig.controlPlane?.required !== false) throw error;
    await recordEvent(controlRoot, effectiveConfig, "harness.control.snapshot-failed", { taskId: effectiveContract.task.id, error: String(error) });
  }
  if (controller && workspaceRoot !== controlRoot) await materializeControlPlaneSnapshot(controller, workspaceRoot, effectiveConfig);
  await recordEvent(controlRoot, effectiveConfig, "harness.run.start", { taskId: effectiveContract.task.id, route: implementationRoute, workspaceRoot: workspaceRoot === controlRoot ? undefined : workspaceRoot, issue: effectiveContract.issue ? { repository: effectiveContract.issue.repository, number: effectiveContract.issue.number } : undefined, controllerSha256: controller?.compositeSha256, policyBundles: policyResolution.bundles.map((bundle) => bundle.name) });

  await refreshGraphIfConfigured(workspaceRoot, effectiveConfig);
  const beforeSnapshot = await snapshotGraph(workspaceRoot, effectiveConfig, effectiveContract.task.id, "before");
  if (!beforeSnapshot && effectiveConfig.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify before snapshot could not be created.");

  let worker: WorkerSession;
  let waveResult: PlannerWaveResult | undefined;
  let executionSessions: WorkerSession[] = [];
  let report: ValidationReport;
  let candidateImpact: CandidateImpactV1 | undefined;
  let assuranceEvaluation: CandidateAssuranceEvaluationV1 | undefined;
  const executionCatalog = executionBoundary.executionCatalog;
  const planningEnabled = (implementationRoute === "DELEGATED" || implementationRoute === "FORMAL_SDD") && route && selection && executionCatalog && effectiveConfig.workflow?.planning?.enabled !== false;
  if (planningEnabled && route && selection && executionCatalog) {
    const planningSelection = selection;
    if (operationId) await runStage(operationStateRoot, operationId, "planning", "RUNNING");
    waveResult = await executePlannerWaves({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, plannerSelection, librarianSelection, implementationSelection: planningSelection, executionCatalog, controller, precomputedPlan: options?.planning, projectStack, semanticAssessment: impactAssessmentRuntime, revalidate: async () => verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, planningSelection) });
    executionSessions = [...waveResult.sessions];
    if (waveResult.blueprint?.resolvedOperationPolicy) assurancePolicySource = waveResult.blueprint.resolvedOperationPolicy;
    if (operationId) {
      const current = (await loadOperation(operationStateRoot, operationId)).candidateRevision;
      candidateImpact = waveResult.waves.flatMap((wave) => wave.results).map((result) => result.impact).filter((impact): impact is CandidateImpactV1 => Boolean(
        impact && current && impact.candidate.candidateId === current.candidateId && impact.candidate.revision === current.revision && impact.candidate.identityDigest === current.identityDigest
      )).at(-1);
    }
    if (operationId) {
      await runStage(operationStateRoot, operationId, "planning", waveResult.aggregateSession?.exitCode === 0 || !waveResult.aggregateSession ? "COMPLETED" : "FAILED");
      await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection);
    }
  }

  if (operationId) await runStage(operationStateRoot, operationId, "implementation", "RUNNING");
  if (waveResult?.used && waveResult.aggregateSession) {
    worker = waveResult.aggregateSession;
    report = withWorkerExecutionCheck(waveResult.report ?? await verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection), worker);
  } else {
    const executor = createWorkerExecutor(effectiveConfig, selection);
    const health = await executor.doctor(workspaceRoot, effectiveConfig, selection);
    if (!health.ok) throw new Error(`${executor.name} executor unavailable: ${health.message}`);
    if (!operationId) throw new Error("CANDIDATE_BINDING_REQUIRED: DIRECT implementation requires a managed operation candidate.");
    const operation = await loadOperation(operationStateRoot, operationId);
    const currentCandidate = operation.candidateRevision;
    if (!currentCandidate) throw new Error(`CANDIDATE_BINDING_REQUIRED: operation ${operationId} has no current candidate revision.`);
    const isolated = await executeIsolatedCandidateMutation({
      root: workspaceRoot,
      operationId,
      taskId: effectiveContract.task.id,
      workUnitId: `direct:${effectiveContract.task.id}`,
      candidate: currentCandidate,
      config: effectiveConfig,
      contract: effectiveContract,
      execute: (isolatedRoot) => executor.start(isolatedRoot, effectiveConfig, effectiveContract, selection),
      prepareWorkspace: controller ? async (isolatedRoot) => { await materializeControlPlaneSnapshot(controller!, isolatedRoot, effectiveConfig); } : undefined
    });
    worker = isolated.session;
    executionSessions.push(worker);
    if (isolated.changeSet) {
      const assembled = await assembleCandidateChangeSet({
        root: workspaceRoot,
        operationId,
        projectId: currentCandidate.projectId,
        taskId: effectiveContract.task.id,
        currentCandidate,
        changeSet: isolated.changeSet,
        allowedScope: effectiveContract.scope?.allowed ?? ["**"],
        forbiddenScope: effectiveContract.scope?.forbidden ?? [],
        candidateId: `candidate:${operationId}:r${currentCandidate.revision + 1}`,
        workspace: currentCandidate.workspace,
        worktree: workspaceRoot,
        semanticAssessment: impactAssessmentRuntime
      });
      const boundCandidate = await bindAssembledCandidate({ root: workspaceRoot, stateRoot: controlRoot, operationId, baseCandidate: currentCandidate, candidate: assembled.candidate, changeSet: isolated.changeSet });
      candidateImpact = assembled.impact;
      await recordEvent(controlRoot, effectiveConfig, "harness.candidate.assembled", {
        taskId: effectiveContract.task.id,
        workUnitId: isolated.changeSet.workUnitId,
        participantId: isolated.changeSet.participantId,
        candidateRevision: boundCandidate.revision,
        candidateDigest: boundCandidate.sourceDigest,
        impactDigest: assembled.impact.digest,
        requiresIndependentReview: assembled.impact.requiresIndependentReview
      });
    }
    report = withWorkerExecutionCheck(await verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection), worker);
  }
  if (operationId) await runStage(operationStateRoot, operationId, "implementation", report.status === "PASS" ? "COMPLETED" : "FAILED");

  let evidenceGraph: RequirementEvidenceGraph | undefined;
  const attachEvidence = async (candidate: ValidationReport): Promise<ValidationReport> => {
    if (candidate.status !== "PASS" || effectiveConfig.evidence?.enabled !== true) return candidate;
    evidenceGraph = await buildRequirementEvidenceGraph({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, report: candidate, plan: waveResult?.plan, sessions: executionSessions });
    return mergeChecks(candidate, [evidenceValidationCheck(evidenceGraph, effectiveConfig)]);
  };
  const recompileAssuranceForReport = async (impact: CandidateImpactV1 | undefined, candidateReport: ValidationReport): Promise<CandidateAssuranceEvaluationV1> => {
    const result = await recompileCandidateAssurance({
      root: workspaceRoot,
      stateRoot: controlRoot,
      config: effectiveConfig,
      contract: effectiveContract,
      operationId,
      impact,
      report: candidateReport,
      policySource: assurancePolicySource,
      reviewerSelections: executionBoundary.reviewerSelections ?? {},
      implementationSelection: selection,
      baseValidationRequirements: waveResult?.plan?.validationRequirements ?? [],
      projectStack
    });
    candidateImpact = impact;
    assurancePolicySource = result.policySource ?? assurancePolicySource;
    assuranceEvaluation = result.evaluation;
    return result.evaluation;
  };
  assuranceEvaluation = await recompileAssuranceForReport(candidateImpact, report);
  report = mergeChecks(report, [assuranceEvaluation.gateCheck]);
  report = await attachEvidence(report);
  const firstPassSuccess = report.status === "PASS";
  const maxRepairs = effectiveContract.repair?.maxAttempts ?? effectiveConfig.orchestration?.worker?.maxRepairAttempts ?? 2;
  let attempts = 0;
  while (report.status === "FAIL" && attempts < maxRepairs) {
    if (operationId && supervisorSelection) {
      await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection, { required: true, forceMaterialize: true });
      await runStage(operationStateRoot, operationId, "remediation", "RUNNING");
    }
    attempts += 1;
    const failureEvidence = { report, worker };
    const currentOperation = operationId ? await loadOperation(operationStateRoot, operationId) : undefined;
    const failureDecision = semanticRuntime && currentOperation?.candidateRevision
      ? await classifyFailureWithSemanticAssessment(failureEvidence, {
          service: semanticRuntime.service,
          policyRevision: semanticRuntime.policyRevision,
          binding: await createSemanticRepositoryBindingV1(workspaceRoot, effectiveConfig, { operationId, candidate: currentOperation.candidateRevision })
        })
      : classifyFailureDecision(failureEvidence);
    const failureType = failureDecision.classification;
    const recovery = executionBoundary.recovery ? resolveRecoveryStep(executionBoundary.recovery, failureType, attempts) : { action: "same-agent" as const };
    const recoveryAction = formatRecoveryAction(recovery, selection?.logicalAgent ?? "legacy-worker");
    const packet = createRepairPacket(report, attempts, { failureType, failedAgent: selection?.logicalAgent, recoveryAction });
    if (!packet.failures.length) break;
    await writeRepairPacket(controlRoot, effectiveConfig, packet);
    await recordEvent(controlRoot, effectiveConfig, "harness.repair.start", { taskId: effectiveContract.task.id, attempt: attempts, failureType, failureMechanism: failureDecision.mechanism, failureAssessmentDigest: failureDecision.assessmentDigest, failureUnknowns: failureDecision.unknowns, recoveryAction, failures: packet.failures.length });
    if (recovery.action === "lead" || recovery.action === "stop") break;
    const repairerSelection = executionBoundary.repairerSelection;
    const activeOperationId = currentOperationContext().id;
    if (!activeOperationId) throw new Error("REPAIR_AUTHORITY_REQUIRED: candidate repair requires a managed operation.");
    if (!repairerSelection || !executionBoundary.executionCatalog) {
      throw new Error("REPAIR_AUTHORITY_REQUIRED: a frozen Repairer selection and compiled role binding are required for candidate repair.");
    }
    const repairerTransport = repairerSelection.transport === "inherit" ? (effectiveConfig.orchestration?.provider ?? "none") : repairerSelection.transport;
    const repairerIssues = validateExecutionCapabilities(repairerSelection, repairerTransport);
    if (repairerIssues.length) throw new Error(`Repairer ${repairerSelection.logicalAgent} is not executable: ${repairerIssues.join("; ")}`);
    const repairPrompt = `${buildRepairPrompt(packet)}\n\nYou are the canonical Repairer for this operation. Repair only the implementation within the frozen task scope. Do not change requirements, acceptance assertions, validators, policy, or this repair packet. You cannot approve or accept the candidate.`;
    const repair = await executeRepairerCandidateMutation({
      root: workspaceRoot,
      stateRoot: controlRoot,
      operationId: activeOperationId,
      taskId: effectiveContract.task.id,
      workUnitId: `repair:${effectiveContract.task.id}:${attempts}`,
      phase: "validation-repair",
      config: effectiveConfig,
      contract: effectiveContract,
      selection: repairerSelection,
      executionCatalog: executionBoundary.executionCatalog,
      allowedScope: effectiveContract.scope?.allowed ?? ["**"],
      forbiddenScope: [...(effectiveContract.scope?.forbidden ?? []), ...(effectiveContract.scope?.frozen ?? []), ...(effectiveConfig.validation?.frozenPaths ?? [])],
      prompt: repairPrompt,
      prepareWorkspace: controller ? async (isolatedRoot) => { await materializeControlPlaneSnapshot(controller!, isolatedRoot, effectiveConfig); } : undefined,
      execute: (isolatedRoot, participantId) => executeAgentPrompt(isolatedRoot, effectiveConfig, effectiveContract, repairerSelection, repairPrompt, { phase: "repair", operationKind: currentOperationContext().kind, participantId, requireExecutionAuthority: true }),
      semanticAssessment: impactAssessmentRuntime
    });
    worker = repair.session;
    executionSessions.push(worker);
    if (repair.candidate) candidateImpact = repair.impact;
    report = withWorkerExecutionCheck(await verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection), worker);
    assuranceEvaluation = await recompileAssuranceForReport(candidateImpact, report);
    report = mergeChecks(report, [assuranceEvaluation.gateCheck]);
    report = await attachEvidence(report);
    await recordEvent(controlRoot, effectiveConfig, "harness.repair.finish", { taskId: effectiveContract.task.id, attempt: attempts, status: report.status, agent: selection?.logicalAgent });
    if (operationId && supervisorSelection) await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection);
  }
  if (operationId && attempts > 0) await runStage(operationStateRoot, operationId, "remediation", report.status === "PASS" ? "COMPLETED" : "FAILED");

  let reviewSummary: TaskRunResult["review"];
  let reviewFindings: import("../agents/outputContracts.js").NormalizedFinding[] = [];
  let reviewSessions: WorkerSession[] = [];
  if (report.status === "PASS" && route && selection) {
    const compiledReviewerNames = assuranceEvaluation?.compilation?.reviewAssignments.map((assignment) => assignment.reviewerIdentity) ?? [];
    const willRunReviewers = compiledReviewerNames.length > 0 || implementationRoute !== "DIRECT" || effectiveConfig.workflow?.reviews?.directReview === true;
    if (operationId && willRunReviewers && (compiledReviewerNames.length > 0 || route.reviewers.length > 0)) {
      await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection, { required: true, forceMaterialize: true });
      await runStage(operationStateRoot, operationId, "review", "RUNNING");
    }
    const review = await runReviewLifecycle({
      root: workspaceRoot,
      stateRoot: controlRoot,
      config: effectiveConfig,
      contract: effectiveContract,
      route,
      reviewerSelections: executionBoundary.reviewerSelections ?? {},
      leadSelection: executionBoundary.leadSelection,
      repairerSelection: executionBoundary.repairerSelection,
      executionCatalog: executionBoundary.executionCatalog,
      prepareRepairWorkspace: controller ? async (isolatedRoot) => { await materializeControlPlaneSnapshot(controller!, isolatedRoot, effectiveConfig); } : undefined,
      stageSelections: executionBoundary.stageSelections,
      supervisorSelection,
      implementationSelection: selection,
      report,
      candidateImpact,
      candidateImpactAssessment: impactAssessmentRuntime,
      candidateAssurance: assuranceEvaluation?.compilation,
      assuranceGateCheck: assuranceEvaluation?.gateCheck,
      recompileCandidateAssurance: async (impact, candidateReport) => recompileAssuranceForReport(impact, candidateReport),
      revalidate: async () => verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection)
    });
    report = mergeChecks(withWorkerExecutionCheck(review.report, worker), review.checks);
    reviewFindings = review.findings.findings;
    reviewSessions = review.sessions;
    const quality = review.qualityHistory.at(-1)!;
    reviewSummary = { status: review.status, finalState: review.finalState, humanRequired: review.humanRequired, rounds: review.rounds, findings: review.findings.outputCount, debtScore: quality.debtScore, debtPoints: quality.debtPoints, counts: quality.counts, convergence: quality.convergence, leadAccepted: review.leadAccepted, reviewerSessions: review.sessions.length };
    await recordEvent(controlRoot, effectiveConfig, "harness.review.finish", { taskId: effectiveContract.task.id, status: review.status, finalState: review.finalState, humanRequired: review.humanRequired, rounds: review.rounds, findings: review.findings.outputCount, debtScore: quality.debtScore, convergence: quality.convergence, leadAccepted: review.leadAccepted, sessions: review.sessions.length });
    if (operationId && willRunReviewers && (compiledReviewerNames.length > 0 || route.reviewers.length > 0)) {
      await runStage(operationStateRoot, operationId, "review", review.status === "PASS" ? "COMPLETED" : review.humanRequired ? "BLOCKED" : "FAILED");
      await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, supervisorSelection);
    }
    if (report.status === "PASS" && effectiveConfig.evidence?.enabled === true) {
      evidenceGraph = await buildRequirementEvidenceGraph({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, report, plan: waveResult?.plan, findings: reviewFindings, sessions: [...executionSessions, ...reviewSessions] });
      report = mergeChecks(report, [evidenceValidationCheck(evidenceGraph, effectiveConfig)]);
    }
  }

  let acceptanceOracle: AcceptanceOracleDispositionV1 | undefined;
  let evidenceBundle: EvidenceBundleV1 | undefined;
  let acceptanceOracleArtifact: string | undefined;
  if (operationId) {
    try {
      const operation = await loadOperation(operationStateRoot, operationId);
      assertCurrentControllerOwner(operation, "AcceptanceOracle disposition");
      const compilation = assuranceEvaluation?.compilation;
      if (!compilation) throw new Error("ACCEPTANCE_ASSERTIONS_REQUIRED: S6 requires current S4 AcceptanceAssertion compilation before disposition.");
      const policy = operation.resolvedOperationPolicy;
      if (!policy) throw new Error("ACCEPTANCE_POLICY_REQUIRED: AcceptanceOracle requires the operation's current frozen policy.");
      const leadEvidence = report.status === "PASS" && leadAcceptanceRequiredV1(policy)
        ? await requestManagedLeadAcceptance({ root: workspaceRoot, operationId, compilation, report, implementationIdentity: selection?.logicalAgent ?? "<missing-implementation-identity>" })
        : undefined;
      const current = await loadOperation(operationStateRoot, operationId);
      assertCurrentControllerOwner(current, "AcceptanceOracle persistence");
      evidenceBundle = buildAcceptanceEvidenceBundleV1({ operation: current, compilation, report, implementationIdentity: selection?.logicalAgent ?? "<missing-implementation-identity>", leadEvidence });
      acceptanceOracle = evaluateAcceptanceOracleV1(evidenceBundle, compilation.evidenceStrength);
      acceptanceOracleArtifact = await persistAcceptanceOracleArtifactV1(operationStateRoot, evidenceBundle, acceptanceOracle);
      report = mergeChecks(report, [{
        id: "acceptance.oracle",
        category: "acceptance-oracle",
        status: acceptanceOracle.disposition === "ACCEPTED" ? "PASS" : "FAIL",
        message: acceptanceOracle.disposition === "ACCEPTED"
          ? `AcceptanceOracle accepted ${acceptanceOracle.coveredAssertionIds.length} current candidate assertions.`
          : `AcceptanceOracle rejected the current candidate: ${acceptanceOracle.blockers.map((item) => item.code).join(", ")}.`,
        details: { disposition: acceptanceOracle.disposition, identity: acceptanceOracle.identity, evidenceBundleDigest: evidenceBundle.digest, artifact: acceptanceOracleArtifact, requiredAssertionIds: acceptanceOracle.requiredAssertionIds, coveredAssertionIds: acceptanceOracle.coveredAssertionIds, blockers: acceptanceOracle.blockers }
      }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report = mergeChecks(report, [{ id: "acceptance.oracle", category: "acceptance-oracle", status: "FAIL", message: `AcceptanceOracle could not produce a current disposition: ${message}`, details: { error: message } }]);
    }
  }

  let deliverySummary: DeliveryFinalizationResult | undefined;
  if (report.status === "PASS") {
    if (operationId) await runStage(operationStateRoot, operationId, "delivery", "RUNNING");
    try {
      deliverySummary = await finalizeAcceptedIssue(workspaceRoot, effectiveConfig, effectiveContract, { candidate: report.candidate });
      if (deliverySummary.status !== "SKIPPED") await recordEvent(controlRoot, effectiveConfig, "harness.delivery.finalize", { taskId: effectiveContract.task.id, status: deliverySummary.status, commitSha: deliverySummary.commitSha, pullRequest: deliverySummary.pullRequest });
      if (operationId) await runStage(operationStateRoot, operationId, "delivery", "COMPLETED");
    } catch (error) {
      deliverySummary = { ...deliveryFinalizationFailure(error), candidate: report.candidate };
      report = mergeChecks(report, [{ id: "delivery.finalization", category: "delivery", status: "FAIL", message: deliverySummary.message, details: { status: deliverySummary.status, humanRequired: deliverySummary.humanRequired } }]);
      if (reviewSummary && deliverySummary.humanRequired) reviewSummary = { ...reviewSummary, status: "FAIL", finalState: "BLOCKED_EXTERNAL", humanRequired: true };
      await recordEvent(controlRoot, effectiveConfig, "harness.delivery.finalize", { taskId: effectiveContract.task.id, status: deliverySummary.status, humanRequired: deliverySummary.humanRequired, message: deliverySummary.message });
      if (operationId) await runStage(operationStateRoot, operationId, "delivery", deliverySummary.humanRequired ? "BLOCKED" : "FAILED", { message: deliverySummary.message });
    }
  }
  if (report.status === "PASS" && effectiveConfig.evidence?.enabled === true) {
    evidenceGraph = await buildRequirementEvidenceGraph({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, report, plan: waveResult?.plan, findings: reviewFindings, sessions: [...executionSessions, ...reviewSessions], delivery: deliverySummary });
    report = mergeChecks(report, [evidenceValidationCheck(evidenceGraph, effectiveConfig)]);
  }

  const drift = controller ? await detectControlPlaneDrift(controlRoot, controller) : { changed: [], missing: [], added: [], drifted: false };
  if (controller) report = mergeChecks(report, [{ id: "trust.control-plane-freeze", category: "trust-boundary", status: "PASS", message: drift.drifted ? "Control-plane files changed during the run, but the run remained governed by its frozen controller snapshot; changes activate next run." : "Control-plane snapshot remained unchanged during the run.", details: { controllerSha256: controller.compositeSha256, gitCommit: controller.gitCommit, drift } }]);

  if (operationId && supervisorSelection) await settleDrainingSupervisorGenerations(workspaceRoot, operationId);
  let objectiveCompletion: ObjectiveCompletionInputV1 | undefined;
  let objectiveCompletionDecision: ReturnType<typeof evaluateObjectiveCompletionV1> | undefined;
  if (operationId && report.status === "PASS") {
    try {
      const operation = await loadOperation(operationStateRoot, operationId);
      assertCurrentControllerOwner(operation, "objective completion evaluation");
      if (!acceptanceOracle || acceptanceOracle.disposition !== "ACCEPTED" || !evidenceBundle || !assuranceEvaluation?.compilation) {
        throw new Error("OBJECTIVE_COMPLETION_EVIDENCE_REQUIRED: current accepted AcceptanceOracle, EvidenceBundle, and S4 assertion compilation are required.");
      }
      const identity = currentObjectiveIdentityV1(operation);
      const requiredWorkUnitIds = waveResult?.plan?.workUnits.map((unit) => unit.id) ?? [`direct:${effectiveContract.task.id}`];
      const accountedWorkUnitIds = waveResult?.plan
        ? waveResult.waves.flatMap((wave) => wave.results.filter((result) => result.status === "PASS").map((result) => result.task.id))
        : worker.exitCode === 0 ? [`direct:${effectiveContract.task.id}`] : [];
      const validationRequirements = evidenceBundle.requirements.filter((requirement) => requirement.validationRequirementIds.length > 0);
      const reviewRequirements = evidenceBundle.requirements.filter((requirement) => requirement.reviewDimensions.length > 0);
      const evidenceForGate = (requirements: typeof validationRequirements, kind: "VALIDATION" | "REVIEW") => ({
        requiredAssertionIds: requirements.map((requirement) => requirement.assertionId),
        evidence: requirements.map((requirement) => {
          const items = evidenceBundle!.evidence.filter((item) => item.kind === kind && item.assertionId === requirement.assertionId);
          return { assertionId: requirement.assertionId, status: items.length > 0 && items.every((item) => item.status === "PASS") ? "PASS" as const : "FAIL" as const, identity };
        })
      });
      const deliveryRequired = effectiveContract.issue?.provider === "github"
        && effectiveConfig.delivery?.github?.enabled === true
        && (effectiveConfig.delivery.github.finalizeOnAcceptance === true || effectiveConfig.workflow?.issueIntake?.autoHandoff !== false);
      const deliveryReconciled = deliverySummary?.status === "HANDOFF_ONLY" || deliverySummary?.status === "FINALIZED" || deliverySummary?.status === "NO_CHANGES";
      objectiveCompletion = {
        version: 1,
        identity,
        workspaceCandidate: identity.candidate,
        workGraph: { requiredWorkUnitIds, accountedWorkUnitIds },
        validation: evidenceForGate(validationRequirements, "VALIDATION"),
        review: evidenceForGate(reviewRequirements, "REVIEW"),
        acceptance: { disposition: acceptanceOracle.disposition, requiredAssertionIds: acceptanceOracle.requiredAssertionIds, coveredAssertionIds: acceptanceOracle.coveredAssertionIds, identity },
        certification: { required: false },
        delivery: { required: deliveryRequired, disposition: deliveryRequired ? deliveryReconciled ? "RECONCILED" : "PENDING" : "NOT_REQUIRED", ...(deliveryRequired && deliveryReconciled ? { identity } : {}) },
        findings: reviewFindings.map((finding) => ({ candidate: identity.candidate, blocking: false })),
        participants: [
          ...Object.values(operation.participants).map((participant) => ({ id: participant.id, required: true, status: participant.status })),
          ...(leadAcceptanceRequiredV1(operation.resolvedOperationPolicy!) ? [{ id: operation.lead?.agentId ?? "managed-lead", required: true, status: "COMPLETED" as const }] : [])
        ],
        terminalIdentity: identity
      };
      objectiveCompletionDecision = evaluateObjectiveCompletionV1(objectiveCompletion);
      report = mergeChecks(report, [{
        id: "objective.completion",
        category: "objective-completion",
        status: objectiveCompletionDecision.complete ? "PASS" : "FAIL",
        message: objectiveCompletionDecision.complete ? "Complete objective evidence set satisfies the deterministic Definition of Done." : `Objective Definition of Done is blocked: ${objectiveCompletionDecision.blockers.map((item) => item.code).join(", ")}.`,
        details: { identity, blockers: objectiveCompletionDecision.blockers, requiredWorkUnitIds, accountedWorkUnitIds }
      }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report = mergeChecks(report, [{ id: "objective.completion", category: "objective-completion", status: "FAIL", message: `Objective Definition of Done could not be evaluated: ${message}`, details: { error: message } }]);
    }
  }
  const usageText = [...executionSessions, ...reviewSessions].map((session) => `${session.stdout}\n${session.stderr}`).join("\n");
  worker.metrics = extractUsageMetrics(usageText || `${worker.stdout}\n${worker.stderr}`);
  const metrics = buildRunMetrics({ firstPassSuccess, repairCount: attempts, humanInterventions: await countHumanInterventions(controlRoot, effectiveConfig, effectiveContract.task.id, startedAt), durationMs: Date.now() - startedMs, usage: worker.metrics });
  const routing = selection ? { profile: selection.profile, ruleIds: route?.ruleIds ?? [], agent: selection.logicalAgent, runtime: selection.runtimeName, model: selection.modelId, nativeAgent: selection.nativeAgent, reviewers: route?.reviewers ?? [], implementationRoute: route?.implementationRoute, assurance: route?.assurance } : undefined;
  const result: TaskRunResult = { taskId: effectiveContract.task.id, status: report.status, attempts, worker, report, metrics, routing, planning: waveResult ? { used: waveResult.used, workUnits: waveResult.plan?.workUnits.length ?? 0, waves: waveResult.schedule?.waves.length ?? 0, distributed: effectiveConfig.workflow?.planning?.distributed === true && effectiveConfig.distributed?.enabled === true, graphUsed: waveResult.schedule?.graphUsed, compilerDigest: waveResult.blueprint?.plan.compilerDigest } : undefined, controlPlane: controller ? { sha256: controller.compositeSha256, gitCommit: controller.gitCommit, drifted: drift.drifted, changed: drift.changed, missing: drift.missing, added: drift.added } : undefined, evidence: evidenceGraph ? { sha256: evidenceGraph.sha256, complete: evidenceGraph.complete, requirements: evidenceGraph.requirements.length, reasons: evidenceGraph.reasons } : undefined, candidateAssurance: assuranceEvaluation, acceptanceOracle, acceptanceOracleArtifact, evidenceBundle, objectiveCompletion, objectiveCompletionDecision, review: reviewSummary, delivery: deliverySummary };
  const runsDir = path.resolve(controlRoot, effectiveConfig.sdd?.runsDir ?? ".harness/runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runFile = path.join(runsDir, `${effectiveContract.task.id}.json`);
  await fs.writeFile(runFile, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "PASS" && effectiveConfig.memory?.provider && effectiveConfig.memory.provider !== "none") {
    try {
      const memory = await createMemoryProvider(controlRoot, effectiveConfig);
      if (memory) {
        const candidates = await buildAcceptedOperationCandidates({ root: controlRoot, project: effectiveConfig.project.name, operationId, contract: effectiveContract, result, runFile, reportFile: path.resolve(controlRoot, effectiveConfig.sdd?.reportsDir ?? ".harness/reports", `${effectiveContract.task.id}.json`), evidenceFile: path.resolve(controlRoot, effectiveConfig.evidence?.outputDir ?? ".harness/evidence", `${effectiveContract.task.id}.json`) });
        for (const candidate of candidates) await memory.remember(candidate);
      }
    } catch (error) {
      await recordEvent(controlRoot, effectiveConfig, "harness.memory.persist-failed", { taskId: effectiveContract.task.id, error: String(error) });
      if (effectiveConfig.memory.required) throw error;
    }
  }
  await recordEvent(controlRoot, effectiveConfig, "harness.run.finish", { taskId: effectiveContract.task.id, status: result.status, attempts, route: implementationRoute, assurance, workspaceRoot: workspaceRoot === controlRoot ? undefined : workspaceRoot, agent: selection?.logicalAgent, runtime: selection?.runtimeName, model: selection?.modelId, profile: selection?.profile, waves: result.planning?.waves, controllerSha256: result.controlPlane?.sha256, controllerDrifted: result.controlPlane?.drifted, evidenceComplete: result.evidence?.complete, evidenceSha256: result.evidence?.sha256, reviewStatus: reviewSummary?.status, reviewFinalState: reviewSummary?.finalState, humanRequired: reviewSummary?.humanRequired ?? deliverySummary?.humanRequired, debtScore: reviewSummary?.debtScore, deliveryStatus: deliverySummary?.status, pullRequest: deliverySummary?.pullRequest, durationMs: metrics.durationMs, totalTokens: metrics.usage.totalTokens ?? 0, costUsd: metrics.usage.costUsd ?? 0 });
  return result;
}

async function recompileCandidateAssurance(input: {
  root: string;
  stateRoot: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  operationId?: string;
  impact?: CandidateImpactV1;
  report: ValidationReport;
  policySource?: ResolvedOperationPolicyV1;
  reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>;
  implementationSelection?: AgentExecutionSelection;
  baseValidationRequirements: readonly import("../architecture/validationRequirements.js").ValidationRequirementV1[];
  projectStack?: ProjectStackProfileV1;
}): Promise<{ evaluation: CandidateAssuranceEvaluationV1; policySource?: ResolvedOperationPolicyV1 }> {
  const failed = (message: string, details?: Record<string, unknown>): CandidateAssuranceEvaluationV1 => ({
    validationChecks: [],
    gateCheck: { id: "candidate.assurance.recompiled", category: "candidate-assurance", status: "FAIL", message, details }
  });
  try {
    if (!input.operationId) return { evaluation: failed("Candidate assurance recompilation requires a managed operation policy and candidate.") };
    if (!input.report.candidate) return { evaluation: failed("Candidate assurance recompilation requires a current CandidateRevision in the validation report.") };
    if (!input.impact) return { evaluation: failed("Candidate assurance is BLOCKED because the current assembled candidate has no bound CandidateImpact.", { candidate: input.report.candidate }) };
    if (!input.policySource) return { evaluation: failed("Candidate assurance is BLOCKED because no frozen ResolvedOperationPolicy is available.", { candidate: input.report.candidate, impactDigest: input.impact.digest }) };

    const operation = await loadOperation(input.stateRoot, input.operationId);
    const currentCandidate = operation.candidateRevision;
    if (!currentCandidate || currentCandidate.candidateId !== input.report.candidate.candidateId || currentCandidate.revision !== input.report.candidate.revision || currentCandidate.identityDigest !== input.report.candidate.identityDigest) {
      return { evaluation: failed("Candidate assurance is BLOCKED because the report candidate is not the operation's current CandidateRevision.", { reportCandidate: input.report.candidate, currentCandidate }) };
    }
    const policy = await bindAssurancePolicyToCandidate(input.stateRoot, input.operationId, currentCandidate, input.policySource);
    const candidateAssurancePolicy = candidateAssurancePolicyFromFrozenPolicy(policy);
    const impactRequirements = candidateImpactValidationRequirementsV1(input.impact);
    const requirements = [...input.baseValidationRequirements, ...impactRequirements];
    const validationResolution = await resolveValidationRequirements({
      root: input.root,
      requirements,
      config: input.config,
      contract: input.contract,
      projectStack: input.projectStack,
      allowedKinds: candidateAssurancePolicy.allowedValidationKinds
    });
    const compilation = compileCandidateAssuranceV1({
      candidate: currentCandidate,
      impact: input.impact,
      policy: candidateAssurancePolicy,
      implementationIdentity: input.implementationSelection?.logicalAgent ?? "<missing-implementation-identity>",
      risk: input.contract.routing?.risk ?? "low",
      reviewerCandidates: Object.values(input.reviewerSelections).map((selection) => ({
        identity: selection.logicalAgent,
        role: selection.role,
        provider: selection.modelProvider || selection.paseoProvider || selection.runtimeName,
        readOnly: selection.role === "Reviewer" && selection.permissions.write === "deny"
      })),
      baseValidationRequirements: [...input.baseValidationRequirements],
      validationResolution,
      acceptanceAssertions: (input.contract.requirements ?? []).map((requirement) => ({
        id: requirement.id,
        statement: requirement.description?.trim() || `Task requirement ${requirement.id} must be satisfied.`,
        requirementRefs: [requirement.id]
      }))
    });
    const validationChecks = compilation.status === "READY"
      ? await runCandidateImpactValidations({ root: input.root, config: input.config, contract: input.contract, report: input.report, impact: input.impact, compilation, resolution: validationResolution })
      : [];
    const validationFailed = validationChecks.some((check) => check.status !== "PASS");
    const gatePassed = compilation.status === "READY" && !validationFailed;
    const gateCheck: ValidationCheck = {
      id: "candidate.assurance.recompiled",
      category: "candidate-assurance",
      status: gatePassed ? "PASS" : "FAIL",
      message: gatePassed
        ? `Candidate assurance ${compilation.digest} is READY for candidate r${currentCandidate.revision}; required impact validations passed and ${compilation.reviewAssignments.length} independent Reviewer assignment(s) were compiled.`
        : compilation.status === "BLOCKED"
          ? `Candidate assurance is BLOCKED: ${compilation.blockers.join("; ")}`
          : "Candidate assurance is BLOCKED because at least one required impact validation did not PASS.",
      details: {
        candidate: compilation.candidate,
        impactDigest: compilation.impactDigest,
        policyDigest: compilation.policyDigest,
        assuranceDigest: compilation.digest,
        minimumAssurance: compilation.minimumAssurance,
        evidenceStrength: compilation.evidenceStrength,
        reviewAssignments: compilation.reviewAssignments,
        validationRequirementIds: compilation.validationRequirements.map((requirement) => requirement.id),
        blockers: compilation.blockers,
        validationChecks: validationChecks.map((check) => ({ id: check.id, status: check.status }))
      }
    };
    await recordEvent(input.stateRoot, input.config, "harness.candidate.assurance-recompiled", {
      taskId: input.contract.task.id,
      mechanism: "HYBRID",
      status: compilation.status,
      gate: gateCheck.status,
      candidate: compilation.candidate,
      impactDigest: compilation.impactDigest,
      policyDigest: compilation.policyDigest,
      assuranceDigest: compilation.digest,
      minimumAssurance: compilation.minimumAssurance,
      reviewAssignments: compilation.reviewAssignments,
      validationRequirements: compilation.validationRequirements,
      acceptanceAssertions: compilation.acceptanceAssertions,
      evidenceStrength: compilation.evidenceStrength,
      blockers: compilation.blockers,
      validationChecks: validationChecks.map((check) => ({ id: check.id, status: check.status, details: check.details }))
    });
    return { evaluation: { compilation, validationChecks, gateCheck }, policySource: policy };
  } catch (error) {
    const message = `Candidate assurance is BLOCKED by fail-closed recompilation: ${String(error)}`;
    await recordEvent(input.stateRoot, input.config, "harness.candidate.assurance-recompiled", {
      taskId: input.contract.task.id,
      mechanism: "HYBRID",
      status: "BLOCKED",
      gate: "FAIL",
      candidate: input.report.candidate,
      impactDigest: input.impact?.digest,
      error: String(error)
    }).catch(() => undefined);
    return { evaluation: failed(message, { candidate: input.report.candidate, impactDigest: input.impact?.digest, error: String(error) }), policySource: input.policySource };
  }
}

async function bindAssurancePolicyToCandidate(stateRoot: string, operationId: string, candidate: CandidateRevisionV1, source: ResolvedOperationPolicyV1): Promise<ResolvedOperationPolicyV1> {
  assertResolvedOperationPolicyV1(source);
  const operation = await loadOperation(stateRoot, operationId);
  if (operation.id !== candidate.operationId || !operation.candidateRevision
    || operation.candidateRevision.candidateId !== candidate.candidateId
    || operation.candidateRevision.revision !== candidate.revision
    || operation.candidateRevision.identityDigest !== candidate.identityDigest) {
    throw new Error("EXECUTION_POLICY_STALE: assurance policy cannot be rebound to a candidate that is not current for this operation.");
  }
  if (source.operationId !== operationId || source.projectId !== (candidate.projectId ?? source.projectId)) throw new Error("EXECUTION_POLICY_STALE: frozen assurance policy belongs to another operation or project.");
  const { version: _version, digest: _digest, ...policyBody } = source;
  const policy = compileResolvedOperationPolicy({
    ...policyBody,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(operation)
  });
  if (operation.resolvedOperationPolicy && operation.resolvedOperationPolicy.digest !== policy.digest) {
    throw new Error("EXECUTION_POLICY_STALE: the current candidate already has a different resolved policy; assurance cannot choose between policy identities.");
  }
  if (!operation.resolvedOperationPolicy) await bindResolvedOperationPolicy(stateRoot, operationId, policy);
  return policy;
}

function candidateAssurancePolicyFromFrozenPolicy(policy: ResolvedOperationPolicyV1): CandidateAssurancePolicyV1 {
  const review = policy.reviewPolicy && typeof policy.reviewPolicy === "object" ? policy.reviewPolicy as Record<string, unknown> : {};
  const validation = policy.validationPolicy && typeof policy.validationPolicy === "object" ? policy.validationPolicy as Record<string, unknown> : {};
  const minimumRank = { NONE: 0, STANDARD: 1, ELEVATED: 2, CRITICAL: 3 } as const;
  const minimumAssurance = policy.minimumAssurance;
  const impliedIndependentReview = minimumRank[minimumAssurance] >= minimumRank.ELEVATED;
  const independentReviewRequired = typeof review.independentReviewRequired === "boolean" ? review.independentReviewRequired : impliedIndependentReview;
  const configuredMinimum = review.minimumIndependentReviewers;
  if (configuredMinimum !== undefined && (!Number.isSafeInteger(configuredMinimum) || (configuredMinimum as number) < 0)) throw new Error("RESOLVED_OPERATION_POLICY_INVALID: reviewPolicy.minimumIndependentReviewers is invalid.");
  if (review.providerDiversity !== undefined && typeof review.providerDiversity !== "boolean") throw new Error("RESOLVED_OPERATION_POLICY_INVALID: reviewPolicy.providerDiversity is invalid.");
  const allowedValue = validation.allowedValidationKinds;
  let allowedValidationKinds = [...validationRequirementKindValues];
  if (allowedValue !== undefined) {
    if (!Array.isArray(allowedValue) || allowedValue.some((kind) => typeof kind !== "string" || !validationRequirementKindValues.includes(kind as (typeof validationRequirementKindValues)[number]))) {
      throw new Error("RESOLVED_OPERATION_POLICY_INVALID: validationPolicy.allowedValidationKinds contains an unsupported value.");
    }
    allowedValidationKinds = [...new Set(allowedValue as (typeof validationRequirementKindValues)[number][])];
  }
  const evidenceStrength = typeof review.evidenceStrength === "string" && review.evidenceStrength in minimumRank
    ? review.evidenceStrength as CandidateAssurancePolicyV1["evidenceStrength"]
    : minimumAssurance;
  return {
    version: 1,
    digest: policy.digest,
    minimumAssurance,
    independentReviewRequired,
    minimumIndependentReviewers: configuredMinimum as number | undefined ?? (independentReviewRequired ? 1 : 0),
    providerDiversity: review.providerDiversity === true,
    allowedValidationKinds,
    evidenceStrength
  };
}

async function runCandidateImpactValidations(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  report: ValidationReport;
  impact: CandidateImpactV1;
  compilation: CandidateAssuranceCompilationV1;
  resolution: ValidationResolutionV1;
}): Promise<ValidationCheck[]> {
  const requirements = candidateImpactValidationRequirementsV1(input.impact);
  const actionById = new Map(input.resolution.actions.map((action) => [action.requirementId, action]));
  const executedActions = new Map<string, ValidationCheck>();
  let configuredValidatorChecks: ValidationCheck[] | undefined;
  const output: ValidationCheck[] = [];
  for (const requirement of requirements) {
    const action = actionById.get(requirement.id);
    let execution: ValidationCheck | undefined;
    try {
      if (!action || action.kind !== requirement.kind) throw new Error("resolved action is missing or does not match the compiled requirement kind");
      const actionKey = `${action.source}\0${action.selector}\0${action.command ?? ""}\0${action.provider ?? ""}`;
      execution = executedActions.get(actionKey);
      if (!execution) {
        if ((action.source === "project-script" || action.source === "configured-command") && action.command) {
          const command: ValidationCommand = { id: `candidate-impact-${requirement.id}`, command: action.command, required: true };
          execution = await runValidationCommand(input.root, command);
        } else if (action.source === "configured-validator") {
          configuredValidatorChecks ??= await runConfiguredValidators(input.root, input.config, input.contract, input.report.metadata.baseRef, input.report.changedFiles);
          execution = configuredValidatorChecks.find((check) => check.id === action.selector);
          if (!execution) throw new Error(`configured validator '${action.selector}' produced no validation check`);
        } else if (action.source === "approved-provider") {
          const provider = input.config.validation?.providers?.find((candidate) => candidate.id === action.selector || candidate.provider === action.provider || candidate.provider === action.selector);
          if (action.command) {
            execution = await runValidationCommand(input.root, { id: `candidate-impact-${requirement.id}`, command: action.command, required: true });
          } else {
            const adapter = candidateAssuranceProviderAdapterV1(action.kind, action.provider ?? "");
            if (adapter) {
              execution = await runExternalToolValidator({
                root: input.root,
                config: input.config,
                contract: input.contract,
                spec: { id: `candidate-impact-${requirement.id}`, adapter, required: true, timeoutSeconds: provider?.timeoutSeconds, options: provider?.options },
                providerSpec: provider,
                baseRef: input.report.metadata.baseRef,
                changedFiles: input.report.changedFiles
              });
            } else if (["unit-test", "integration-test", "bdd", "contract-test"].includes(action.kind)) {
              const spec: ValidatorSpec = {
                id: `candidate-impact-${requirement.id}`,
                adapter: action.kind === "bdd" ? "bdd" : action.kind === "contract-test" ? "contract-test" : action.kind === "integration-test" ? "integration-environment" : "test-execution",
                required: true,
                options: { ...(action.provider ? { provider: action.provider } : {}) }
              };
              const context: ValidationProviderContext = {
                root: input.root,
                config: input.config,
                contract: input.contract,
                capability: action.kind,
                spec,
                providerSpec: provider ?? providerSpecFor(input.config, action.kind, spec),
                rawArtifactDirectory: path.resolve(input.root, input.config.evidence?.outputDir ?? ".harness/evidence", "raw"),
                baseRef: input.report.metadata.baseRef
              };
              execution = await runCapabilityValidator(context, spec.id, action.kind, true);
            } else {
              throw new Error(`approved provider '${action.provider ?? action.selector}' has no safe executor for '${action.kind}' and no explicit command`);
            }
          }
        }
        if (!execution) throw new Error("resolved validation action has no executable implementation");
        executedActions.set(actionKey, execution);
      }
      output.push({
        id: `candidate.assurance.validation.${requirement.id}`,
        category: "candidate-impact-validation",
        status: execution.status === "PASS" ? "PASS" : "FAIL",
        message: execution.status === "PASS" ? `Required ${requirement.kind} evidence passed: ${requirement.property}` : `Required ${requirement.kind} validation for impact requirement '${requirement.id}' returned ${execution.status}.`,
        durationMs: execution.durationMs,
        details: { requirementId: requirement.id, kind: requirement.kind, selector: action.selector, source: action.source, underlyingCheckId: execution.id, underlyingStatus: execution.status, candidate: input.compilation.candidate, impactDigest: input.compilation.impactDigest, policyDigest: input.compilation.policyDigest }
      });
    } catch (error) {
      output.push({
        id: `candidate.assurance.validation.${requirement.id}`,
        category: "candidate-impact-validation",
        status: "FAIL",
        message: `Required validation for impact requirement '${requirement.id}' did not produce evidence: ${String(error)}`,
        details: { requirementId: requirement.id, kind: requirement.kind, candidate: input.compilation.candidate, impactDigest: input.compilation.impactDigest, policyDigest: input.compilation.policyDigest }
      });
    }
  }
  return output;
}

async function resolveExecutionBoundary(root: string, config: HarnessProjectConfig, contract: TaskContract, profileOverride?: string): Promise<FrozenExecutionBoundaryV1> {
  if (!config.agents) return {};
  const explicitProfile = profileOverride ?? contract.routing?.profile;
  const profile = explicitProfile ?? config.agents.activeProfile;
  try {
    const audit = await auditAgentTopology(root, config, profile, { checkGenerated: !explicitProfile });
    if (!audit.ok) throw new Error(`Agent topology audit failed:\n${audit.checks.filter((check) => check.status === "FAIL").map((check) => `- ${check.id}: ${check.message}`).join("\n")}`);
    const topology = await loadResolvedAgentTopology(root, config, profile);
    const { route, selection } = selectExecutionForTask(topology, contract);
    const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
    const issues = validateExecutionCapabilities(selection, transport);
    if (issues.length) throw new Error(`Selected agent ${selection.logicalAgent} is not executable: ${issues.join("; ")}`);
    await recordEvent(root, config, "harness.agent.route", { taskId: contract.task.id, profile, agent: selection.logicalAgent, runtime: selection.runtimeName, model: selection.modelId, nativeAgent: selection.nativeAgent, transport, ruleIds: route.ruleIds, reviewers: route.reviewers, implementationRoute: route.implementationRoute, assurance: route.assurance });
    const configuredPlanner = config.workflow?.planning?.plannerAgent;
    const plannerAgent = configuredPlanner && topology.agents[configuredPlanner] && !topology.agents[configuredPlanner].disabled
      ? configuredPlanner
      : Object.values(topology.agents).find((agent) => agent.role === "Planner" && !agent.disabled)?.name;
    const plannerSelection = plannerAgent ? executionSelectionForAgent(topology, plannerAgent) : undefined;
    const librarianAgent = Object.values(topology.agents).find((agent) => agent.role === "Librarian" && !agent.disabled);
    const librarianSelection = librarianAgent ? executionSelectionForAgent(topology, librarianAgent.name) : undefined;
    const supervisorAgent = topology.agents["operation-supervisor"];
    const supervisorSelection = supervisorAgent && !supervisorAgent.disabled ? executionSelectionForAgent(topology, "operation-supervisor") : undefined;
    const configuredReviewerNames = [...new Set([
      ...route.reviewers,
      ...Object.values(topology.agents).filter((agent) => agent.role === "Reviewer" && !agent.disabled).map((agent) => agent.name)
    ])].sort();
    const reviewerSelections = Object.fromEntries(configuredReviewerNames.map((name) => [name, executionSelectionForAgent(topology, name)]));
    const leadAgent = Object.values(topology.agents).find((agent) => agent.role === "Lead/Director" && !agent.disabled);
    const leadSelection = leadAgent ? executionSelectionForAgent(topology, leadAgent.name) : undefined;
    const repairerAgent = selectAgentNames(topology, { role: "Repairer" }, 1)[0];
    const repairerSelection = repairerAgent ? executionSelectionForAgent(topology, repairerAgent) : undefined;
    const stageSelections = Object.fromEntries(escalationStages(config).map((stage) => {
      try {
        const roleSelection = stage.role ? selectAgentNames(topology, { role: stage.role }, 1)[0] : undefined;
        const roleExecution = roleSelection ? executionSelectionForAgent(topology, roleSelection) : undefined;
        const modelExecution = stage.model ? selectionWithModelOverride(topology, roleExecution ?? selection, stage.model) : undefined;
        return [stage.name, selectionForStage(selection, stage, roleExecution, modelExecution)];
      }
      catch { return [stage.name, undefined]; }
    }));
    const roleBindings = {
      Implementer: bindingForSelection(selection),
      ...(repairerSelection ? { Repairer: bindingForSelection(repairerSelection) } : {})
    };
    const executionCatalog = compileExecutionCatalog({ runtimes: topology.runtimes, models: topology.models, routeRuleIds: topology.routing.map((rule) => rule.id), roleBindings, policy: { maxConcurrent: config.workflow?.planning?.maxWaveConcurrency } });
    return { route, selection, plannerSelection, librarianSelection, supervisorSelection, reviewerSelections, leadSelection, repairerSelection, stageSelections, executionCatalog, recovery: topology.recovery };
  } catch (error) {
    if (config.agents.required || contract.routing?.route === "DELEGATED" || contract.routing?.route === "FORMAL_SDD" || contract.routing?.assurance === "CRITICAL") throw error;
    await recordEvent(root, config, "harness.agent.topology-fallback", { taskId: contract.task.id, error: String(error) });
    return {};
  }
}

function bindingForSelection(selection: AgentExecutionSelection) {
  return {
    runtimeId: selection.runtimeName,
    modelAlias: selection.modelAlias,
    transport: selection.transport,
    profile: selection.profile,
    variant: selection.variant,
    nativeAgent: selection.nativeAgent,
    temperature: selection.temperature,
    outputContract: selection.outputContract,
    args: [...selection.args]
  };
}

function withWorkerExecutionCheck(report: ValidationReport, worker: WorkerSession): ValidationReport {
  const checks = report.checks.filter((check) => check.id !== "agent.execution");
  checks.unshift({ id: "agent.execution", category: "agent-runtime", status: worker.exitCode === 0 ? "PASS" : "FAIL", message: worker.exitCode === 0 ? `Agent ${worker.logicalAgent ?? worker.provider} completed successfully.` : `Agent runtime exited with code ${worker.exitCode}.`, details: worker.exitCode === 0 ? undefined : { stderr: worker.stderr.slice(-4000), stdout: worker.stdout.slice(-4000), logicalAgent: worker.logicalAgent, runtime: worker.runtime, model: worker.model } });
  return { ...report, checks, status: checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS" };
}

function mergeChecks(report: ValidationReport, extra: ValidationCheck[]): ValidationReport {
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  for (const check of extra) byId.set(check.id, check);
  const checks = [...byId.values()];
  return { ...report, checks, status: checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS" };
}

async function verifyAfterWorker(workspaceRoot: string, controlRoot: string, config: HarnessProjectConfig, contract: TaskContract, controller?: ControlPlaneSnapshot, selection?: AgentExecutionSelection): Promise<ValidationReport> {
  await refreshGraphIfConfigured(workspaceRoot, config);
  const afterSnapshot = await snapshotGraph(workspaceRoot, config, contract.task.id, "after");
  if (!afterSnapshot && config.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify after snapshot could not be created.");
  const operation = currentOperationContext();
  return verifyTask(workspaceRoot, config, contract, { stateRoot: controlRoot, policyRoot: controller?.materializedRoot ?? controlRoot, executionIdentity: selection ? { operationId: operation.id, operationKind: operation.kind, logicalAgent: selection.logicalAgent, role: selection.role, profile: selection.profile, domains: selection.domains, runtime: selection.runtimeName, modelAlias: selection.modelAlias, permissions: selection.permissions, risk: contract.routing?.risk } : undefined });
}

async function refreshGraphIfConfigured(root: string, config: HarnessProjectConfig): Promise<void> {
  if (config.codeIntelligence?.provider !== "graphify") return;
  const provider = new (await import("../providers/graphify.js")).GraphifyCodeIntelligenceProvider(config);
  try { await provider.refresh(root); }
  catch (error) { if (config.codeIntelligence.required) throw error; await recordEvent(root, config, "harness.graphify.refresh-failed", { error: String(error) }); }
}

async function runStage(
  stateRoot: string,
  operationId: string,
  name: string,
  status: "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED",
  options: { message?: string; artifact?: string } = {}
): Promise<void> {
  await setOperationStage(stateRoot, operationId, name, status, options);
}
