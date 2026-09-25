import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection } from "./types.js";
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
import { configuredExternalEffects, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1, ChangeSetV1 } from "../candidates/assembler.js";
import { materializeCandidateState } from "../candidates/direct.js";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../candidates/wave.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { FileKnowledgeCacheV1, resolveKnowledgeGate, validateKnowledgePack, type KnowledgeCacheV1, type KnowledgeLookupResultV1, type KnowledgeModeV1, type KnowledgePackV1, type KnowledgeResolutionV1 } from "../knowledge/index.js";
import { defaultSkillSeed } from "../participants/index.js";
import { resolveValidationRequirements, type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";

export interface DelegationExecutionResult { task: WorkUnitOutput; session: WorkerSession; changedFiles: string[]; patch: string; status: "PASS" | "FAIL"; message?: string; distributed?: boolean; candidate?: CandidateRevisionV1; impact?: CandidateImpactV1; changeSet?: ChangeSetV1; }
export interface WaveExecutionSummary { wave: number; taskIds: string[]; status: "PASS" | "FAIL"; results: DelegationExecutionResult[]; barrier?: ValidationReport; }
export interface PlannerWaveResult { used: boolean; plan?: PlannerOutput; blueprint?: ExecutionBlueprint; schedule?: ParallelismPlan; waves: WaveExecutionSummary[]; sessions: WorkerSession[]; aggregateSession?: WorkerSession; report?: ValidationReport; }

export async function executePlannerWaves(input: { root: string; stateRoot: string; config: HarnessProjectConfig; contract: TaskContract; plannerSelection?: AgentExecutionSelection; librarianSelection?: AgentExecutionSelection; implementationSelection: AgentExecutionSelection; executionCatalog: ExecutionCatalogV1; controller?: ControlPlaneSnapshot; precomputedPlan?: PlannerOutput; semanticAssessment?: CandidateImpactAssessmentRuntimeV1; projectStack?: ProjectStackProfileV1; knowledgeMode?: KnowledgeModeV1; knowledgeCache?: KnowledgeCacheV1; knowledgeResolutions?: readonly KnowledgeResolutionV1[]; knowledgeLookup?: (gap: Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>; revalidate: () => Promise<ValidationReport>; }): Promise<PlannerWaveResult> {
  const planning = input.config.workflow?.planning;
  if (planning?.enabled === false || input.contract.routing?.route === "DIRECT" || input.contract.routing?.route === "NO_AGENT") return { used: false, waves: [], sessions: [] };
  if (!input.precomputedPlan && !input.plannerSelection) return { used: false, waves: [], sessions: [] };
  const sessions: WorkerSession[] = [];
  let plan: PlannerOutput;
  if (input.precomputedPlan) {
    plan = plannerOutputSchema.parse(input.precomputedPlan);
  } else {
    const plannerSession = await executeAgentPrompt(input.root, input.config, input.contract, input.plannerSelection!, buildPlannerPrompt(input.contract), { outputContract: "planner", phase: "planning", requireExecutionAuthority: true });
    sessions.push(plannerSession);
    if (plannerSession.exitCode !== 0) return { used: true, waves: [], sessions, aggregateSession: aggregate(sessions, 1, "Planner runtime failed.") };
    try { plan = plannerOutputSchema.parse(extractMarkedJson(plannerSession.stdout, plannerSession.stderr)); } catch (error) { return { used: true, waves: [], sessions, aggregateSession: aggregate(sessions, 1, `Invalid planner output: ${String(error)}`) }; }
  }
  const planIssues = validatePlannerWavePlan(input.contract, plan);
  if (planIssues.length) return { used: true, plan, waves: [], sessions, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${planIssues.join("; ")}`) };
  if (!plan.workUnits.length) return { used: false, plan, waves: [], sessions };
  let blueprint: ExecutionBlueprint;
  let graph: ReturnType<typeof createWorkGraph>;
  let validationResolution: ValidationResolutionV1;
  let knowledgeResolutions: KnowledgeResolutionV1[] = [];
  let operation: Awaited<ReturnType<typeof loadOperation>> | undefined;
  try {
    graph = createWorkGraph({
      taskId: input.contract.task.id,
      objective: input.contract.task.title,
      route: input.contract.routing?.route ?? "DELEGATED",
      assurance: input.contract.routing?.assurance ?? "STANDARD",
      requirementRefs: (input.contract.requirements ?? []).map((item) => item.id),
      acceptanceRefs: plan.workUnits.flatMap((unit) => unit.acceptanceRefs),
      units: plan.workUnits.map((unit) => ({ version: 1 as const, ...unit, status: "PENDING" as const }))
    });
    knowledgeResolutions = await resolvePlannerKnowledge(plan, input);
    const operationContext = currentOperationContext();
    operation = operationContext.id ? await loadOperation(input.stateRoot, operationContext.id) : undefined;
    const candidateRevision = operation?.candidateRevision;
    const controllerEpoch = operation?.controller?.epoch;
    if (!candidateRevision || typeof controllerEpoch !== "number" || !Number.isSafeInteger(controllerEpoch) || controllerEpoch < 0 || operation?.operationExecutionRevision === undefined) {
      throw new AehError("EXECUTION_BLUEPRINT_INVALID", "A managed CandidateRevision and controller epoch are required before compiling an execution blueprint.");
    }
    validationResolution = await resolveValidationRequirements({ root: input.root, requirements: plan.validationRequirements, config: input.config, contract: input.contract, projectStack: input.projectStack });
    if (validationResolution.blocked.length) throw new AehError("VALIDATION_REQUIREMENT_BLOCKED", validationResolution.blocked.map((item) => `${item.requirementId}: ${item.reason}`).join("; "), { details: { validationResolution } });
    const executionSemanticsDigest = sha256Canonical({ workGraph: graph, plannerPlan: plan, executionCatalogDigest: input.executionCatalog.digest, validationResolution, knowledge: knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), contextPolicy: input.config.context ?? null });
    operation = await bindOperationExecutionSemantics(input.stateRoot, operation!.id, executionSemanticsDigest);
  blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, plan });
  } catch (error) {
    return { used: true, plan, waves: [], sessions, aggregateSession: aggregate(sessions, 1, `Participant plan rejected: ${String(error)}`) };
  }
  const schedule = await planParallelism(input.root, input.config, input.contract.task.id, plan.workUnits);
  await recordEvent(input.stateRoot, input.config, "harness.plan.ready", { taskId: input.contract.task.id, workUnits: plan.workUnits.length, waves: schedule.waves.length, conflicts: schedule.conflicts.length, graphUsed: schedule.graphUsed, compilerDigest: blueprint.plan.compilerDigest, distributed: planning?.distributed === true && input.config.distributed?.enabled === true });
  const waveSummaries: WaveExecutionSummary[] = []; let finalReport: ValidationReport | undefined; let currentCandidate = operation?.candidateRevision;
  for (let index = 0; index < schedule.waves.length; index += 1) {
    if (index > 0 && graph && operation) {
      try {
        operation = await loadOperation(input.stateRoot, operation.id);
        currentCandidate = operation.candidateRevision;
        if (!currentCandidate) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate is required to recompile the next wave identity.");
        blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, plan });
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
    const results = await mapLimit(tasks, planning?.maxWaveConcurrency ?? tasks.length, (task) => executeDelegation({ ...input, operationId: waveOperationId, task, participantAssignment: participantByWorkUnit.get(task.id), executionBlueprint: waveBlueprint, waveBase: waveBase.candidate })); sessions.push(...results.map((result) => result.session));
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
      const integration = await integrateWaveChangeSets({ root: input.root, stateRoot: input.stateRoot, operationId: operation.id, taskId: input.contract.task.id, wave: waveBase, submissions, semanticAssessment: input.semanticAssessment });
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
  finalReport ??= await input.revalidate(); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, finalReport.status === "PASS" ? 0 : 1, `Executed ${plan.workUnits.length} work unit(s) across ${schedule.waves.length} wave(s).`), report: finalReport };
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
  plan: PlannerOutput;
}): Promise<ExecutionBlueprint> {
  const { input, operation, graph, knowledgeResolutions, validationResolution, plan } = args;
  const candidate = operation.candidateRevision;
  const controllerEpoch = operation.controller?.epoch;
  if (!candidate || !Number.isSafeInteger(operation.operationExecutionRevision) || operation.operationExecutionRevision! < 1 || !Number.isSafeInteger(controllerEpoch) || controllerEpoch! < 0) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate, operation execution revision, and controller epoch are required to compile an execution blueprint.");
  const knowledgePolicy = knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const allowedExternalEffects = configuredExternalEffects(input.config, operation.kind);
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const deliveryPolicy = { githubEnabled: input.config.delivery?.github?.enabled === true, paseoEnabled: input.config.delivery?.paseo?.enabled === true, allowedExternalEffects };
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
    policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
    policyDigests: {
      validation: validationResolution.digest,
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical(knowledgePolicy),
      context: sha256Canonical(input.config.context ?? null)
    },
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
    humanDecisionRequirements
  });
  const persisted = operation.resolvedOperationPolicy?.digest === resolvedOperationPolicy.digest
    ? operation
    : await bindResolvedOperationPolicy(input.stateRoot, operation.id, resolvedOperationPolicy);
  return compileExecutionBlueprint({ graph, maxTokens: input.config.context?.budgets?.default?.maxTokens, candidate, controllerEpoch: controllerEpoch!, operationExecutionRevision: persisted.operationExecutionRevision!, resolvedOperationPolicy, executionCatalog: input.executionCatalog, knowledgeResolutions, projectStack: input.projectStack, validationRequirements: plan.validationRequirements, validationResolution });
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
  const prompt = buildDelegationPrompt(input.contract, input.task);
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
    const session = await executeAgentPrompt(worktree, input.config, input.contract, selection, prompt, { participantId, phase: "implementation", operationKind: currentOperationContext().kind, requireExecutionAuthority: true, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy: input.participantAssignment.roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest }); if (session.exitCode !== 0) return { task: input.task, session, changedFiles: [], patch: "", status: "FAIL", message: `Agent exited with ${session.exitCode}.` };
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
function buildPlannerPrompt(contract: TaskContract): string { const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? ""}`).join("\n") || "- none"; return `Create the implementation WorkGraph for ${contract.task.id}: ${contract.task.title}.\nThe TaskContract and sealed sources are immutable. Produce the smallest dependency-aware workUnits, concrete path scopes, competencies, risk tags and changeKinds. Map every requirement ID to at least one work unit. If validation meaning is needed, emit typed validationRequirements[{version,id,property,kind,scope,evidenceNeeded,requirementRefs,acceptanceRefs}]; state what must be demonstrated, never a command or provider. If a work unit requires exclusive or ordered access to a shared mutable resource (database schema, migration sequence, package lock, deployment environment, public API contract, generated client, shared config, external mutable resource), emit resourceClaims[{version,resource,mode,order}] with mode SHARED_READ, EXCLUSIVE_WRITE or ORDERED_SEQUENCE and a non-negative order for ORDERED_SEQUENCE. The deterministic scheduler validates and enforces claims; you cannot widen scheduling by claiming a resource. The deterministic resolver will choose approved project scripts, validators or providers. Do not select agents, reviewers, validators, commands, tools or credentials by name, and do not create product requirements. If formalization is required, set formalizationNeed=REQUIRED with one typed formalizationReason and formalizationEvidenceRefs.\nRequirements:\n${requirements}\nAllowed scope: ${(contract.scope?.allowed ?? ["**"]).join(", ")}\nReturn output matching the planner contract; when native structured output is unavailable, use one final AEH_RESULT_JSON=<json> line.`; }
function buildDelegationPrompt(contract: TaskContract, task: WorkUnitOutput): string { return `Implement only work unit ${task.id} for parent ${contract.task.id}.\nObjective: ${task.objective}\nAllowed task scope: ${task.scope.join(", ")}\nDependencies already integrated: ${task.dependencies.join(", ") || "none"}\nAcceptance references: ${task.acceptanceRefs.join(", ") || "none"}\nRequired competencies: ${task.competencies.join(", ") || "general engineering"}\nRisk: ${task.risk}.\nThe parent TaskContract, SDD and control-plane snapshot are frozen. Do not edit outside the declared scope, do not commit, push, rebase or change requirements. Run focused tests when practical and leave the worktree with only the implementation diff.`; }
export function selectionForParticipant(base: AgentExecutionSelection, assignment: ParticipantAssignmentV1, catalog: ExecutionCatalogV1): AgentExecutionSelection {
  const binding = catalog.roleBindings[assignment.role];
  if (!binding) throw new Error(`EXECUTION_BLUEPRINT_INVALID: no execution binding exists for role '${assignment.role}'.`);
  const runtime = catalog.runtimeProfiles.find((profile) => profile.id === binding.runtimeId);
  const model = catalog.modelProfiles.find((profile) => profile.alias === binding.modelAlias);
  if (!runtime || !model) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' references an unavailable runtime or model.`);
  if (model.runtime !== binding.runtimeId) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' pairs model '${binding.modelAlias}' with runtime '${binding.runtimeId}', but the model requires '${model.runtime}'.`);
  const permissions = { ...base.permissions };
  const exposedTools = [...new Set([...assignment.toolPack.required, ...assignment.toolPack.optional])].filter((tool) => !assignment.toolPack.forbidden.includes(tool));
  if (!exposedTools.includes("repository-read")) permissions.read = "deny";
  if (!exposedTools.includes("repository-write")) { permissions.write = "deny"; permissions.gitWrite = "deny"; }
  if (!exposedTools.includes("command-execute")) permissions.shell = "deny";
  if (!exposedTools.includes("approved-research")) permissions.network = "deny";
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
async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> { if (!values.length) return []; const result = new Array<R>(values.length); let cursor = 0; const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => { while (true) { const index = cursor++; if (index >= values.length) return; result[index] = await fn(values[index]); } }); await Promise.all(workers); return result; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
