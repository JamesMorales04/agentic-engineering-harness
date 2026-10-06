import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection, PermissionDecision } from "./types.js";
import { planParallelism, type ParallelismPlan } from "./parallelism.js";
import { knowledgePackOutputSchema, plannerOutputSchema, type PlannerOutput, type WorkUnitOutput } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { validateExecutionCapabilities } from "./permissions.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import { materializeControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport, WorkerSession } from "../core/types.js";
import { executeAgentPrompt, prepareAgentExecutionIdentity } from "../workers/agentPrompt.js";
import { dispatchDistributedDelegation } from "../distributed/worker.js";
import { enforceSandboxPolicy } from "../security/sandbox.js";
import { runExecutable } from "../utils/process.js";
import { recordEvent } from "../telemetry/events.js";
import { existingRepositoryPath, repositoryPath } from "../utils/repositoryPath.js";
import { compileExecutionBlueprint, type ExecutionBlueprint, type ParticipantAssignmentV1 } from "../architecture/participantPlan.js";
import { createWorkGraph } from "../architecture/workGraph.js";
import { bindOperationExecutionSemantics, bindResolvedOperationPolicy, currentOperationContext, loadOperation } from "../operations/state.js";
import { compileResolvedOperationPolicy } from "../architecture/executionIdentity.js";
import { configuredDeliveryPolicy, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CapabilityRegistryV1 } from "../capabilities/registry.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1, CandidateScopeEscapeV1, ChangeSetV1 } from "../candidates/assembler.js";
import { materializeCandidateState } from "../candidates/direct.js";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../candidates/wave.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { FileKnowledgeCacheV1, resolveKnowledgeGate, validateKnowledgePack, type KnowledgeCacheV1, type KnowledgeLookupResultV1, type KnowledgeModeV1, type KnowledgePackV1, type KnowledgeResolutionV1 } from "../knowledge/index.js";
import { defaultSkillSeed } from "../participants/index.js";
import { dropUnresolvablePlanValidationRequirementsV1, resolveValidationRequirements, type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
import { compilePlannerWorkGraphWithOneCorrection, PlannerWorkGraphCorrectionError } from "./plannerWorkGraphCorrection.js";
import {
  DEFAULT_OPERATION_RESOURCE_POLICY,
  PROVIDER_BACKPRESSURE_EVENT_V1,
  acquireDurableWaveSlotOrQueue,
  isProviderCapacityError,
  providerBackpressureAttributes,
  releaseDurableWaveSlot,
  waitForProviderSessionCapacity
} from "../runtime/operationResources.js";
import {
  RuntimeSupervisorV1,
  isProviderLeaseConflictError,
  providerLeaseBackpressureSignal,
  providerLeaseQueueWaitMs,
  type ProviderLeaseQueuedV1
} from "../runtime/supervisorV2.js";
import { frozenOperationHardDeadlineAt } from "../operations/state.js";
import { isProviderRateLimited, parseProviderRateLimitDetail } from "../paseo/sdk.js";

export interface DelegationExecutionResult { task: WorkUnitOutput; session: WorkerSession; changedFiles: string[]; patch: string; status: "PASS" | "FAIL"; message?: string; distributed?: boolean; candidate?: CandidateRevisionV1; impact?: CandidateImpactV1; changeSet?: ChangeSetV1; }
export interface WaveExecutionSummary { wave: number; taskIds: string[]; status: "PASS" | "FAIL"; results: DelegationExecutionResult[]; barrier?: ValidationReport; }
export interface PlannerWaveResult { used: boolean; plan?: PlannerOutput; blueprint?: ExecutionBlueprint; schedule?: ParallelismPlan; waves: WaveExecutionSummary[]; sessions: WorkerSession[]; aggregateSession?: WorkerSession; report?: ValidationReport; preExecutionFailure?: boolean; correctionAttempts?: 0 | 1; }

export async function executePlannerWaves(input: { root: string; stateRoot: string; config: HarnessProjectConfig; contract: TaskContract; plannerSelection?: AgentExecutionSelection; librarianSelection?: AgentExecutionSelection; implementationSelection: AgentExecutionSelection; executionCatalog: ExecutionCatalogV1; capabilityRegistry: CapabilityRegistryV1; controller?: ControlPlaneSnapshot; precomputedPlan?: PlannerOutput; semanticAssessment?: CandidateImpactAssessmentRuntimeV1; projectStack?: ProjectStackProfileV1; knowledgeMode?: KnowledgeModeV1; knowledgeCache?: KnowledgeCacheV1; knowledgeResolutions?: readonly KnowledgeResolutionV1[]; knowledgeLookup?: (gap: Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>; revalidate: () => Promise<ValidationReport>; onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void }): Promise<PlannerWaveResult> {
  const planning = input.config.workflow?.planning;
  if (planning?.enabled === false || input.contract.routing?.route === "DIRECT" || input.contract.routing?.route === "NO_AGENT") return { used: false, waves: [], sessions: [] };
  if (!input.precomputedPlan && !input.plannerSelection) return { used: false, waves: [], sessions: [] };
  const sessions: WorkerSession[] = [];
  let plan: PlannerOutput;
  if (input.precomputedPlan) {
    try { plan = plannerOutputSchema.parse(input.precomputedPlan); }
    catch (error) { return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Invalid Planner output schema: ${String(error)}`) }; }
  } else {
    const plannerSession = await executeAgentPrompt(input.root, input.config, input.contract, input.plannerSelection!, buildPlannerPrompt(input.contract), { outputContract: "planner", phase: "planning", requireExecutionAuthority: true });
    sessions.push(plannerSession);
    if (plannerSession.exitCode !== 0) return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, "Planner runtime failed.") };
    try { plan = plannerOutputSchema.parse(extractMarkedJson(plannerSession.stdout, plannerSession.stderr)); } catch (error) { return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Invalid planner output: ${String(error)}`) }; }
  }
  const planIssues = validatePlannerWavePlan(input.contract, plan);
  if (planIssues.length) return { used: true, plan, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${planIssues.join("; ")}`) };
  if (!plan.workUnits.length) return { used: false, plan, waves: [], sessions };
  let blueprint: ExecutionBlueprint;
  let graph: ReturnType<typeof createWorkGraph>;
  let validationResolution: ValidationResolutionV1;
  let knowledgeResolutions: KnowledgeResolutionV1[] = [];
  let operation: Awaited<ReturnType<typeof loadOperation>> | undefined;
  let correctionAttempts: 0 | 1 = 0;
  try {
    const validatedPlan = await compilePlannerWorkGraphWithOneCorrection({
      contract: input.contract,
      plan,
      requestCorrection: input.plannerSelection ? async (correctionPrompt) => {
        const correctionSession = await executeAgentPrompt(input.root, input.config, input.contract, input.plannerSelection!, correctionPrompt, { outputContract: "planner", phase: "planning", requireExecutionAuthority: true });
        sessions.push(correctionSession);
        if (correctionSession.exitCode !== 0) throw new Error(`corrective Planner runtime failed with exit code ${correctionSession.exitCode}`);
        return extractMarkedJson(correctionSession.stdout, correctionSession.stderr);
      } : undefined
    });
    plan = validatedPlan.plan;
    graph = validatedPlan.graph;
    correctionAttempts = validatedPlan.correctionAttempts;
    knowledgeResolutions = await resolvePlannerKnowledge(plan, input);
    const operationContext = currentOperationContext();
    operation = operationContext.id ? await loadOperation(input.stateRoot, operationContext.id) : undefined;
    const candidateRevision = operation?.candidateRevision;
    const controllerEpoch = operation?.controller?.epoch;
    if (!candidateRevision || typeof controllerEpoch !== "number" || !Number.isSafeInteger(controllerEpoch) || controllerEpoch < 0 || operation?.operationExecutionRevision === undefined) {
      throw new AehError("EXECUTION_BLUEPRINT_INVALID", "A managed CandidateRevision and controller epoch are required before compiling an execution blueprint.");
    }
    validationResolution = await resolveValidationRequirements({ root: input.root, requirements: plan.validationRequirements, config: input.config, contract: input.contract, projectStack: input.projectStack });
    // A planner-declared validation requirement that no approved project script, configured
    // command, validator, or provider can resolve is advisory plan intent, not a frozen gate. The
    // frozen contract's own validators are compiled and enforced independently, so an unresolvable
    // advisory requirement must not reject the whole participant plan before implementation (it is
    // not repairable by any implementation change). Drop it with a durable deterministic record and
    // keep the resolvable subset; a genuine inconsistency between the remaining set still fails
    // closed below.
    if (validationResolution.blocked.length) {
      const partition = dropUnresolvablePlanValidationRequirementsV1(plan.validationRequirements, validationResolution);
      await recordEvent(input.stateRoot, input.config, "harness.plan.validation-requirements-dropped", { taskId: input.contract.task.id, dropped: partition.dropped.map((requirement) => ({ id: requirement.id, kind: requirement.kind })), reasons: validationResolution.blocked });
      plan = { ...plan, validationRequirements: partition.kept };
      validationResolution = await resolveValidationRequirements({ root: input.root, requirements: plan.validationRequirements, config: input.config, contract: input.contract, projectStack: input.projectStack });
      if (validationResolution.blocked.length) throw new AehError("VALIDATION_REQUIREMENT_BLOCKED", validationResolution.blocked.map((item) => `${item.requirementId}: ${item.reason}`).join("; "), { details: { validationResolution } });
    }
    const executionSemanticsDigest = sha256Canonical({ workGraph: graph, plannerPlan: plan, executionCatalogDigest: input.executionCatalog.digest, validationResolution, knowledge: knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), contextPolicy: input.config.context ?? null });
    operation = await bindOperationExecutionSemantics(input.stateRoot, operation!.id, executionSemanticsDigest);
  blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry: input.capabilityRegistry, plan });
  } catch (error) {
    const failedCorrectionAttempts = error instanceof PlannerWorkGraphCorrectionError ? error.correctionAttempts : correctionAttempts;
    return { used: true, plan, waves: [], sessions, preExecutionFailure: true, correctionAttempts: failedCorrectionAttempts, aggregateSession: aggregate(sessions, 1, `Participant plan rejected: ${String(error)}`) };
  }
  const schedule = await planParallelism(input.root, input.config, input.contract.task.id, plan.workUnits);
  const worktreeIsolation = planning?.worktreeIsolation !== false;
  await recordEvent(input.stateRoot, input.config, "harness.plan.ready", { taskId: input.contract.task.id, workUnits: plan.workUnits.length, waves: schedule.waves.length, conflicts: schedule.conflicts.length, graphUsed: schedule.graphUsed, compilerDigest: blueprint.plan.compilerDigest, worktreeIsolation, distributed: planning?.distributed === true && input.config.distributed?.enabled === true });
  const waveSummaries: WaveExecutionSummary[] = []; let finalReport: ValidationReport | undefined; let currentCandidate = operation?.candidateRevision;
  for (let index = 0; index < schedule.waves.length; index += 1) {
    if (index > 0 && graph && operation) {
      try {
        operation = await loadOperation(input.stateRoot, operation.id);
        currentCandidate = operation.candidateRevision;
        if (!currentCandidate) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate is required to recompile the next wave identity.");
        blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry: input.capabilityRegistry, plan });
      } catch (error) {
        const summary: WaveExecutionSummary = { wave: index + 1, taskIds: schedule.waves[index]!, status: "FAIL", results: [] };
        waveSummaries.push(summary);
        return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Next wave execution identity could not be recompiled: ${String(error)}`) };
      }
    }
    const ids = schedule.waves[index]; const tasks = ids.map((id) => plan.workUnits.find((task) => task.id === id)!).filter(Boolean);
    const participantByWorkUnit = new Map<string, ParticipantAssignmentV1>();
    for (const assignment of blueprint.plan.assignments as ParticipantAssignmentV1[]) for (const workUnitId of assignment.workUnitIds) participantByWorkUnit.set(workUnitId, assignment);
    if (!currentCandidate || !operation?.id) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results: [] }; waveSummaries.push(summary); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, "Candidate assembly requires a managed operation candidate.") }; }
    const waveOperationId = operation.id;
    const waveBlueprint = blueprint;
    const waveBase = createWaveBase({ operationId: waveOperationId, taskId: input.contract.task.id, waveIndex: index, candidate: currentCandidate });
    const concurrency = waveConcurrencyV1(planning, tasks.length);
    if (tasks.length > concurrency || (planning?.maxWaveConcurrency ?? 0) > WAVE_CONCURRENCY_LEASE_CAP_V1) {
      await recordEvent(input.stateRoot, input.config, WAVE_BACKPRESSURE_EVENT_V1, waveBackpressureAttributes({ wave: index + 1, taskId: input.contract.task.id, active: tasks.length, ceiling: WAVE_CONCURRENCY_LEASE_CAP_V1, queued: Math.max(0, tasks.length - concurrency), retryAfterMs: 0, disposition: "CLAMPED" }));
    }
    // Operation-wide provider-session QUEUE gate (durable equivalent of
    // tryAcquireProviderLease; production caller of waitForProviderSessionCapacity).
    // Luna F1: bounded WAIT against the wave's EXISTING budget — WAIT =
    // min(requested 30s, remaining wave/operation budget) when a finite frozen
    // Owner hard deadline exists; when none can be established (undefined),
    // mint NO fresh 30s (single immediate check only: headroom proceeds,
    // saturation is terminal FAIL with zero sleeps, fail-closed).
    // MECHANISM: DETERMINISTIC. Wave budget deadline = min(now + 30s, frozen
    // Owner hard deadline) when present, else undefined (no fresh); threaded
    // as deadlineAtMs so the wait never extends caps. Deterministic clocks via
    // pure helpers (tests pin it).
    const waveStartedAtMs = Date.now();
    const operationDeadlineAtMs = operation ? frozenOperationHardDeadlineAt(operation) : undefined;
    const waveCapacityDeadlineAtMs = resolveWaveCapacityDeadlineAtMs(waveStartedAtMs, operationDeadlineAtMs, WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
    const capacity = await waitForProviderSessionCapacity(input.stateRoot, waveOperationId, {
      ceiling: WAVE_CONCURRENCY_LEASE_CAP_V1,
      maxWaitMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
      deadlineAtMs: waveCapacityDeadlineAtMs,
      pollMs: 50
    });
    if (!capacity.acquired) {
      await recordEvent(input.stateRoot, input.config, WAVE_BACKPRESSURE_EVENT_V1, waveBackpressureAttributes({ wave: index + 1, taskId: input.contract.task.id, active: capacity.active, ceiling: capacity.ceiling, queued: tasks.length, retryAfterMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, disposition: "QUEUE" }));
      // Observation-only provider backpressure telemetry via existing conventions
      // (production caller of providerBackpressureAttributes + providerLeaseBackpressureSignal;
      // never a gate).
      const providerSignal = providerLeaseBackpressureSignal(capacity.active, tasks.length, capacity.ceiling);
      await recordEvent(
        input.stateRoot,
        input.config,
        PROVIDER_BACKPRESSURE_EVENT_V1,
        providerBackpressureAttributes({
          operationId: waveOperationId,
          active: providerSignal.active,
          ceiling: providerSignal.ceiling ?? capacity.ceiling,
          queued: providerSignal.queued,
          retryAfterMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
          disposition: "QUEUE"
        })
      ).catch(() => undefined);
      const summary: WaveExecutionSummary = {
        wave: index + 1,
        taskIds: ids,
        status: "FAIL",
        results: tasks.map((task) => ({
          task,
          session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: `WAVE_QUEUE_EXHAUSTED: operation ${waveOperationId} holds ${capacity.active}/${capacity.ceiling} provider sessions; QUEUE budget exhausted.` },
          changedFiles: [],
          patch: "",
          status: "FAIL" as const,
          message: `WAVE_QUEUE_EXHAUSTED: operation ${waveOperationId} holds ${capacity.active}/${capacity.ceiling} provider sessions; QUEUE budget exhausted.`
        }))
      };
      waveSummaries.push(summary);
      await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids });
      return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} provider capacity QUEUE exhausted.`) };
    }
    // Per-workspace write-lease admission (Luna F2+F3: SHARED durable atomic
    // acquire, not wave-local check-then-proceed; non-throwing QUEUE, never
    // throw-on-conflict on the wired path). Isolated tasks use distinct
    // workspace keys (ACQUIRED); shared-workspace waves share one key (second
    // writer QUEUES, serializing to 1). The durable atomic acquire
    // (`acquireWaveProviderSlotSharedOrQueue` → `acquireDurableWaveSlotOrQueue`
    // file-locked transact, same store/predicate as `acquireProviderLease`)
    // sees cross-wave/operation/process contention end-to-end (acquire-or-wait-
    // or-fail, never both proceed). Residual 429/lease conflicts RETRY via
    // bounded `withWaveBackpressureRetry` within the REMAINING wave budget
    // (Luna F1: WAIT is not an attempt; exhaustion terminal; never a fresh 30s
    // unbounded by the wave/operation deadline).
    const waveProjectId = input.config.project.name;
    // Luna F1 (continued): per-slot retries share the wave's remaining budget,
    // not a fresh 30s. Remaining = waveCapacityDeadline - now (0/undefined →
    // terminal, no fresh). Undefined deadline means no wait budget (immediate).
    const waveSlotTimeoutMs = Math.max(0, remainingWaveBudgetMs(waveCapacityDeadlineAtMs, Date.now()));
    const executeWithQueue = (task: (typeof tasks)[number]): Promise<DelegationExecutionResult> =>
      withWaveBackpressureRetry(
        async (remaining) => {
          const isolated = planning?.worktreeIsolation !== false;
          const workspaceId = isolated ? `wave:${waveOperationId}:${index}:${task.id}` : `wave:${waveOperationId}:${index}`;
          const slot = await acquireWaveProviderSlotSharedOrQueue(
            input.stateRoot,
            { provider: "wave", projectId: waveProjectId, canonicalRoot: input.root, workspaceId, ownerId: task.id, mode: "write" },
            {
              ...(remaining !== undefined ? { remainingBudgetMs: remaining } : { remainingBudgetMs: 0 }),
            }
          );
          if (!slot.acquired) {
            // QUEUE budget exhausted for this slot → terminal FAIL (fail-closed, never throw).
            return {
              task,
              session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: `WAVE_QUEUE_EXHAUSTED: provider wave already leased (depth ${slot.queueDepth}); QUEUE budget exhausted.` },
              changedFiles: [],
              patch: "",
              status: "FAIL" as const,
              message: `WAVE_QUEUE_EXHAUSTED: provider wave is already leased in ${workspaceId} (depth ${slot.queueDepth}); QUEUE budget exhausted.`
            };
          }
          try {
            const result = await executeDelegation({ ...input, operationId: waveOperationId, task, participantAssignment: participantByWorkUnit.get(task.id), executionBlueprint: waveBlueprint, waveBase: waveBase.candidate });
            // Residual backpressure surfaced as FAIL message QUEUES (not terminal FAIL):
            // throw to trigger WAIT+RETRY within budget; exhaustion rethrows as FAIL below.
            // shouldQueueWaveWork is the wave QUEUE gate (alias of isWaveBackpressureError).
            if (result.status === "FAIL" && result.message && shouldQueueWaveWork(result.message)) {
              throw new Error(result.message);
            }
            return result;
          } finally {
            // Release durable wave slot for the next QUEUED waiter (best-effort
            // atomic release under the same snapshot lock; never fails delegation).
            // LeaseId is present on ACQUIRED (atomic path); missing means nothing to release.
            try {
              if (slot.leaseId) await releaseDurableWaveSlot(input.stateRoot, slot.leaseId, task.id);
            } catch { /* best-effort slot release never fails the delegation */ }
          }
        },
        { timeoutMs: waveSlotTimeoutMs }
      ).catch((error) => {
        // Exhausted QUEUE budget or terminal non-backpressure failure → FAIL (never throw).
        if (shouldQueueWaveWork(error)) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            task,
            session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: message.slice(0, 500) },
            changedFiles: [],
            patch: "",
            status: "FAIL" as const,
            message: message.slice(0, 500)
          };
        }
        throw error;
      });
    const results = await mapLimit(tasks, concurrency, executeWithQueue); sessions.push(...results.map((result) => result.session));
    if (results.some((result) => result.status === "FAIL")) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids }); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} failed.`) }; }
    const resultByWorkUnit = new Map(results.map((result) => [result.task.id, result] as const));
    const submissions: WaveChangeSetSubmissionV1[] = [];
    for (const result of results) {
      if (!result.changeSet) continue;
      submissions.push({
        workUnitId: result.task.id,
        changeSet: result.changeSet,
        allowedScope: result.task.scope,
        resourceClaims: result.task.resourceClaims ?? []
      });
    }
    if (submissions.length) {
      const integration = await integrateWaveChangeSets({ root: input.root, stateRoot: input.stateRoot, operationId: operation.id, taskId: input.contract.task.id, wave: waveBase, submissions, semanticAssessment: input.semanticAssessment, ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {}) });
      for (const step of integration.integrated) {
        const result = resultByWorkUnit.get(step.workUnitId);
        if (result) { result.candidate = step.candidate; result.impact = step.impact; }
        await recordEvent(input.stateRoot, input.config, "harness.candidate.assembled", { taskId: input.contract.task.id, workUnitId: step.workUnitId, participantId: step.changeSet.participantId, candidateRevision: step.candidate.revision, candidateDigest: step.candidate.sourceDigest, impactDigest: step.impact.digest, changeKinds: step.impact.changeKinds, reviewDimensions: step.impact.reviewDimensions, requiresIndependentReview: step.impact.requiresIndependentReview, waveBaseRevision: waveBase.candidate.revision, derivedRebase: step.derived });
      }
      for (const requirement of integration.reconciliationRequired) {
        const result = resultByWorkUnit.get(requirement.workUnitId);
        if (result) { result.status = "FAIL"; result.message = `WAVE_RECONCILIATION_REQUIRED: ${requirement.reason}`; }
      }
      const last = integration.integrated.at(-1);
      if (last) currentCandidate = last.candidate;
    }
    if (results.some((result) => result.status === "FAIL")) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids, reconciliationRequired: results.filter((result) => result.message?.startsWith("WAVE_RECONCILIATION_REQUIRED")).map((result) => result.task.id) }); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} candidate assembly failed.`) }; }
    finalReport = planning?.barrierValidation === false ? undefined : await input.revalidate(); const status = finalReport?.status === "FAIL" ? "FAIL" : "PASS"; const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status, results, barrier: finalReport }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status, tasks: ids, checks: finalReport?.checks.length }); if (status === "FAIL") return { used: true, plan, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} deterministic barrier failed.`), report: finalReport };
  }
  finalReport ??= await input.revalidate(); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, finalReport.status === "PASS" ? 0 : 1, `Executed ${plan.workUnits.length} work unit(s) across ${schedule.waves.length} wave(s).`), report: finalReport, correctionAttempts };
}

export async function resolvePlannerKnowledge(plan: PlannerOutput, input: Pick<Parameters<typeof executePlannerWaves>[0], "contract" | "root" | "config" | "librarianSelection" | "knowledgeMode" | "knowledgeCache" | "knowledgeResolutions" | "knowledgeLookup"> & Partial<Pick<Parameters<typeof executePlannerWaves>[0], "stateRoot">>): Promise<KnowledgeResolutionV1[]> {
  const knownCompetencies = [...new Set(defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)))];
  const provided = [...(input.knowledgeResolutions ?? [])];
  const providedByCompetency = new Map(provided.flatMap((resolution) => resolution.acceptedSkill ? [[resolution.acceptedSkill.competency, resolution] as const] : []));
  const cache = input.knowledgeCache ?? (input.stateRoot ? new FileKnowledgeCacheV1(path.join(input.stateRoot, ".harness", "cache", "knowledge-v1")) : undefined);
  const resolutions: KnowledgeResolutionV1[] = [...provided];
  const required = [...new Set(plan.workUnits.flatMap((unit) => unit.competencies))].sort();
  for (const competency of required) {
    if (knownCompetencies.includes(competency) || providedByCompetency.has(competency)) continue;
    const resolution = await resolveKnowledgeGate({
      requiredCompetencies: [competency],
      knownCompetencies,
      mode: input.knowledgeMode ?? "TRUSTED_DISCOVERY",
      cache,
      lookup: input.knowledgeLookup ?? (input.librarianSelection ? (gap) => lookupWithLibrarian(input, gap) : undefined)
    });
    if (resolution.gate !== "SUFFICIENT") throw new AehError("KNOWLEDGE_GAP_BLOCKED", `knowledge gate could not establish trusted knowledge for '${competency}'.`, { details: { competency, gap: resolution.gap } });
    resolutions.push(resolution);
    if (resolution.acceptedSkill) providedByCompetency.set(resolution.acceptedSkill.competency, resolution);
  }
  return [...new Map(resolutions.map((resolution) => [resolution.acceptedSkill?.competency ?? resolution.pack?.packDigest ?? JSON.stringify(resolution), resolution])).values()];
}

async function compileWaveExecutionBlueprint(args: {
  input: Parameters<typeof executePlannerWaves>[0];
  operation: Awaited<ReturnType<typeof loadOperation>>;
  graph: ReturnType<typeof createWorkGraph>;
  knowledgeResolutions: KnowledgeResolutionV1[];
  validationResolution: ValidationResolutionV1;
  capabilityRegistry: CapabilityRegistryV1;
  plan: PlannerOutput;
}): Promise<ExecutionBlueprint> {
  const { input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry, plan } = args;
  const candidate = operation.candidateRevision;
  const controllerEpoch = operation.controller?.epoch;
  if (!candidate || !Number.isSafeInteger(operation.operationExecutionRevision) || operation.operationExecutionRevision! < 1 || !Number.isSafeInteger(controllerEpoch) || controllerEpoch! < 0) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate, operation execution revision, and controller epoch are required to compile an execution blueprint.");
  const knowledgePolicy = knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const deliveryPolicy = configuredDeliveryPolicy(input.config, operation.kind);
  const allowedExternalEffects = deliveryPolicy.allowedExternalEffects;
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const resolvedOperationPolicy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? input.config.project.name,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: controllerEpoch!,
    intent: operation.intent?.request ?? input.contract.routing?.intent ?? input.contract.task.title,
    route: graph.route,
    minimumAssurance: graph.assurance,
    policyVersions: { resolvedOperationPolicy: "2", roleInvocationPolicy: "1", executionBlueprint: "3", executionBinding: "3", skillManifest: "1", capabilityRegistry: "1", operationalSkillProjection: "1" },
    policyDigests: {
      validation: validationResolution.digest,
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical(knowledgePolicy),
      context: sha256Canonical(input.config.context ?? null),
      capabilityRegistry: capabilityRegistry.digest,
      executionLiveness: sha256Canonical(operation.resolvedOperationPolicy?.executionLiveness ?? input.config.orchestration?.operations?.liveness ?? {}),
      economicEnvelope: sha256Canonical(operation.resolvedOperationPolicy?.economicEnvelope ?? input.config.orchestration?.operations?.economicEnvelope ?? {})
    },
    capabilityRegistryDigest: capabilityRegistry.digest,
    validationPolicy: validationResolution,
    reviewPolicy: {
      minimumAssurance: graph.assurance,
      reviewDimensions: plan.workUnits.flatMap((unit) => unit.changeKinds.map((kind) => `change:${kind}`)).sort(),
      independentReviewRequired: graph.assurance === "ELEVATED" || graph.assurance === "CRITICAL",
      leadAcceptance: input.config.workflow?.reviews?.leadAcceptance !== false,
      leadAcceptanceDirect: input.config.workflow?.reviews?.leadAcceptanceDirect === true
    },
    deliveryPolicy,
    knowledgePolicy: { resolutions: knowledgePolicy },
    contextPolicy: input.config.context ?? { mode: "disabled" },
    allowedExternalEffects,
    humanDecisionRequirements,
    executionLiveness: operation.resolvedOperationPolicy?.executionLiveness ?? input.config.orchestration?.operations?.liveness,
    economicEnvelope: operation.resolvedOperationPolicy?.economicEnvelope ?? input.config.orchestration?.operations?.economicEnvelope
  });
  const persisted = operation.resolvedOperationPolicy?.digest === resolvedOperationPolicy.digest
    ? operation
    : await bindResolvedOperationPolicy(input.stateRoot, operation.id, resolvedOperationPolicy);
  return compileExecutionBlueprint({ graph, maxTokens: input.config.context?.budgets?.default?.maxTokens, candidate, controllerEpoch: controllerEpoch!, operationExecutionRevision: persisted.operationExecutionRevision!, resolvedOperationPolicy, executionCatalog: input.executionCatalog, capabilityRegistry, knowledgeResolutions, projectStack: input.projectStack, validationRequirements: plan.validationRequirements, validationResolution });
}

async function lookupWithLibrarian(input: Pick<Parameters<typeof executePlannerWaves>[0], "contract" | "root" | "config" | "librarianSelection">, gap: NonNullable<Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]>): Promise<KnowledgeLookupResultV1> {
  if (!input.librarianSelection) throw new AehError("KNOWLEDGE_GAP_BLOCKED", `no Librarian selection is available for '${gap.missingCompetencies.join(", ")}'.`);
  const session = await executeAgentPrompt(input.root, input.config, input.contract, input.librarianSelection, buildLibrarianPrompt(gap), { outputContract: "knowledge-pack", phase: "knowledge", operationKind: "change", requireExecutionAuthority: true });
  if (session.exitCode !== 0) throw new AehError("KNOWLEDGE_GAP_BLOCKED", `Librarian failed while resolving '${gap.missingCompetencies.join(", ")}'.`);
  try {
    const output = knowledgePackOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    return { pack: validateKnowledgePack(output.pack, gap), ...(output.skillCandidate ? { skillCandidate: output.skillCandidate } : {}) };
  } catch (error) {
    if (error instanceof AehError) throw error;
    throw new AehError("KNOWLEDGE_PACK_REJECTED", `Librarian returned an invalid pack for '${gap.missingCompetencies.join(", ")}'.`, { cause: error });
  }
}

function buildLibrarianPrompt(gap: { cacheKey: string; missingCompetencies: string[]; reason: string; mode: KnowledgeModeV1 }): string {
  // HYBRID: the Librarian semantically proposes claim/source links for each procedure step; SkillTrustGate deterministically verifies every reference against the accepted pack and source policy.
  return `Resolve this deterministic knowledge gap as a read-only Librarian. Do not edit source, install anything, grant tools or change policy. ${gap.mode === "DOCS_ONLY" ? "Use official, version-matched documentation only; repository examples, public code, community pages and unknown sources are not acceptable." : gap.mode === "OFFLINE" ? "Do not perform external lookup; report the gap as unresolved." : "Use approved version-matched documentation or clearly identified repository/public-code evidence."} Preserve source provenance. Return exactly one AEH_RESULT_JSON object with {"pack":{"version":1,"cacheKey":${JSON.stringify(gap.cacheKey)},"topic":...,"claims":[{"id":...,"statement":...,"competency":...,"confidence":"high|medium|low"}],"sources":[{"uri":...,"kind":"official|repository|public-code|unknown","version":...}],"retrievedAt":"ISO-8601","packDigest":"sha256"},"skillCandidate":{"version":1,"id":"ephemeral:<competency>","competency":"<competency>","procedure":["<exact step text>"],"sourcePackDigest":"<pack digest>","procedureEvidence":[{"stepIndex":0,"claimIds":["<claim id supporting this exact step>"],"sourceUris":["<supporting source URI from pack.sources>"]}]}}. If returning a procedure, provide one procedureEvidence entry for every step, with at least one pack claim ID and allowed source URI that support that exact step; do not add trust or acceptance fields because SkillTrustGate makes that decision. The pack and any candidate must address only: ${gap.missingCompetencies.join(", ")}. Gap reason: ${gap.reason}.`;
}

async function executeDelegation(input: { root: string; stateRoot: string; config: HarnessProjectConfig; contract: TaskContract; implementationSelection: AgentExecutionSelection; executionCatalog: ExecutionCatalogV1; controller?: ControlPlaneSnapshot; operationId: string; task: WorkUnitOutput; participantAssignment?: ParticipantAssignmentV1; executionBlueprint: ExecutionBlueprint; waveBase: CandidateRevisionV1; }): Promise<DelegationExecutionResult> {
  if (!input.participantAssignment) return failed(input.task, input.implementationSelection, "EXECUTION_BLUEPRINT_INVALID: work unit has no frozen participant assignment.");
  const participantId = input.participantAssignment.participantId;
  let selection: AgentExecutionSelection;
  try {
    selection = selectionForParticipant(input.implementationSelection, input.participantAssignment, input.executionCatalog);
  } catch (error) {
    return failed(input.task, input.implementationSelection, String(error));
  }
  try { selection = enforceSandboxPolicy(selection, input.config, input.task.risk === "critical" ? "high" : input.task.risk).selection; } catch (error) { return failed(input.task, selection, String(error)); }
  const transport = selection.transport === "inherit" ? (input.config.orchestration?.provider ?? "none") : selection.transport; const capabilityIssues = validateExecutionCapabilities(selection, transport); if (capabilityIssues.length) return failed(input.task, selection, `Agent ${selection.logicalAgent} cannot execute: ${capabilityIssues.join("; ")}`);
  const prompt = buildDelegationPrompt(input.contract, input.task, input.participantAssignment?.operationalSkills);
  if (input.config.workflow?.planning?.distributed === true && input.config.distributed?.enabled === true) {
    try {
      const roleInvocationPolicy = input.participantAssignment.roleInvocationPolicy;
      if (!roleInvocationPolicy) throw new Error("EXECUTION_BINDING_REQUIRED: blueprint has no RoleInvocationPolicy for the distributed participant.");
      const identity = await prepareAgentExecutionIdentity(input.root, input.config, input.contract, selection, prompt, { participantId, phase: "distributed", operationKind: currentOperationContext().kind, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest });
      const remote = await dispatchDistributedDelegation({ root: input.root, config: input.config, contract: input.contract, task: input.task, participantId, selection, controller: input.controller, waveBase: input.waveBase, identity });
      const violations = remote.changedFiles.filter((file) => !matchesAny(file, input.task.scope)); if (violations.length) return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: "", status: "FAIL", distributed: true, message: `Remote delegation escaped scope: ${violations.join(", ")}` };
      if (remote.status === "PASS" && remote.patch.trim()) {
        if (remote.observedCandidateSourceDigest !== input.waveBase.sourceDigest) return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: "", status: "FAIL", distributed: true, message: "WAVE_RECONCILIATION_REQUIRED: distributed worker did not materialize the frozen wave Candidate source." };
        return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: remote.patch, status: remote.status, distributed: true, message: remote.message, changeSet: buildWaveChangeSet(input, participantId, remote.changedFiles, remote.patch) };
      }
      return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: remote.patch, status: remote.status, distributed: true, message: remote.message };
    }
    catch (error) { return failed(input.task, selection, `Distributed delegation failed: ${String(error)}`, true); }
  }
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${safe(input.contract.task.id)}-${safe(input.task.id)}-`)); const add = await runExecutable("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: input.root, timeoutMs: 120_000 }); if (add.exitCode !== 0) return failed(input.task, selection, `Unable to create task worktree: ${add.stderr || add.stdout}`);
  try {
    await materializeCandidateState(input.root, worktree, input.waveBase);
    await copyTaskContext(input.root, worktree, input.config, input.contract); if (input.controller) await materializeControlPlaneSnapshot(input.controller, worktree, input.config);
    const baselineAdd = await runExecutable("git", ["add", "-A"], { cwd: worktree, timeoutMs: 30_000 });
    if (baselineAdd.exitCode !== 0) return failed(input.task, selection, `Unable to create task baseline: ${baselineAdd.stderr || baselineAdd.stdout}`);
    const baselineCommit = await runExecutable("git", ["-c", "user.name=aeh", "-c", "user.email=aeh@localhost", "commit", "--no-gpg-sign", "-m", "aeh wave baseline", "--allow-empty"], { cwd: worktree, timeoutMs: 60_000 });
    if (baselineCommit.exitCode !== 0) return failed(input.task, selection, `Unable to create task baseline: ${baselineCommit.stderr || baselineCommit.stdout}`);
    // The frozen role invocation policy's output contract is the durable structured result for this
    // work unit. It must be propagated on dispatch (provider turn activation) and finalization
    // (acceptance), or the Implementer's result channel is never activated and the participant can
    // only fall back to unstructured text (AEH-V2-0118).
    const session = await executeAgentPrompt(worktree, input.config, input.contract, selection, prompt, { outputContract: input.participantAssignment.roleInvocationPolicy?.outputContract ?? selection.outputContract ?? "implementer", participantId, phase: "implementation", operationKind: currentOperationContext().kind, requireExecutionAuthority: true, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy: input.participantAssignment.roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest }); if (session.exitCode !== 0) return { task: input.task, session, changedFiles: [], patch: "", status: "FAIL", message: `Agent exited with ${session.exitCode}.` };
    const status = await runExecutable("git", ["status", "--porcelain"], { cwd: worktree, timeoutMs: 30_000 }); const untracked = status.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean); if (untracked.length) await runExecutable("git", ["add", "-N", "--", ...untracked], { cwd: worktree, timeoutMs: 30_000 });
    const names = await runExecutable("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, timeoutMs: 30_000 }); const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const violations = changedFiles.filter((file) => !matchesAny(file, input.task.scope)); if (violations.length) return { task: input.task, session, changedFiles, patch: "", status: "FAIL", message: `Delegation escaped scope: ${violations.join(", ")}` };
    const diff = await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: worktree, timeoutMs: 60_000 }); if (diff.exitCode !== 0) return { task: input.task, session, changedFiles, patch: "", status: "FAIL", message: diff.stderr || "Unable to capture delegation patch." };
    return { task: input.task, session, changedFiles, patch: diff.stdout, status: "PASS", changeSet: diff.stdout.trim() ? buildWaveChangeSet(input, participantId, changedFiles, diff.stdout) : undefined };
  } finally { await runExecutable("git", ["worktree", "remove", "--force", worktree], { cwd: input.root, timeoutMs: 120_000 }); await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined); }
}

function buildWaveChangeSet(input: { operationId: string; contract: TaskContract; task: WorkUnitOutput; waveBase: CandidateRevisionV1 }, participantId: string, changedFiles: string[], patch: string): ChangeSetV1 {
  return {
    version: 1,
    operationId: input.operationId,
    taskId: input.contract.task.id,
    workUnitId: input.task.id,
    participantId,
    baseCandidateRevision: input.waveBase.revision,
    baseCandidateDigest: input.waveBase.identityDigest,
    changedFiles,
    patch,
    patchDigest: sha256Utf8(patch)
  };
}

export function validatePlannerWavePlan(contract: TaskContract, plan: PlannerOutput): string[] {
  const issues: string[] = []; const ids = new Set<string>(); const requirements = new Set((contract.requirements ?? []).map((item) => item.id)); const covered = new Set<string>();
  for (const task of plan.workUnits) { if (ids.has(task.id)) issues.push(`duplicate work unit id ${task.id}`); ids.add(task.id); if (!task.scope.length) issues.push(`${task.id} has empty scope`); for (const scope of task.scope) if (!withinContractScope(scope, contract.scope?.allowed ?? ["**"])) issues.push(`${task.id} scope ${scope} is outside TaskContract scope`); for (const req of [...task.requirementRefs, ...task.acceptanceRefs]) { if (requirements.size && !requirements.has(req)) issues.push(`${task.id} references unknown requirement ${req}`); if (requirements.has(req)) covered.add(req); } }
  for (const task of plan.workUnits) for (const dependency of task.dependencies) if (!ids.has(dependency)) issues.push(`${task.id} depends on unknown work unit ${dependency}`); for (const requirement of requirements) if (!covered.has(requirement)) issues.push(`requirement ${requirement} is not assigned to any implementation work unit`); return [...new Set(issues)];
}
function buildPlannerPrompt(contract: TaskContract): string { const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? ""}`).join("\n") || "- none"; return `Create the implementation WorkGraph for ${contract.task.id}: ${contract.task.title}.\nThe TaskContract and sealed sources are immutable. Produce the smallest dependency-aware workUnits, concrete path scopes, competencies, risk tags and changeKinds. Each workUnits[].objective must be concise, non-empty, and no longer than 500 characters, matching the Planner output schema and WorkGraph compiler. Map every requirement ID to at least one work unit. If validation meaning is needed, emit typed validationRequirements[{version,id,property,kind,scope,evidenceNeeded,requirementRefs,acceptanceRefs}]; state what must be demonstrated, never a command or provider. If a work unit requires exclusive or ordered access to a shared mutable resource (database schema, migration sequence, package lock, deployment environment, public API contract, generated client, shared config, external mutable resource), emit resourceClaims[{version,resource,mode,order}] with mode SHARED_READ, EXCLUSIVE_WRITE or ORDERED_SEQUENCE and a non-negative order for ORDERED_SEQUENCE. The deterministic scheduler validates and enforces claims; you cannot widen scheduling by claiming a resource. The deterministic resolver will choose approved project scripts, validators or providers. Do not select agents, reviewers, validators, commands, tools or credentials by name, and do not create product requirements. If formalization is required, set formalizationNeed=REQUIRED with one typed formalizationReason and formalizationEvidenceRefs.\nRequirements:\n${requirements}\nAllowed scope: ${(contract.scope?.allowed ?? ["**"]).join(", ")}\nReturn output matching the planner contract; when native structured output is unavailable, use one final AEH_RESULT_JSON=<json> line.`; }
function buildDelegationPrompt(contract: TaskContract, task: WorkUnitOutput, operationalSkills?: import("../capabilities/operationalSkills.js").OperationalSkillProjectionV1): string {
  const guidance = operationalSkills?.skills.length ? `\nOperational guidance selected for this role and WorkUnit (guidance only; it grants no tools or authority):\n${operationalSkills.skills.map((skill) => `- ${skill.name} v${skill.version} [${skill.certificationStatus}${skill.accessMode === "CONTROLLER_GUIDANCE" ? ", controller-guidance-only" : ""}]: ${skill.procedure.join("; ")}${skill.recovery.length ? ` Recovery: ${skill.recovery.map((item) => `${item.failureClass} → ${item.steps.join("; ")}`).join(" | ")}` : ""}`).join("\n")}` : "";
  return `Implement only work unit ${task.id} for parent ${contract.task.id}.\nObjective: ${task.objective}\nAllowed task scope: ${task.scope.join(", ")}\nDependencies already integrated: ${task.dependencies.join(", ") || "none"}\nAcceptance references: ${task.acceptanceRefs.join(", ") || "none"}\nRequired competencies: ${task.competencies.join(", ") || "general engineering"}\nRisk: ${task.risk}.${guidance}\nThe parent TaskContract, SDD and control-plane snapshot are frozen. Do not edit outside the declared scope, do not commit, push, rebase or change requirements. Run focused tests when practical and leave the worktree with only the implementation diff.`;
}
export function selectionForParticipant(base: AgentExecutionSelection, assignment: ParticipantAssignmentV1, catalog: ExecutionCatalogV1): AgentExecutionSelection {
  const binding = catalog.roleBindings[assignment.role];
  if (!binding) throw new Error(`EXECUTION_BLUEPRINT_INVALID: no execution binding exists for role '${assignment.role}'.`);
  const runtime = catalog.runtimeProfiles.find((profile) => profile.id === binding.runtimeId);
  const model = catalog.modelProfiles.find((profile) => profile.alias === binding.modelAlias);
  if (!runtime || !model) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' references an unavailable runtime or model.`);
  if (model.runtime !== binding.runtimeId) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' pairs model '${binding.modelAlias}' with runtime '${binding.runtimeId}', but the model requires '${model.runtime}'.`);
  const permissions = { ...base.permissions };
  const exposedTools = [...new Set([...assignment.toolPack.required, ...assignment.toolPack.optional])].filter((tool) => !assignment.toolPack.forbidden.includes(tool));
  // The compiled assignment toolPack is the role ceiling-checked capability set, so the launch
  // permission projection must express it explicitly instead of leaving provider defaults ("ask")
  // in place: an undefined provider permission made a real Implementer session stop for write
  // approval and return an empty result (AEH-V2-0110). An explicit base deny is never widened.
  const allowIfExposed = (current: PermissionDecision | undefined, tool: string): PermissionDecision => {
    if (!exposedTools.includes(tool)) return "deny";
    return current === "deny" || current === "ask" ? current : "allow";
  };
  permissions.read = allowIfExposed(permissions.read, "repository-read");
  permissions.write = allowIfExposed(permissions.write, "repository-write");
  permissions.gitWrite = allowIfExposed(permissions.gitWrite, "repository-write");
  permissions.shell = allowIfExposed(permissions.shell, "command-execute");
  permissions.network = exposedTools.includes("approved-research") ? (permissions.network === "deny" ? "deny" : "allow") : "deny";
  if (assignment.role === "Reviewer") { permissions.write = "deny"; permissions.gitWrite = "deny"; }
  return {
    ...base,
    profile: binding.profile ?? base.profile,
    logicalAgent: assignment.participantId,
    role: assignment.role,
    specializations: [assignment.specialization],
    runtimeName: runtime.id,
    runtimeAdapter: runtime.adapter,
    paseoProvider: runtime.provider ?? runtime.adapter,
    modelAlias: model.alias,
    modelId: model.id,
    modelName: model.model,
    modelProvider: model.provider,
    variant: binding.variant ?? model.variant,
    temperature: binding.temperature ?? base.temperature,
    nativeAgent: binding.nativeAgent,
    transport: binding.transport,
    outputContract: binding.outputContract ?? base.outputContract,
    args: binding.args ? [...binding.args] : [...base.args],
    mcps: [...exposedTools].sort(),
    skills: [...assignment.skills],
    permissions,
    runtimeCapabilities: { ...runtime.capabilities }
  };
}
async function copyTaskContext(root: string, target: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> { const relative = [`${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)), contract.issue?.snapshotPath].filter((value): value is string => Boolean(value)); for (const item of [...new Set(relative)]) { try { const source = await existingRepositoryPath(root, item); const destination = repositoryPath(target, item); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } }
function withinContractScope(candidate: string, allowed: string[]): boolean { return allowed.some((pattern) => pattern === "**" || minimatch(candidate, pattern, { dot: true }) || pathWithin(staticPrefix(candidate), staticPrefix(pattern))); }
function pathWithin(candidate: string, parent: string): boolean { return Boolean(candidate && parent) && (candidate === parent || candidate.startsWith(`${parent}/`)); }
function matchesAny(file: string, patterns: string[]): boolean { return patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true }) || pathWithin(file, staticPrefix(pattern))); }
function staticPrefix(pattern: string): string { return pattern.split(/[?*\[]/, 1)[0].replace(/\/+$/, ""); }
function failed(task: WorkUnitOutput, selection: AgentExecutionSelection, message: string, distributed = false): DelegationExecutionResult { return { task, session: { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode: 1, stdout: "", stderr: message }, changedFiles: [], patch: "", status: "FAIL", message, distributed }; }
function aggregate(sessions: WorkerSession[], exitCode: number, message: string): WorkerSession { return { provider: "multi-worker", logicalAgent: "planner-waves", exitCode, stdout: message, stderr: exitCode ? sessions.filter((session) => session.exitCode !== 0).map((session) => session.stderr).filter(Boolean).join("\n") : "" }; }
/**
 * AEH-V2-0129: `workflow.planning.worktreeIsolation` defaults to true and is honored by per-unit
 * candidate worktrees. When it is explicitly disabled, same-workspace writers are serialized
 * deterministically (one work unit at a time) instead of running parallel writers, because
 * DELEGATED candidate assembly always captures one ChangeSet per unit.
 *
 * Unit 3 provider backpressure (DETERMINISTIC): wave fan-out never widens the
 * provider-session lease ceiling (single source:
 * `DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation`;
 * caps unchanged). The default concurrency is `min(taskCount, lease cap)` and
 * any configured `maxWaveConcurrency` above the cap is clamped down
 * (fail-closed). Excess work waits in the bounded `mapLimit` worker queue
 * (QUEUE, never throw); operation-wide saturation QUEUES via durable
 * `waitForProviderSessionCapacity` (production caller, bounded WAIT against the
 * caller's existing deadline, terminal on exhaustion); per-workspace
 * write-write conflicts QUEUE via non-throwing `tryAcquireProviderLease`
 * (production caller below, bounded `providerLeaseQueueWaitMs` WAIT, RETRY
 * within budget, never throw-on-conflict on the wired path); residual
 * lease/rate-limit conflicts classify via `isWaveBackpressureError`
 * (narrow 429/rate-limit marker, never bare `retry-after`) and wait via
 * bounded `waveRateLimitWaitMs`/`waveQueueWaitMs` against the caller's
 * existing deadline (WAIT is not an attempt; exhausted budgets are terminal).
 * Telemetry is observation-only `harness.wave.backpressure` counter/gauge
 * attributes via existing `recordEvent` conventions.
 */
export const WAVE_CONCURRENCY_LEASE_CAP_V1 =
  DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation;
export const WAVE_BACKPRESSURE_MAX_WAIT_MS_V1 = 30_000;
export const WAVE_BACKPRESSURE_EVENT_V1 = "harness.wave.backpressure";

export interface WaveBackpressureTelemetryV1 {
  wave: number;
  taskId: string;
  active: number;
  ceiling: number;
  queued: number;
  retryAfterMs: number;
  disposition: "QUEUE" | "PROCEED" | "CLAMPED";
  rateLimited?: boolean;
}

export function waveConcurrencyV1(planning: { worktreeIsolation?: boolean; maxWaveConcurrency?: number } | undefined, taskCount: number): number {
  if (planning?.worktreeIsolation === false) return 1;
  const requested = planning?.maxWaveConcurrency ?? taskCount;
  const boundedRequested = Number.isFinite(requested) ? Math.floor(requested) : taskCount;
  return Math.max(1, Math.min(boundedRequested, taskCount, WAVE_CONCURRENCY_LEASE_CAP_V1));
}

/**
 * Luna F1: remaining wave/operation budget threading (DETERMINISTIC, no I/O).
 *
 * The operation capacity WAIT must never start a fresh 30s budget unbounded
 * by the existing wave/operation deadline. `resolveWaveCapacityDeadlineAtMs`
 * returns `min(now + maxWaitMs, operationDeadlineAtMs)` when a finite
 * operation deadline exists, and `undefined` when none can be established
 * (never mints fresh `now+30s`). Callers treat `undefined` as no-wait budget:
 * single immediate capacity check only (headroom proceeds, saturation is
 * terminal FAIL with zero sleeps). `remainingWaveBudgetMs` returns
 * `max(0, deadline - now)`; 0 or undefined deadline means exhausted → terminal
 * FAIL with no wait (fail-closed). Deterministic clocks: callers pass `nowMs`;
 * tests pin it.
 */
export function resolveWaveCapacityDeadlineAtMs(
  nowMs: number,
  operationDeadlineAtMs?: number,
  maxWaitMs: number = WAVE_BACKPRESSURE_MAX_WAIT_MS_V1
): number | undefined {
  const safeNow = Number.isFinite(nowMs) ? Math.floor(nowMs) : 0;
  const safeMax = Number.isFinite(maxWaitMs) && maxWaitMs >= 0
    ? Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(maxWaitMs))
    : WAVE_BACKPRESSURE_MAX_WAIT_MS_V1;
  if (operationDeadlineAtMs === undefined || !Number.isFinite(operationDeadlineAtMs)) {
    // Fail-closed: no existing wave/operation deadline can be established, so
    // mint no fresh time. Callers do immediate-check-only (no wait).
    return undefined;
  }
  const freshDeadline = safeNow + safeMax;
  return Math.min(freshDeadline, Math.floor(operationDeadlineAtMs));
}

export function remainingWaveBudgetMs(deadlineAtMs: number | undefined, nowMs: number): number {
  if (deadlineAtMs === undefined || !Number.isFinite(deadlineAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor(deadlineAtMs) - Math.floor(nowMs));
}

/**
 * Bounded backpressure telemetry attributes for existing `recordEvent`
 * conventions (counter: queued/active; gauge: ceiling/concurrency). Refs-only,
 * never provider content; observation only, never a gate.
 */
export function waveBackpressureAttributes(signal: WaveBackpressureTelemetryV1): Record<string, unknown> {
  return {
    wave: Math.max(0, Math.floor(signal.wave)),
    taskId: signal.taskId.slice(0, 200),
    active: Math.max(0, Math.floor(signal.active)),
    ceiling: Math.max(1, Math.floor(signal.ceiling)),
    queued: Math.max(0, Math.floor(signal.queued)),
    retryAfterMs: Math.max(0, Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(signal.retryAfterMs))),
    disposition: signal.disposition,
    ...(signal.rateLimited !== undefined ? { rateLimited: signal.rateLimited } : {})
  };
}

/** DETERMINISTIC classifier: true when the failure is backpressure (QUEUE/WAIT, not FAIL). Narrow marker: bare `retry-after` without a 429/rate-limit signal is never backpressure. */
export function isWaveBackpressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  if (message.includes("RESOURCE_CEILING_EXHAUSTED") && message.includes("active provider sessions")) return true;
  if (message.includes("already leased in")) return true;
  if (message.includes("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED")) return true;
  return /(?:\b429\b|rate[\s_\-]*limit|too many requests)/i.test(message);
}

/** Alias for wave callers: backpressure failures queue; all other failures are terminal. */
export function shouldQueueWaveWork(error: unknown): boolean {
  return isWaveBackpressureError(error);
}

/**
 * Honor a Retry-After/queue WAIT against an existing deadline budget. Never
 * extends caps: returns `min(boundedWait, remainingBudget)`, or 0 when
 * exhausted (terminal, fail-closed). A WAIT is not an attempt.
 */
export function waveRateLimitWaitMs(
  retryAfterMs: number | { retryAfterMs: number } | undefined,
  remainingBudgetMs?: number
): number {
  const raw = typeof retryAfterMs === "number" ? retryAfterMs : retryAfterMs?.retryAfterMs;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  const bounded = Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(raw));
  if (remainingBudgetMs === undefined) return bounded;
  if (!Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) return 0;
  return Math.min(bounded, Math.floor(remainingBudgetMs));
}

/** Bounded QUEUE wait alias (lease-conflict path shares the same budget rule as rate-limit WAIT). */
export function waveQueueWaitMs(retryAfterMs: number | undefined, remainingBudgetMs?: number): number {
  return waveRateLimitWaitMs(retryAfterMs, remainingBudgetMs);
}

/**
 * Wave-dispatch QUEUE RETRY within an existing deadline (production wired path).
 *
 * MECHANISM: DETERMINISTIC classification + bounded WAIT. Backpressure
 * (`isWaveBackpressureError`, including 429 via `parseProviderRateLimitDetail`
 * narrow marker and lease conflicts via `isProviderLeaseConflictError`) QUEUES:
 * Retry-After is honored via `waveRateLimitWaitMs` (429) or
 * `providerLeaseQueueWaitMs`/`waveQueueWaitMs` (lease QUEUED hint) against the
 * caller's existing deadline budget (never extends caps; 0 when exhausted →
 * terminal rethrow, fail-closed). A WAIT is not an attempt. Non-backpressure
 * failures rethrow immediately (FAIL). Injectable `now`/`sleep` keep fixtures
 * scripted with no network (same pattern as `waitForProviderSessionCapacity`).
 */
export interface WaveBackpressureRetryOptionsV1 {
  timeoutMs?: number;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number, error: unknown) => void;
}

export async function withWaveBackpressureRetry<T>(
  action: (remainingBudgetMs: number | undefined) => Promise<T>,
  options: WaveBackpressureRetryOptionsV1 = {}
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now;
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = nowMs();
  // Luna F1: never mint fresh `now+30s` when the caller has no deadline.
  // Undefined timeout means no wait budget: single attempt, backpressure is
  // terminal immediately (no implicit wait). Defined timeout bounds WAIT via
  // min(bounded, remaining); exhaustion is terminal rethrow (fail-closed).
  const deadlineAt = options.timeoutMs !== undefined ? startedAt + options.timeoutMs : undefined;
  for (;;) {
    const remaining = deadlineAt !== undefined ? deadlineAt - nowMs() : undefined;
    try {
      return await action(remaining);
    } catch (error) {
      // QUEUE classifiers (narrow 429/rate-limit, never bare retry-after):
      // - isWaveBackpressureError: wave gate (429/lease/takeover/ceiling)
      // - isProviderCapacityError: durable capacity/lease shape (operationResources)
      // - isProviderRateLimited: SDK-boundary 429 (narrow marker)
      const waveQueueable = isWaveBackpressureError(error) || isProviderCapacityError(error) || isProviderRateLimited(error, nowMs);
      if (!waveQueueable) throw error;
      // 429 path honors typed Retry-After (narrow marker guarantees real 429/rate-limit,
      // never bare retry-after); lease-conflict path uses bounded queue WAIT.
      // SDK 60s hints clamp into the wave 30s ceiling via waveRateLimitWaitMs.
      const rateDetail = parseProviderRateLimitDetail(error, nowMs);
      // No existing deadline: immediate terminal, never mint fresh wait.
      const effectiveRemaining = deadlineAt !== undefined ? deadlineAt - nowMs() : 0;
      let waitMs: number;
      if (rateDetail) {
        waitMs = waveRateLimitWaitMs(rateDetail.retryAfterMs, effectiveRemaining);
      } else if (isProviderLeaseConflictError(error)) {
        waitMs = waveQueueWaitMs(250, effectiveRemaining);
      } else {
        waitMs = waveQueueWaitMs(250, effectiveRemaining);
      }
      if (waitMs <= 0) throw error;
      options.onWait?.(waitMs, error);
      await sleepMs(waitMs);
    }
  }
}

/**
 * Intra-wave per-workspace write-lease admission (NOT shared enforcement).
 *
 * SCOPE HONESTY (Luna F2): this serializes concurrent writers *within one
 * wave in one process* via the provided in-memory supervisor. A fresh
 * `RuntimeSupervisorV1` per wave cannot see leases from other waves,
 * operations, or processes — it is blind to cross-wave/operation contention
 * by construction. Cross-wave/operation contention is enforced by the SHARED
 * durable authority: the operation-wide capacity gate
 * (`waitForProviderSessionCapacity` over `readManagedRuntimeSnapshot`, the
 * same lease store `acquireProviderLease` persists to) plus
 * `acquireWaveProviderSlotSharedOrQueue` below plus the real provider
 * lifecycle (`runWithOperationProviderLease`). Never use this alone to claim
 * shared enforcement.
 *
 * Isolated worktrees use distinct workspace keys (no contention, ACQUIRED);
 * shared-workspace waves share one key (second writer QUEUES). On QUEUED, the
 * bounded `providerLeaseQueueWaitMs` WAIT is honored against the caller's
 * existing deadline (never extends caps; exhaustion → terminal false, FAIL).
 */
export async function acquireWaveProviderSlotOrQueue(
  supervisor: RuntimeSupervisorV1,
  input: { provider: string; projectId: string; canonicalRoot: string; workspaceId: string; ownerId: string; mode?: "read" | "write" },
  options: { remainingBudgetMs?: number; sleepMs?: (ms: number) => Promise<void> } = {}
): Promise<{ acquired: boolean; retryAfterMs: number; queueDepth: number }> {
  const result = supervisor.tryAcquireProviderLease({
    provider: input.provider,
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    workspaceId: input.workspaceId,
    mode: input.mode ?? "write",
    ownerId: input.ownerId
  });
  if (result.status === "ACQUIRED") return { acquired: true, retryAfterMs: 0, queueDepth: 0 };
  const queued = result as ProviderLeaseQueuedV1;
  const waitMs = providerLeaseQueueWaitMs(queued, options.remainingBudgetMs);
  if (waitMs <= 0) return { acquired: false, retryAfterMs: queued.retryAfterMs, queueDepth: queued.queueDepth };
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleepMs(waitMs);
  // Single bounded WAIT then re-attempt once; exhaustion on second QUEUED is terminal.
  const second = supervisor.tryAcquireProviderLease({
    provider: input.provider,
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    workspaceId: input.workspaceId,
    mode: input.mode ?? "write",
    ownerId: input.ownerId
  });
  if (second.status === "ACQUIRED") return { acquired: true, retryAfterMs: waitMs, queueDepth: queued.queueDepth };
  return { acquired: false, retryAfterMs: (second as ProviderLeaseQueuedV1).retryAfterMs, queueDepth: (second as ProviderLeaseQueuedV1).queueDepth };
}

/**
 * Shared durable per-workspace gate for wave dispatch (Luna F2+F3, fail-closed).
 *
 * MECHANISM: DETERMINISTIC atomic acquire-or-wait-or-fail via the REAL
 * `acquireProviderLease` store path (`acquireDurableWaveSlotOrQueue` over the
 * file-locked managed-runtime snapshot, same `findConflictingProviderLeases`
 * predicate as `tryAcquireProviderLease`). Check-then-proceed is deleted: the
 * previous read-only `checkDurableWaveSlotConflict` + proceed-without-acquire
 * (TOCTOU, two racers both proceeding) cannot be made atomic and is removed
 * (no dead code). ATOMICITY: in-memory `tryAcquireProviderLease` is atomic
 * within one process only; cross-wave/operation/process atomicity comes from
 * the snapshot `.lock` transact in `operationResources.ts` (reload→check→write
 * under one lock, never both proceed).
 *
 * Bounded WAIT (`min(retryAfter, remainingBudget)`) against the caller's
 * existing deadline (never mints fresh; undefined/0 budget means single
 * immediate attempt only, exhaustion → terminal false, FAIL). Unreadable
 * durability BLOCKS (acquired false, retryAfter 0, no wait). Deterministic
 * clocks via `nowMs`/`sleepMs`. Returns durable `leaseId` on ACQUIRED for
 * explicit `releaseDurableWaveSlot` (callers release in finally, best-effort).
 */
export async function acquireWaveProviderSlotSharedOrQueue(
  root: string,
  input: { provider: string; projectId: string; canonicalRoot: string; workspaceId: string; ownerId: string; mode?: "read" | "write" },
  options: {
    remainingBudgetMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  } = {}
): Promise<{ acquired: boolean; retryAfterMs: number; queueDepth: number; scope: "shared-durable"; leaseId?: string }> {
  const result = await acquireDurableWaveSlotOrQueue(root, input, {
    ...(options.remainingBudgetMs !== undefined ? { remainingBudgetMs: options.remainingBudgetMs } : {}),
    ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  if (result.acquired) {
    return { acquired: true, retryAfterMs: 0, queueDepth: 0, scope: "shared-durable", leaseId: result.leaseId };
  }
  return { acquired: false, retryAfterMs: result.retryAfterMs, queueDepth: result.queueDepth, scope: "shared-durable" };
}
async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> { if (!values.length) return []; const result = new Array<R>(values.length); let cursor = 0; const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => { while (true) { const index = cursor++; if (index >= values.length) return; result[index] = await fn(values[index]); } }); await Promise.all(workers); return result; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
