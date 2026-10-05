import fs from "node:fs/promises";
import path from "node:path";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { explorerOutputSchema, plannerOutputSchema, specAuthoringOutputSchema, type ExplorerOutput, type PlannerOutput, type SpecAuthoringOutput } from "../agents/outputContracts.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import { loadTaskContract } from "../core/config.js";
import { createRoutedContract } from "../core/contract.js";
import { computeWorktreeDigest } from "../core/git.js";
import { runTask, type TaskRunResult } from "../core/run.js";
import { validateSddChange } from "../core/sdd.js";
import { sealTask } from "../core/seal.js";
import { assertChangePreflightV1, normalizeTriageEvidence, triageChangeWithSemanticAssessment, type ChangePreflightV1, type TriageDecision } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { AssuranceLevel, ImplementationRoute, RouteEvidence } from "../architecture/contracts.js";
import { createRouteEvidence } from "../architecture/contracts.js";
import { createDelegatedFeatureCapsule, persistFeatureCapsule } from "../architecture/featureCapsule.js";
import { defaultSkillSeed } from "../participants/skills.js";
import { compileOpenSpecChange, persistOpenSpecAuthoringContentV1, preflightOpenSpec, prepareOpenSpecChange, validateOpenSpecAuthoringContentCanonicalityV1, type OpenSpecPreflightResult } from "../spec/openspec.js";
import { recordEvent } from "../telemetry/events.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { bindBootstrapOperationPolicy } from "./bootstrapPolicy.js";
import { resolveRecoveryAuthorityV1 } from "./recoveryAuthority.js";
import { requireDurableChangeHandoff, type DurableAgentEvidence } from "./changeHandoff.js";
import { projectedAuthorizedReadRoots } from "../paseo/launchSpec.js";
import { changeInputsPrompt, resolveChangeInputs, type ChangeInputReference } from "./changeInputs.js";
import {
  bindOperationCandidate,
  loadOperation,
  patchOperation,
  recordCandidateAssemblyReceipt,
  bindOperationExecutionSemantics,
  isProvisionalOperationPolicyV1,
  bindProductChoiceExecutionSemantics,
  bindResolvedOperationPolicy,
  completeOperationProductChoice,
  assertCurrentConsumedProductChoiceBinding,
  currentControllerEpoch,
  loadOperationProductChoiceCheckpoint,
  loadStaleConsumedProductChoiceCheckpointForReconfirmation,
  loadWaitingOperationProductChoiceCheckpointForReissue,
  markOperationProductChoiceConsumed,
  reissueOperationProductChoice,
  reconfirmStaleConsumedProductChoice,
  operationControlCheckpoint,
  resolveOperationStateRoot,
  resumeOperationProductChoice,
  suspendOperationForProductChoice,
  assertCurrentControllerOwner,
  currentOperationContext,
  setOperationStage,
  type ChangeOperationPayload,
  type OperationRecordV2
} from "./state.js";
import { candidateRevisionsEqual, createCandidateRevisionV1 } from "./v2Contracts.js";
import { drainOperationWriters } from "./control.js";
import { ensureOperationSupervisor, maybeRotateOperationSupervisor } from "./supervisor.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1 } from "../semantic/runtime.js";
import { launchManagedPaseoAgent } from "../paseo/runtime.js";
import { assertResolvedOperationPolicyV2, compileResolvedOperationPolicy } from "../architecture/executionIdentity.js";
import { sha256Canonical } from "../core/digest.js";
import { HumanDecisionLedgerV2, type DecisionChoiceV1, type HumanDecisionBindingV2 } from "../security/humanDecision.js";
import { deterministicParticipantId } from "../security/executionLease.js";
import { assertOperationOriginV1 } from "./operationProvenance.js";
import { assertIntentDecisionForRoute } from "../audit/intentDecision.js";

export interface ChangeOperationResult {
  taskId: string;
  route: ImplementationRoute;
  triageReasons: string[];
  run: TaskRunResult;
  specChange?: string;
}

export interface PreparedChangeOperation {
  triage: TriageDecision;
  semanticRuntime: Awaited<ReturnType<typeof createSemanticAssessmentRuntimeV1>>;
}

export async function resolveChangePreflightV1(
  root: string,
  config: HarnessProjectConfig,
  payload: ChangeOperationPayload,
  options: { launch?: typeof launchManagedPaseoAgent } = {}
): Promise<ChangePreflightV1> {
  if (currentOperationContext().id) throw new Error("CHANGE_PREFLIGHT_OPERATION_CONTEXT_FORBIDDEN: route/assurance triage must finish before a durable operation is created.");
  const evidence = { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk };
  const normalized = normalizeTriageEvidence(evidence);
  const semanticRuntime = await createSemanticAssessmentRuntimeV1(root, config, { profile: normalizeAgentProfile(payload.profile), ...(options.launch ? { launch: options.launch } : {}) });
  const repositoryBinding = await createSemanticRepositoryBindingV1(root, config);
  const binding = {
    ...repositoryBinding,
    intentDigest: sha256Canonical({ request: payload.request, files: normalized.files, domains: normalized.domains, risk: normalized.risk, flags: normalized.flags })
  };
  const triage = await triageChangeWithSemanticAssessment(config, evidence, { service: semanticRuntime.service, binding, policyRevision: semanticRuntime.policyRevision });
  if (triage.route === "DELEGATED") delegatedCapsuleObjectiveV1(payload);
  return { version: 1, triage, binding };
}

/** Select and validate the concise capsule objective before a CHANGE operation is persisted. */
export function delegatedCapsuleObjectiveV1(payload: ChangeOperationPayload): string {
  if (!payload.intentDecision) {
    throw new Error("DELEGATED_CAPSULE_OBJECTIVE_REQUIRED: delegated changes require a validated operationIntent.requestedOutcome of 1–500 characters; the full request will remain in the TaskContract.");
  }
  const objective = assertIntentDecisionForRoute(payload.intentDecision, "change").requestedOutcome.trim();
  if (!objective || objective.length > 500) {
    throw new Error("DELEGATED_CAPSULE_OBJECTIVE_INVALID: operationIntent.requestedOutcome must be a concise, complete objective of 1–500 characters for a delegated change.");
  }
  return objective;
}

interface ProductChoiceDraftV1 {
  issue: string;
  whatTried: string[];
  whyUnresolvable: string;
  choices: DecisionChoiceV1[];
  workThatCanContinue: string[];
}

interface ProductChoiceCheckpointV1 {
  version: 1;
  taskId: string;
  title: string;
  changeName: string;
  triageReasons: string[];
  priorSelections: ProductChoiceSelectionV1[];
  decisionDraft: ProductChoiceDraftV1;
  blockedResult: DurableAgentEvidence<SpecAuthoringOutput>;
  explorerEvidence?: DurableAgentEvidence<ExplorerOutput>;
  plannerEvidence?: DurableAgentEvidence<PlannerOutput>;
  inputs: ChangeInputReference[];
}

interface ProductChoiceSelectionV1 {
  requestId: string;
  decisionId: string;
  choiceId: string;
  choice: DecisionChoiceV1;
  reason: string;
}

/** Resolve route and assurance before the controller authorizes bootstrap effects. */
export async function prepareChangeOperation(
  root: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  payload: ChangeOperationPayload
): Promise<PreparedChangeOperation> {
  const semanticRuntime = await createSemanticAssessmentRuntimeV1(root, config, { profile: normalizeAgentProfile(payload.profile) });
  const evidence = { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk };
  const normalized = normalizeTriageEvidence(evidence);
  const repositoryBinding = await createSemanticRepositoryBindingV1(root, config);
  const expectedBinding = {
    ...repositoryBinding,
    intentDigest: sha256Canonical({ request: payload.request, files: normalized.files, domains: normalized.domains, risk: normalized.risk, flags: normalized.flags })
  };
  if (!operation.changePreflight) throw new Error("CHANGE_PREFLIGHT_REQUIRED: detached CHANGE operations must carry pre-operation route/assurance evidence.");
  const preflight = assertChangePreflightV1(operation.changePreflight, { binding: expectedBinding, evidence });
  let independentlyValidatedTriage: TriageDecision;
  try {
    independentlyValidatedTriage = await triageChangeWithSemanticAssessment(config, evidence, {
      service: semanticRuntime.service,
      binding: expectedBinding,
      policyRevision: semanticRuntime.policyRevision
    });
  } catch (error) {
    throw new Error(`CHANGE_PREFLIGHT_ASSESSMENT_EVIDENCE_UNAVAILABLE: current operation cannot revalidate its pre-operation semantic assessment from the durable cache: ${String(error)}`, { cause: error });
  }
  if (sha256Canonical(independentlyValidatedTriage) !== sha256Canonical(preflight.triage)) {
    throw new Error("CHANGE_PREFLIGHT_ASSESSMENT_STALE: recomputed current route/assurance triage does not match the persisted preflight result.");
  }
  if (operation.intent?.route !== preflight.triage.route || (operation.intent?.assurance !== preflight.triage.assurance
    && !(operation.origin?.kind === "FAILED_OPERATION_RECOVERY" && operation.intent?.assurance === (await recoveryAssuranceFloor(root, operation, preflight.triage.assurance))))) {
    throw new Error("CHANGE_PREFLIGHT_OPERATION_INTENT_MISMATCH: durable intent does not match the validated pre-operation triage.");
  }
  const assurance = await recoveryAssuranceFloor(root, operation, independentlyValidatedTriage.assurance);
  const triage = assurance === independentlyValidatedTriage.assurance ? independentlyValidatedTriage : {
    ...independentlyValidatedTriage,
    assurance,
    reasons: [...independentlyValidatedTriage.reasons, `linked failed-operation recovery inherits the parent minimum assurance ${assurance}`]
  };
  if (triage.route === "DELEGATED") delegatedCapsuleObjectiveV1(payload);
  return { triage, semanticRuntime };
}

async function recoveryAssuranceFloor(root: string, operation: OperationRecordV2, assurance: AssuranceLevel): Promise<AssuranceLevel> {
  if (operation.origin?.kind !== "FAILED_OPERATION_RECOVERY") return assurance;
  assertOperationOriginV1(operation.origin);
  const parent = await loadOperation(root, operation.origin.parentOperationId!);
  if (parent.status !== "FAILED" || parent.revision !== operation.origin.parentTerminalRevision) {
    throw new Error("OPERATION_RECOVERY_PARENT_STALE: the failed parent revision or frozen policy changed.");
  }
  const authority = await resolveRecoveryAuthorityV1(root, parent);
  return inheritAssuranceFloorV1(assurance, authority.policy.minimumAssurance);
}

export function inheritAssuranceFloorV1(assurance: AssuranceLevel, parentMinimum: AssuranceLevel): AssuranceLevel {
  return minimumAssuranceRank(assurance) >= minimumAssuranceRank(parentMinimum) ? assurance : parentMinimum;
}

function minimumAssuranceRank(value: AssuranceLevel): number { return value === "NONE" ? 0 : value === "STANDARD" ? 1 : value === "ELEVATED" ? 2 : 3; }

export async function runChangeOperation(
  root: string,
  controlRoot: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  payload: ChangeOperationPayload,
  prepared?: PreparedChangeOperation
): Promise<ChangeOperationResult> {
  const taskId = payload.taskId?.trim() || operation.id;
  const title = payload.title?.trim() || payload.request.slice(0, 120) || `Change ${taskId}`;
  const preparation = prepared ?? await prepareChangeOperation(root, config, operation, payload);
  const semanticRuntime = preparation.semanticRuntime;
  let triage = preparation.triage;
  let route = triage.route;
  if (route === "DELEGATED") delegatedCapsuleObjectiveV1(payload);
  const persisted = await loadOperation(controlRoot, operation.id);
  if (persisted.continuation) return resumeProductChoiceContinuation(root, controlRoot, config, persisted, payload, semanticRuntime);
  let bootstrapContract = operationBootstrapContract(taskId, title, payload, route, triage.assurance, triage.routeEvidence);
  await createControlPlaneSnapshot(root, config, taskId);

  await setOperationStage(controlRoot, operation.id, "input-resolution", "RUNNING");
  const inputs = await resolveChangeInputs(controlRoot, operation.id, payload.request);
  await setOperationStage(controlRoot, operation.id, "input-resolution", "COMPLETED", {
    artifact: inputs[0]?.artifact,
    message: inputs.length ? `${inputs.length} durable input artifact(s) frozen.` : "No external durable inputs referenced."
  });

  await setOperationStage(controlRoot, operation.id, "triage", "RUNNING");
  let triageReasons = triage.reasons;
  const current = await loadOperation(controlRoot, operation.id);
  await patchOperation(controlRoot, operation.id, { intent: { ...current.intent, request: payload.request, classification: "CHANGE", route: triage.route, assurance: triage.assurance, risk: payload.risk ?? "low", priority: payload.priority ?? current.intent?.priority } });
  await setOperationStage(controlRoot, operation.id, "triage", "COMPLETED", { message: `${route}/${triage.assurance}: ${triageReasons.join("; ")}` });

  let specPreflight: OpenSpecPreflightResult | undefined;
  if (route === "FORMAL_SDD") {
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "RUNNING");
    specPreflight = await preflightOpenSpec(root, config);
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "COMPLETED", {
      message: `OpenSpec ${specPreflight.version}; schema=${specPreflight.schema}; manager=${specPreflight.managerAgent}`
    });
  } else {
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "SKIPPED", { message: "Canonical direct/delegated routes do not require formal SDD authoring." });
  }

  const topology = await loadResolvedAgentTopology(root, config, normalizeAgentProfile(payload.profile) ?? config.agents?.activeProfile);
  const supervisorAgent = topology.agents["operation-supervisor"];
  const supervisorSelection = supervisorAgent && !supervisorAgent.disabled ? executionSelectionForAgent(topology, "operation-supervisor") : undefined;
  const explorerAgent = topology.agents.explorer;
  const explorerSelection = explorerAgent && !explorerAgent.disabled ? executionSelectionForAgent(topology, "explorer") : undefined;
  const plannerAgent = topology.agents.planner;
  const plannerSelection = plannerAgent && !plannerAgent.disabled ? executionSelectionForAgent(topology, "planner") : undefined;
  if (specPreflight) {
    const manager = topology.agents[specPreflight.managerAgent];
    if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${specPreflight.managerAgent}`);
  }
  if (route === "DELEGATED" || route === "FORMAL_SDD") await ensureOperationSupervisor(root, config, bootstrapContract, supervisorSelection, { required: true, forceMaterialize: true });

  const explorerEvidence = route === "DELEGATED" || route === "FORMAL_SDD" ? await (async () => { await setOperationStage(controlRoot, operation.id, "discovery", "RUNNING"); return runDiscovery(root, controlRoot, config, bootstrapContract, explorerSelection, operation.id, payload, inputs); })() : undefined;
  if (route === "DELEGATED" || route === "FORMAL_SDD") await setOperationStage(controlRoot, operation.id, "discovery", "COMPLETED", {
    artifact: explorerEvidence?.artifact,
    message: explorerEvidence ? "Explorer durable result accepted." : "Explorer disabled or unavailable by topology."
  });
  if (route === "DELEGATED" || route === "FORMAL_SDD") await maybeRotateOperationSupervisor(root, config, bootstrapContract, supervisorSelection);

  let plannerEvidence: DurableAgentEvidence<PlannerOutput> | undefined;
  const planAgainstSealedContract = async (sealed: TaskContract): Promise<DurableAgentEvidence<PlannerOutput> | undefined> => {
    await setOperationStage(controlRoot, operation.id, "planning", "RUNNING");
    const evidence = await runPlanning(root, controlRoot, config, sealed, plannerSelection, operation.id, payload, explorerEvidence, inputs);
    await setOperationStage(controlRoot, operation.id, "planning", "COMPLETED", { artifact: evidence?.artifact, message: evidence ? "Planner durable result accepted against the sealed TaskContract." : "Planner disabled or unavailable by topology." });
    return evidence;
  };

  let contract: TaskContract | undefined;
  let specChange: string | undefined;
  if (route === "DELEGATED") {
    // TARGET 4.2: the WorkGraph is derived from frozen requirements. For DELEGATED the routed
    // TaskContract is deterministic (acceptance-derived requirement IDs), so it is authored and
    // sealed before planning; the Planner receives the exact frozen requirement IDs. Planning
    // before the contract existed made every plan reference unknowable IDs and fail the WorkGraph
    // contract check (AEH-V2-0110).
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "RUNNING");
    const capsule = createDelegatedFeatureCapsule({ taskId, objective: delegatedCapsuleObjectiveV1(payload), scope: { allowed: payload.files?.length ? payload.files : ["**"], forbidden: [] }, acceptance: payload.acceptance, assurance: triage.assurance, routeEvidence: triage.routeEvidence, candidateRevision: (await loadOperation(controlRoot, operation.id)).candidateRevision as unknown as Record<string, unknown> });
    const capsuleArtifact = await persistFeatureCapsule(root, capsule);
    const routed = await createRoutedContract(root, config, taskId, { title, request: payload.request, scope: capsule.scope?.allowed ?? ["**"], acceptance: payload.acceptance, domains: payload.domains, risk: payload.risk, profile: payload.profile, routeDecision: triage });
    contract = { ...routed.contract, scope: capsule.scope };
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "COMPLETED", { artifact: capsuleArtifact });

    plannerEvidence = await planAgainstSealedContract(contract);
    const specEscalation = specEscalationConstraintV1(plannerEvidence);
    if (specEscalation) {
      route = "FORMAL_SDD";
      triage = formalizeEscalatedTriage(triage);
      bootstrapContract = operationBootstrapContract(taskId, title, payload, route, triage.assurance, triage.routeEvidence);
      triageReasons = [...triageReasons, "SPEC escalation came from the Planner's typed formalization need."];
      await patchOperation(controlRoot, operation.id, { intent: { ...(await loadOperation(controlRoot, operation.id)).intent, route, assurance: triage.assurance } });
      await recordEvent(controlRoot, config, "harness.change.triage-escalated", {
        operationId: operation.id,
        reason: triageReasons.at(-1),
        constraint: specEscalation.constraint,
        plannerArtifact: plannerEvidence?.artifact,
        plannerFormalizationNeed: specEscalation.plannerFormalizationNeed,
        plannerFormalizationReason: specEscalation.plannerFormalizationReason ?? null,
        plannerFormalizationEvidenceRefs: specEscalation.plannerFormalizationEvidenceRefs,
        explorerArtifact: explorerEvidence?.artifact,
        explorerFindings: (explorerEvidence?.payload.findings ?? []).map((finding) => ({ id: finding.id, status: finding.status, evidenceRefs: finding.evidence.length }))
      });
      await setOperationStage(controlRoot, operation.id, "environment-preflight", "RUNNING");
      specPreflight = await preflightOpenSpec(root, config);
      await setOperationStage(controlRoot, operation.id, "environment-preflight", "COMPLETED", { message: `OpenSpec ${specPreflight.version}; schema=${specPreflight.schema}; manager=${specPreflight.managerAgent}` });
      const manager = topology.agents[specPreflight.managerAgent];
      if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${specPreflight.managerAgent}`);
      // Escalation changes the execution semantics (route and assurance). The frozen policy must be
      // advanced and rebound deterministically before any FORMAL_SDD participant launches; otherwise
      // the Spec Manager identity compiles against the superseded DELEGATED policy and fails closed
      // with EXECUTION_POLICY_STALE (AEH-V2-0107).
      await rebindEscalatedChangePolicy({
        controlRoot,
        operationId: operation.id,
        route,
        assurance: triage.assurance,
        escalationEvidence: { explorerArtifact: explorerEvidence?.artifact, plannerArtifact: plannerEvidence?.artifact }
      });
      // The plan derived from the superseded DELEGATED contract cannot be reused against the
      // compiled formal contract (different frozen requirement IDs). It remains provenance for the
      // escalation; planning runs again after compilation against the frozen formal requirements.
      plannerEvidence = undefined;
    }
  }
  // This chain is evaluated after the DELEGATED branch so a Planner-driven escalation enters the
  // formalization path in the same operation (the local `route` mutation must not be skipped by a
  // branch selected before the escalation).
  if (route === "DIRECT") {
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "RUNNING");
    const routed = await createRoutedContract(root, config, taskId, { title, request: payload.request, scope: payload.files ?? [], acceptance: payload.acceptance, domains: payload.domains, risk: payload.risk, profile: payload.profile, routeDecision: triage });
    contract = routed.contract;
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "COMPLETED", { artifact: relativeContract(config, taskId) });
  } else if (route === "FORMAL_SDD") {
    if (!specPreflight) throw new Error("SPEC_PREFLIGHT_STATE: formal SDD authoring reached without a completed OpenSpec preflight.");
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "RUNNING");
    const preparedSpec = await prepareOpenSpecChange(root, config, taskId);
    specChange = preparedSpec.changeName;
    if (preparedSpec.managerAgent !== specPreflight.managerAgent) throw new Error(`SPEC_MANAGER_PREFLIGHT_DRIFT: preflight=${specPreflight.managerAgent} prepared=${preparedSpec.managerAgent}`);
    const selection = executionSelectionForAgent(topology, preparedSpec.managerAgent);
    const specEvidence = await runSpecManagerUntilReady({
      root, controlRoot, config, operationId: operation.id, payload, bootstrapContract, selection,
      changeName: preparedSpec.changeName, explorerEvidence, plannerEvidence, inputs, taskId, title, triageReasons
    });
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "COMPLETED", { artifact: specEvidence.artifact });
    await maybeRotateOperationSupervisor(root, config, bootstrapContract, supervisorSelection);

    await awaitChangeControlCheckpoint(controlRoot, operation.id);
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "RUNNING");
    await compileOpenSpecChange(root, config, taskId, title, preparedSpec.changeName, undefined, payload.request);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`SDD validation failed after OpenSpec compilation: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    contract.routing = { ...contract.routing, route, assurance: triage.assurance, routeEvidence: triage.routeEvidence };
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "COMPLETED", { artifact: relativeContract(config, taskId) });
    // AEH-V2-0126: the controller-owned authoring persistence and OpenSpec compilation changed the
    // candidate workspace after its binding. Advance the candidate lineage deterministically before
    // any further execution binding is consumed (the Planner launch and its accepted result bind
    // the advanced candidate).
    const authoringAdvance = await advanceCandidateForControllerAuthoring({ root, controlRoot, config, operationId: operation.id, taskId, changeName: preparedSpec.changeName, route, assurance: triage.assurance, contract });
    await recordEvent(controlRoot, config, "harness.change.authoring-candidate-advance", {
      operationId: operation.id,
      taskId,
      changeName: preparedSpec.changeName,
      advanced: authoringAdvance.advanced,
      candidateRevision: authoringAdvance.revision,
      candidateIdentityDigest: authoringAdvance.identityDigest
    });
    const choiceOperation = await loadOperation(controlRoot, operation.id);
    if (choiceOperation.continuation?.state === "RESUMING" && choiceOperation.continuation.selectedDecisionId && choiceOperation.continuation.selectedChoiceId) {
      const priorPolicy = choiceOperation.resolvedOperationPolicy;
      if (!priorPolicy) throw new Error("DECISION_POLICY_STALE: product-choice revalidation has no current policy to rebind.");
      const choiceCheckpoint = parseProductChoiceCheckpoint(await loadOperationProductChoiceCheckpoint(controlRoot, operation.id));
      const requirementDigest = sha256Canonical({ requirements: contract.requirements ?? [], specChange: preparedSpec.changeName });
      const rebound = await bindProductChoiceExecutionSemantics(controlRoot, operation.id, {
        requirementDigest,
        decisionId: choiceOperation.continuation.selectedDecisionId,
        choiceId: choiceOperation.continuation.selectedChoiceId,
        priorDecisionIds: choiceCheckpoint.priorSelections.map((item) => item.decisionId)
      });
      const { version: _version, digest: _digest, ...policyBody } = priorPolicy;
      const currentPolicy = compileResolvedOperationPolicy({
        ...policyBody,
        operationExecutionRevision: rebound.operationExecutionRevision!,
        controllerEpoch: currentControllerEpoch(rebound)
      });
      await bindResolvedOperationPolicy(controlRoot, operation.id, currentPolicy);
      await resumeOperationProductChoice(controlRoot, operation.id);
    }
    // TARGET 4.1/4.2: formalization precedes the WorkGraph. The compiled, sealed formal contract is
    // the frozen requirement source, so planning runs against its exact requirement IDs.
    await awaitChangeControlCheckpoint(controlRoot, operation.id);
    plannerEvidence = await planAgainstSealedContract(contract);
  }

  if (!contract) throw new Error(`CHANGE_CONTRACT_MISSING: route ${route} reached implementation without a sealed TaskContract.`);
  await awaitChangeControlCheckpoint(controlRoot, operation.id);
  await setOperationStage(controlRoot, operation.id, "implementation", "RUNNING");
  const run = await runTask(root, config, contract, { profile: payload.profile, planning: plannerEvidence?.payload, semanticRuntime });
  await setOperationStage(controlRoot, operation.id, "implementation", run.status === "PASS" ? "COMPLETED" : "FAILED");
  if ((await loadOperation(controlRoot, operation.id)).continuation?.state === "RESUMING") await completeOperationProductChoice(controlRoot, operation.id);
  await recordEvent(controlRoot, config, "harness.change.finish", { operationId: operation.id, taskId, route, status: run.status, triageReasons, specChange, inputArtifacts: inputs.map((item) => item.artifact) });
  return { taskId, route, triageReasons, run, specChange };
}

/**
 * DETERMINISTIC spec-escalation policy advance. Durable explorer/planner evidence may escalate a
 * DELEGATED change to FORMAL_SDD with a higher assurance; that is an execution-semantics change, so
 * the operation execution revision advances, the superseded policy is cleared, and a policy with
 * the escalated route/assurance is recompiled for the current candidate and epoch. Repeating the
 * same escalation is idempotent (same semantics digest, identical policy).
 */
export async function rebindEscalatedChangePolicy(input: {
  controlRoot: string;
  operationId: string;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  escalationEvidence: Record<string, unknown>;
}): Promise<OperationRecordV2> {
  const current = await loadOperation(input.controlRoot, input.operationId);
  const prior = current.resolvedOperationPolicy;
  if (!prior || !current.candidateRevision) throw new Error("EXECUTION_POLICY_INPUT_MISSING: spec escalation requires the current frozen policy and candidate to rebind.");
  assertResolvedOperationPolicyV2(prior);
  const semanticsDigest = sha256Canonical({
    kind: "SPEC_ESCALATION",
    operationId: input.operationId,
    route: input.route,
    assurance: input.assurance,
    candidateId: current.candidateRevision.candidateId,
    candidateDigest: current.candidateRevision.identityDigest,
    ...input.escalationEvidence
  });
  if (current.executionSemanticsDigest === semanticsDigest && prior.route === input.route && prior.minimumAssurance === input.assurance) return current;
  if (current.executionSemanticsDigest === undefined && !isProvisionalOperationPolicyV1(prior)) {
    // Canonical first-bind deliberately preserves the frozen policy (the digest baseline is not a
    // change). The superseded policy was frozen before any digest existed, so establish that
    // baseline first and let the escalation itself be the semantics change that invalidates it.
    // A provisional bootstrap policy is superseded directly by the first real semantics bind.
    await bindOperationExecutionSemantics(input.controlRoot, input.operationId, sha256Canonical({
      kind: "CHANGE_SEMANTICS_BASELINE",
      operationId: input.operationId,
      candidateId: current.candidateRevision.candidateId,
      candidateDigest: current.candidateRevision.identityDigest,
      route: prior.route,
      assurance: prior.minimumAssurance,
      policyDigest: prior.digest
    }));
  }
  const advanced = await bindOperationExecutionSemantics(input.controlRoot, input.operationId, semanticsDigest);
  const { version: _version, digest: _digest, ...policyBody } = prior;
  const priorReview = policyBody.reviewPolicy && typeof policyBody.reviewPolicy === "object" && !Array.isArray(policyBody.reviewPolicy)
    ? policyBody.reviewPolicy as Record<string, unknown>
    : {};
  const escalated = compileResolvedOperationPolicy({
    ...policyBody,
    route: input.route,
    minimumAssurance: input.assurance,
    reviewPolicy: { ...priorReview, minimumAssurance: input.assurance, independentReviewRequired: input.assurance === "ELEVATED" || input.assurance === "CRITICAL" },
    operationExecutionRevision: advanced.operationExecutionRevision!,
    controllerEpoch: currentControllerEpoch(advanced)
  });
  await bindResolvedOperationPolicy(input.controlRoot, input.operationId, escalated);
  return loadOperation(input.controlRoot, input.operationId);
}

/**
 * DETERMINISTIC controller-authoring candidate advance (AEH-V2-0126). FORMAL_SDD persists the
 * validated Spec Manager content and compiles the sealed OpenSpec artifacts into the bound
 * candidate workspace after the candidate was frozen. Those controller-owned writes change the
 * workspace source digest, so the next participant launch (and the Planner's accepted result)
 * would be rejected `CANDIDATE_WORKSPACE_MISMATCH` against the stale binding. This advance binds
 * exactly one successor CandidateRevision for the authored transition, records the deterministic
 * ASSEMBLY lineage receipt for the authored change (the Spec Manager is the producing bounded
 * participant), and invalidates the frozen policy and participant execution bindings through the
 * canonical `bindOperationCandidate` path; the next launch recompiles the policy for the advanced
 * candidate. It is idempotent: an unchanged workspace digest never advances a revision.
 */
export async function advanceCandidateForControllerAuthoring(input: {
  root: string;
  controlRoot: string;
  config: HarnessProjectConfig;
  operationId: string;
  taskId: string;
  changeName: string;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  contract?: TaskContract;
}): Promise<{ advanced: boolean; revision: number; identityDigest: string }> {
  const current = await loadOperation(input.controlRoot, input.operationId);
  const base = current.candidateRevision;
  if (!base) throw new Error("CANDIDATE_BINDING_REQUIRED: controller authoring cannot advance without a current CandidateRevision.");
  const sourceDigest = await computeWorktreeDigest(input.root);
  if (sourceDigest === base.sourceDigest) return { advanced: false, revision: base.revision, identityDigest: base.identityDigest };
  const advanced = createCandidateRevisionV1({
    operationId: input.operationId,
    candidateId: `candidate:${input.operationId}:r${base.revision + 1}`,
    projectId: base.projectId,
    taskId: base.taskId,
    revision: base.revision + 1,
    parentCandidateId: base.candidateId,
    sourceDigest,
    workspace: current.workspaceId,
    worktree: input.root,
    createdAt: new Date().toISOString()
  });
  await bindOperationCandidate(input.controlRoot, input.operationId, advanced);
  const rebound = await loadOperation(input.controlRoot, input.operationId);
  await recordCandidateAssemblyReceipt(input.controlRoot, input.operationId, {
    baseCandidate: base,
    candidate: advanced,
    changeSet: {
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: `authoring:${input.changeName}`,
      participantId: controllerAuthoringParticipantId(rebound, input.operationId),
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      patchDigest: await controllerAuthoringPatchDigest(input.root, input.changeName, input.taskId)
    }
  });
  // Binding a candidate clears the frozen policy. The controller-owned authoring advance must
  // re-establish the provisional bootstrap policy for the advanced candidate exactly like a
  // workspace-candidate bind does; otherwise the first execution-semantics bind (wave planning)
  // preserves the launch-compiled policy at the same execution revision and fails
  // EXECUTION_POLICY_RECOMPILE_REQUIRED.
  await bindBootstrapOperationPolicy(input.controlRoot, input.config, await loadOperation(input.controlRoot, input.operationId), input.route, input.assurance, input.contract);
  return { advanced: true, revision: advanced.revision, identityDigest: advanced.identityDigest };
}

function controllerAuthoringParticipantId(operation: OperationRecordV2, operationId: string): string {
  const participants = Object.values(operation.participants);
  const launchIdentity = participants.find((participant) => participant.role === "Spec Manager" && /^participant:[0-9a-f]{16}$/.test(participant.id));
  const anySpecManager = participants.find((participant) => participant.role === "Spec Manager");
  return launchIdentity?.id ?? anySpecManager?.id ?? deterministicParticipantId(operationId, "spec-manager", "spec-authoring");
}

/** Content-bound digest of the authored OpenSpec change directory (the controller-authoring patch). */
async function controllerAuthoringPatchDigest(root: string, changeName: string, taskId: string): Promise<string> {
  const directory = path.join(root, "openspec", "changes", changeName);
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(directory);
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const file of files.sort()) {
    entries.push({ path: path.relative(root, file).replaceAll("\\", "/"), sha256: sha256Canonical(await fs.readFile(file, "utf8")) });
  }
  return sha256Canonical({ version: 1, taskId, changeName, files: entries });
}

export interface SpecEscalationConstraintV1 {
  constraint: "PLANNER_FORMALIZATION_NEED_REQUIRED";
  plannerFormalizationNeed: "REQUIRED";
  plannerFormalizationReason?: string;
  plannerFormalizationEvidenceRefs: string[];
}

/**
 * DETERMINISTIC post-discovery escalation constraint for the HYBRID route. The Planner owns the
 * typed semantic `formalizationNeed` judgment over its evidence (including durable Explorer
 * findings); this constraint escalates a DELEGATED route to FORMAL_SDD only when that judgment is
 * `REQUIRED`. Explorer finding statuses are discovery-quality facts (CONFIRMED/PARTIAL/
 * NOT_REPRODUCED/BLOCKED) — for example a PARTIAL finding may mean the Explorer could not execute a
 * validator in its read-only session — and are not by themselves a formalization need. Incomplete
 * discovery that needs formal authoring must surface through the Planner's typed judgment with its
 * reason and evidence refs, which are recorded as durable escalation provenance (AEH-V2-0110).
 */
export function specEscalationConstraintV1(plannerEvidence?: DurableAgentEvidence<PlannerOutput>): SpecEscalationConstraintV1 | undefined {
  if (plannerEvidence?.payload.formalizationNeed !== "REQUIRED") return undefined;
  return {
    constraint: "PLANNER_FORMALIZATION_NEED_REQUIRED",
    plannerFormalizationNeed: "REQUIRED",
    ...(plannerEvidence.payload.formalizationReason ? { plannerFormalizationReason: plannerEvidence.payload.formalizationReason } : {}),
    plannerFormalizationEvidenceRefs: [...(plannerEvidence.payload.formalizationEvidenceRefs ?? [])]
  };
}

export function requiresSpecEscalation(plannerEvidence?: DurableAgentEvidence<PlannerOutput>): boolean {
  return Boolean(specEscalationConstraintV1(plannerEvidence));
}

export function formalizeEscalatedTriage(triage: TriageDecision): TriageDecision {
  const route: ImplementationRoute = "FORMAL_SDD";
  return {
    ...triage,
    route,
    assurance: triage.assurance === "CRITICAL" ? "CRITICAL" : "ELEVATED",
    routeEvidence: [createRouteEvidence(route, "durable-change-evidence", "Durable discovery or planning evidence escalated this change to formal SDD.")],
    reasons: [...triage.reasons, "Durable discovery or planning evidence requires formal SDD."]
  };
}

export function normalizeAgentProfile(profile?: string): string | undefined {
  const value = profile?.trim();
  if (!value || /^(formal-sdd|change|audit|run)$/i.test(value)) return undefined;
  return value;
}

/** Deterministic Explorer prompt contract (AEH-V2-0125 regression surface). */
export function buildExplorerPrompt(operationId: string, payload: ChangeOperationPayload, inputs: ChangeInputReference[], readRoots: string[] = []): string {
  return [
    "Perform bounded repository discovery for this CHANGE operation.",
    `Operation: ${operationId}`,
    `Request: ${payload.request}`,
    `Explicit files: ${(payload.files ?? []).join(", ") || "none"}`,
    `Domains: ${(payload.domains ?? []).join(", ") || "unspecified"}`,
    `Frozen readable roots (exact projection):\n${readRoots.length ? readRoots.map((root) => `- ${root}`).join("\n") : "- unavailable; do not search outside the current repository root"}`,
    "Use repository-relative paths in evidence. Search only the frozen readable roots listed above. Do not search prior or sibling worktrees, home directories, /tmp, or any other path outside this lease. Symlinks do not grant access to their targets outside these roots. If a tool raises an out-of-scope permission prompt, discovery ends; do not approve it. Return BLOCKED when in-scope evidence is insufficient.",
    changeInputsPrompt(inputs),
    "Return the explorer output contract with only relevant files/symbols/tests/module boundaries, verified finding status and concrete evidence. Do not implement, author specs or start another AEH workflow.",
    "Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object matching the explorer output contract; a turn without that marker is rejected as EXPLORER_RESULT_ARTIFACT_MISSING."
  ].join("\n\n");
}

async function runDiscovery(
  root: string,
  controlRoot: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection | undefined,
  operationId: string,
  payload: ChangeOperationPayload,
  inputs: ChangeInputReference[]
): Promise<DurableAgentEvidence<ExplorerOutput> | undefined> {
  if (!selection) return undefined;
  const readRoots = await projectedAuthorizedReadRoots(root, selection, controlRoot);
  const session = await executeAgentPrompt(root, config, contract, selection, buildExplorerPrompt(operationId, payload, inputs, readRoots), { outputContract: "explorer", phase: "discovery", operationKind: "change", requireExecutionAuthority: true });
  return requireDurableChangeHandoff(root, "EXPLORER", session, explorerOutputSchema, controlRoot, { operationId: operationId, contract: "explorer", phase: "discovery" });
}

/** Deterministic Planner prompt contract (AEH-V2-0125 regression surface). */
export function buildPlannerPrompt(operationId: string, contract: TaskContract, payload: ChangeOperationPayload, explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined, inputs: ChangeInputReference[]): string {
  const explorerContext = explorerEvidence
    ? [`Explorer durable result artifact: ${explorerEvidence.artifact}`, `Explorer evidence projection:\n${compactJson(explorerEvidence.payload, 12_000)}`].join("\n")
    : "Explorer is disabled/unavailable by topology; no explorer result was expected.";
  const requirementLines = (contract.requirements ?? []).map((requirement) => `- ${requirement.id}: ${requirement.description ?? ""}`).join("\n")
    || "- none: the sealed TaskContract declares no requirement ids, so leave requirementRefs and acceptanceRefs empty.";
  const knownCompetencyIds = [...new Set(defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)))].sort();
  return [
    "Produce planning/triage evidence only for this CHANGE operation. Do not implement or author the specification.",
    `Operation: ${operationId}`,
    `Request: ${payload.request}`,
    changeInputsPrompt(inputs),
    explorerContext,
    `Sealed TaskContract requirement ids (immutable; map every id to at least one work unit and use only these exact ids in requirementRefs and acceptanceRefs):\n${requirementLines}`,
    `Known competency ids (use only these controlled ids for workUnits[].competencies when the work matches; a competency outside this set must genuinely require researched knowledge and will be checked by the deterministic KnowledgeGate): ${knownCompetencyIds.join(", ")}`,
    "Identify affected areas, dependencies, bounded implementer ownership, reviewers and deterministic validation gates. Keep normative requirements unchanged. Every workUnits[].objective must be concise, non-empty, and no longer than 500 characters, matching the Planner output schema and WorkGraph compiler.",
    "Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object matching the planner output contract; a turn without that marker is rejected as PLANNER_RESULT_ARTIFACT_MISSING."
  ].join("\n\n");
}

async function runPlanning(
  root: string,
  controlRoot: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection | undefined,
  operationId: string,
  payload: ChangeOperationPayload,
  explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined,
  inputs: ChangeInputReference[]
): Promise<DurableAgentEvidence<PlannerOutput> | undefined> {
  if (!selection) return undefined;
  const session = await executeAgentPrompt(root, config, contract, selection, buildPlannerPrompt(operationId, contract, payload, explorerEvidence, inputs), { outputContract: "planner", phase: "planning", operationKind: "change", requireExecutionAuthority: true });
  return requireDurableChangeHandoff(root, "PLANNER", session, plannerOutputSchema, controlRoot, { operationId, contract: "planner", phase: "planning" });
}

/**
 * Controller-owned pause checkpoint. Applies a pending scoped PAUSE only after
 * active mutable writers are drained, then blocks until a scoped RESUME or a
 * terminal state. A non-quiescent drain leaves the request pending.
 */
async function awaitChangeControlCheckpoint(controlRoot: string, operationId: string): Promise<void> {
  const receipt = await drainOperationWriters(controlRoot, operationId, { timeoutMs: 30_000 });
  await operationControlCheckpoint(controlRoot, operationId, receipt);
}

/**
 * DETERMINISTIC bounded retry budget for the Spec Manager change-echo defect
 * (CHANGE-20261005T033416Z-be9f5ac1 rev57: `SPEC_MANAGER_CHANGE_MISMATCH` when the
 * model echoes a title string instead of the exact OpenSpec change slug). Exactly one
 * retry is allowed per `runSpecManagerUntilReady` invocation; a second mismatch still
 * throws the exact-equality error. No normalization or fuzzy-match is applied.
 */
export const SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES = 1;

export function isSpecManagerChangeMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("SPEC_MANAGER_CHANGE_MISMATCH:");
}

export function shouldRetrySpecManagerChangeMismatch(error: unknown, retriesSoFar: number): boolean {
  return isSpecManagerChangeMismatch(error) && retriesSoFar < SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES;
}

export function buildSpecManagerMismatchRetryNote(changeName: string): string {
  return `Previous Spec Manager turn failed with SPEC_MANAGER_CHANGE_MISMATCH: output field "change" must be exactly '${changeName}' (the OpenSpec change ID); it is an identifier, not a title. Retry with the exact identifier.`;
}

async function runSpecManagerUntilReady(input: {
  root: string;
  controlRoot: string;
  config: HarnessProjectConfig;
  operationId: string;
  payload: ChangeOperationPayload;
  bootstrapContract: TaskContract;
  selection: AgentExecutionSelection;
  changeName: string;
  taskId: string;
  title: string;
  triageReasons: string[];
  explorerEvidence?: DurableAgentEvidence<ExplorerOutput>;
  plannerEvidence?: DurableAgentEvidence<PlannerOutput>;
  inputs: ChangeInputReference[];
  initialChoice?: ProductChoiceSelectionV1;
  priorSelections?: ProductChoiceSelectionV1[];
}): Promise<DurableAgentEvidence<SpecAuthoringOutput>> {
  let selectedChoice = input.initialChoice;
  let changeMismatchRetries = 0;
  let mismatchRetryPending = false;
  for (;;) {
    await awaitChangeControlCheckpoint(input.controlRoot, input.operationId);
    const basePrompt = buildSpecManagerPrompt(input.payload, input.changeName, input.explorerEvidence, input.plannerEvidence, input.inputs, selectedChoice);
    const prompt = mismatchRetryPending ? `${basePrompt}\n\n${buildSpecManagerMismatchRetryNote(input.changeName)}` : basePrompt;
    mismatchRetryPending = false;
    const specSession = await executeAgentPrompt(
      input.root, input.config, input.bootstrapContract, input.selection,
      prompt,
      { outputContract: "spec-authoring", phase: "spec-authoring", operationKind: "change", requireExecutionAuthority: true }
    );
    const evidence = await requireDurableChangeHandoff(input.root, "SPEC_MANAGER", specSession, specAuthoringOutputSchema, input.controlRoot, { operationId: input.operationId, contract: "spec-authoring", phase: "spec-authoring" });
    try {
      validateSpecAuthoringResult(input.changeName, evidence.payload);
    } catch (error) {
      if (shouldRetrySpecManagerChangeMismatch(error, changeMismatchRetries)) {
        changeMismatchRetries += 1;
        mismatchRetryPending = true;
        continue;
      }
      throw error;
    }
    if (evidence.payload.status === "READY") {
      await persistOpenSpecAuthoringContentV1(input.root, input.changeName, { ...evidence.payload.artifacts, proposal: evidence.payload.artifacts.proposal!, tasks: evidence.payload.artifacts.tasks! });
      return evidence;
    }

    const draft = evidence.payload.decisionRequests[0]!;
    const priorSelections = [...(input.priorSelections ?? []), ...(selectedChoice ? [selectedChoice] : [])];
    if (priorSelections.length > 16) throw new Error("DECISION_CONTINUATION_CHAIN_TOO_LONG: at most 16 sequential product choices can be recorded in one operation.");
    const checkpoint: ProductChoiceCheckpointV1 = {
      version: 1, taskId: input.taskId, title: input.title, changeName: input.changeName,
      triageReasons: input.triageReasons, priorSelections, decisionDraft: draft, blockedResult: evidence,
      ...(input.explorerEvidence ? { explorerEvidence: input.explorerEvidence } : {}),
      ...(input.plannerEvidence ? { plannerEvidence: input.plannerEvidence } : {}), inputs: input.inputs
    };
    await suspendOperationForProductChoice(input.controlRoot, input.operationId, {
      issue: draft.issue,
      authoritativeEvidence: [{ artifact: evidence.artifact, sha256: evidence.sha256, description: "Provenance-accepted structured Spec Manager result that identified this unresolved product choice." }],
      whatTried: draft.whatTried, whyUnresolvable: draft.whyUnresolvable,
      choices: draft.choices, workThatCanContinue: draft.workThatCanContinue
    }, checkpoint);
    selectedChoice = await awaitProductChoice(input.controlRoot, input.operationId, checkpoint);
    await resumeOperationProductChoice(input.controlRoot, input.operationId);
  }
}

async function awaitProductChoice(controlRoot: string, operationId: string, checkpoint: ProductChoiceCheckpointV1): Promise<ProductChoiceSelectionV1> {
  const ledger = new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(controlRoot), ".harness", "security", "human-decisions.json"));
  for (;;) {
    await awaitChangeControlCheckpoint(controlRoot, operationId);
    const current = await loadOperation(controlRoot, operationId);
    assertCurrentControllerOwner(current, "product-choice continuation wait");
    if (current.status !== "RUNNING") throw new Error(`DECISION_CONTINUATION_STOPPED: operation is ${current.status}.`);
    const continuation = current.continuation;
    const request = current.decisionRequest;
    if (!continuation || continuation.state !== "WAITING" || !request || current.phase !== "HUMAN_REQUIRED" || continuation.requestId !== request.requestId) {
      throw new Error("DECISION_CONTINUATION_STATE_INVALID: operation left the waiting product-choice state.");
    }
    const binding = productChoiceBinding(current);
    const matches = request.operationId === binding.operationId
      && request.candidate.identityDigest === binding.candidate.identityDigest
      && candidateRevisionsEqual(request.candidate, binding.candidate)
      && request.operationExecutionRevision === binding.operationExecutionRevision
      && sameProductChoiceBinding(continuation, binding)
      && sameProductChoiceBinding(request, binding);
    if (!matches || Date.parse(request.expiresAt) <= Date.now()) {
      const saved = parseProductChoiceCheckpoint(await loadWaitingOperationProductChoiceCheckpointForReissue(controlRoot, operationId));
      if (saved.taskId !== checkpoint.taskId || saved.changeName !== checkpoint.changeName) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: saved resume target changed while waiting.");
      await reissueOperationProductChoice(controlRoot, operationId, saved);
      continue;
    }
    const decision = await ledger.productChoiceForRequest(request.requestId, binding, request.choices.map((choice) => choice.choiceId));
    if (!decision) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    if (decision.purpose.kind !== "PRODUCT_CHOICE") throw new Error("DECISION_PURPOSE_MISMATCH: product-choice request resolved to another HumanDecision purpose.");
    const selectedChoiceId = decision.purpose.choiceId;
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    const consumed = await markOperationProductChoiceConsumed(controlRoot, operationId, { requestId: request.requestId, decisionId: decision.decisionId, choiceId: selectedChoiceId });
    const choice = request.choices.find((item) => item.choiceId === selectedChoiceId);
    if (!choice || !consumed.continuation) throw new Error("DECISION_CHOICE_INVALID: consumed choice is absent from the current request.");
    return { requestId: request.requestId, decisionId: decision.decisionId, choiceId: choice.choiceId, choice, reason: decision.reason };
  }
}

async function resumeProductChoiceContinuation(
  root: string,
  controlRoot: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  payload: ChangeOperationPayload,
  semanticRuntime: Awaited<ReturnType<typeof createSemanticAssessmentRuntimeV1>>
): Promise<ChangeOperationResult> {
  if (operation.intent?.route !== "FORMAL_SDD" || !operation.intent.assurance) throw new Error("DECISION_CONTINUATION_TARGET_INVALID: saved SPEC_AUTHORING continuation has no current FORMAL_SDD route and assurance.");
  const operationAssurance = operation.intent.assurance;
  const taskId = payload.taskId?.trim() || operation.id;
  const title = payload.title?.trim() || payload.request.slice(0, 120) || `Change ${taskId}`;
  const beforeResume = await loadOperation(controlRoot, operation.id);
  if (beforeResume.continuation && beforeResume.continuation.state !== "WAITING") {
    const currentBinding = productChoiceBinding(beforeResume);
    if (!sameProductChoiceBinding(beforeResume.continuation, currentBinding)) {
      const checkpoint = parseProductChoiceCheckpoint(await loadStaleConsumedProductChoiceCheckpointForReconfirmation(controlRoot, operation.id));
      if (checkpoint.taskId !== taskId || checkpoint.title !== title) throw new Error("DECISION_CONTINUATION_STALE: persisted task identity no longer matches the current operation payload.");
      const draft = checkpoint.decisionDraft;
      await reconfirmStaleConsumedProductChoice(controlRoot, operation.id, {
        issue: `The previous product choice became stale after controller or policy identity changed. Confirm a current choice before resuming: ${draft.issue}`,
        authoritativeEvidence: [{ artifact: checkpoint.blockedResult.artifact, sha256: checkpoint.blockedResult.sha256, description: "Provenance-accepted Spec Manager result for the suspended product choice." }],
        whatTried: draft.whatTried,
        whyUnresolvable: draft.whyUnresolvable,
        choices: draft.choices,
        workThatCanContinue: draft.workThatCanContinue
      }, checkpoint);
      operation = await loadOperation(controlRoot, operation.id);
    }
  }
  let checkpointValue: unknown;
  try {
    checkpointValue = await loadOperationProductChoiceCheckpoint(controlRoot, operation.id);
  } catch (error) {
    const current = await loadOperation(controlRoot, operation.id);
    if (current.continuation?.state !== "WAITING") throw error;
    checkpointValue = await loadWaitingOperationProductChoiceCheckpointForReissue(controlRoot, operation.id);
    const saved = parseProductChoiceCheckpoint(checkpointValue);
    const request = current.decisionRequest;
    const binding = request && productChoiceBinding(current);
    const requestIsCurrent = Boolean(request && binding
      && sameProductChoiceBinding(request, binding)
      && current.continuation && sameProductChoiceBinding(current.continuation, binding));
    if (requestIsCurrent && request && Date.parse(request.expiresAt) > Date.now()) throw error;
    await reissueOperationProductChoice(controlRoot, operation.id, saved);
    checkpointValue = await loadOperationProductChoiceCheckpoint(controlRoot, operation.id);
  }
  const checkpoint = parseProductChoiceCheckpoint(checkpointValue);
  if (checkpoint.taskId !== taskId || checkpoint.title !== title) throw new Error("DECISION_CONTINUATION_STALE: persisted task identity no longer matches the current operation payload.");
  const bootstrapContract = operationBootstrapContract(taskId, title, payload, "FORMAL_SDD", operationAssurance, [createRouteEvidence("FORMAL_SDD", "saved-product-choice-continuation", "Resuming the persisted Spec Manager stage after a scoped human product choice.")]);
  const preflight = await preflightOpenSpec(root, config);
  const preparedSpec = await prepareOpenSpecChange(root, config, taskId);
  if (preparedSpec.changeName !== checkpoint.changeName || preparedSpec.managerAgent !== preflight.managerAgent) throw new Error("DECISION_CONTINUATION_STALE: OpenSpec resume target or Spec Manager changed while suspended.");
  const topology = await loadResolvedAgentTopology(root, config, normalizeAgentProfile(payload.profile) ?? config.agents?.activeProfile);
  const manager = topology.agents[preflight.managerAgent];
  if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${preflight.managerAgent}`);
  const selection = executionSelectionForAgent(topology, preflight.managerAgent);
  const latest = await loadOperation(controlRoot, operation.id);
  const continuation = latest.continuation;
  if (!continuation) throw new Error("DECISION_CONTINUATION_MISSING: saved product-choice continuation disappeared before resume.");
  const ledger = new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(controlRoot), ".harness", "security", "human-decisions.json"));
  let selected: ProductChoiceSelectionV1;
  if (continuation.state === "WAITING") {
    selected = await awaitProductChoice(controlRoot, operation.id, checkpoint);
    await resumeOperationProductChoice(controlRoot, operation.id);
  }
  else {
    selected = await loadConsumedProductChoice(latest, continuation, checkpoint, ledger);
    await resumeOperationProductChoice(controlRoot, operation.id);
  }

  let contract: TaskContract;
  if (continuation.appliedRequirementDigest) {
    await compileOpenSpecChange(root, config, taskId, title, preparedSpec.changeName, undefined, payload.request);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`DECISION_CONTINUATION_REVALIDATION_FAILED: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    const digest = sha256Canonical({ requirements: contract.requirements ?? [], specChange: preparedSpec.changeName });
    if (digest !== continuation.appliedRequirementDigest) throw new Error("DECISION_CONTINUATION_REQUIREMENTS_STALE: compiled requirement identity changed after the saved continuation was applied.");
    contract.routing = { ...contract.routing, route: "FORMAL_SDD", assurance: operationAssurance, routeEvidence: bootstrapContract.routing?.routeEvidence };
    await sealTask(root, config, contract);
  } else {
    const specEvidence = await runSpecManagerUntilReady({
      root, controlRoot, config, operationId: operation.id, payload, bootstrapContract, selection,
      changeName: preparedSpec.changeName, taskId, title, triageReasons: checkpoint.triageReasons,
      explorerEvidence: checkpoint.explorerEvidence, plannerEvidence: checkpoint.plannerEvidence,
      inputs: checkpoint.inputs, initialChoice: selected, priorSelections: checkpoint.priorSelections
    });
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "COMPLETED", { artifact: specEvidence.artifact });
    await compileOpenSpecChange(root, config, taskId, title, preparedSpec.changeName, undefined, payload.request);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`SDD validation failed after product-choice continuation: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    contract.routing = { ...contract.routing, route: "FORMAL_SDD", assurance: operationAssurance, routeEvidence: bootstrapContract.routing?.routeEvidence };
    await sealTask(root, config, contract);
  }

  const current = await loadOperation(controlRoot, operation.id);
  if (!current.continuation?.selectedDecisionId || !current.continuation.selectedChoiceId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: resumed product choice is no longer bound to the operation.");
  const requirementDigest = sha256Canonical({ requirements: contract.requirements ?? [], specChange: preparedSpec.changeName });
  if (current.continuation.appliedRequirementDigest) {
    if (current.continuation.appliedRequirementDigest !== requirementDigest || !current.resolvedOperationPolicy) throw new Error("DECISION_POLICY_STALE: recovered product-choice semantics do not have the matching current bootstrap policy.");
    const currentBinding = productChoiceBinding(current);
    if (!sameProductChoiceBinding(current.continuation, currentBinding)) throw new Error("DECISION_CONTINUATION_BINDING_STALE: recovered policy does not match its persisted continuation.");
    assertCurrentConsumedProductChoiceBinding(current, current.continuation, current.continuation.selectedDecisionBinding!);
  } else {
    const priorPolicy = current.resolvedOperationPolicy;
    if (!priorPolicy) throw new Error("DECISION_POLICY_STALE: product-choice revalidation has no current policy to rebind.");
    const rebound = await bindProductChoiceExecutionSemantics(controlRoot, operation.id, { requirementDigest, decisionId: current.continuation.selectedDecisionId, choiceId: current.continuation.selectedChoiceId, priorDecisionIds: checkpoint.priorSelections.map((item) => item.decisionId) });
    const { version: _version, digest: _digest, ...policyBody } = priorPolicy;
    const policy = compileResolvedOperationPolicy({ ...policyBody, operationExecutionRevision: rebound.operationExecutionRevision!, controllerEpoch: currentControllerEpoch(rebound) });
    await bindResolvedOperationPolicy(controlRoot, operation.id, policy);
  }
  await resumeOperationProductChoice(controlRoot, operation.id);
  await setOperationStage(controlRoot, operation.id, "spec-compilation", "COMPLETED", { artifact: relativeContract(config, taskId) });
  await setOperationStage(controlRoot, operation.id, "implementation", "RUNNING");
  const run = await runTask(root, config, contract, { profile: payload.profile, planning: checkpoint.plannerEvidence?.payload, semanticRuntime });
  await setOperationStage(controlRoot, operation.id, "implementation", run.status === "PASS" ? "COMPLETED" : "FAILED");
  if ((await loadOperation(controlRoot, operation.id)).continuation?.state === "RESUMING") await completeOperationProductChoice(controlRoot, operation.id);
  await recordEvent(controlRoot, config, "harness.change.finish", { operationId: operation.id, taskId, route: "FORMAL_SDD", status: run.status, triageReasons: checkpoint.triageReasons, specChange: preparedSpec.changeName, resumedFromProductChoice: true });
  return { taskId, route: "FORMAL_SDD", triageReasons: checkpoint.triageReasons, run, specChange: preparedSpec.changeName };
}

async function loadConsumedProductChoice(operation: OperationRecordV2, continuation: NonNullable<OperationRecordV2["continuation"]>, checkpoint: ProductChoiceCheckpointV1, ledger: HumanDecisionLedgerV2): Promise<ProductChoiceSelectionV1> {
  if (!continuation.selectedDecisionId || !continuation.selectedChoiceId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: consumed product-choice identity is incomplete.");
  const decision = await ledger.find(continuation.selectedDecisionId);
  if (!decision || decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE" || decision.purpose.requestId !== continuation.requestId
    || decision.purpose.choiceId !== continuation.selectedChoiceId || decision.operationId !== operation.id || !operation.candidateRevision
    || decision.candidate.identityDigest !== operation.candidateRevision.identityDigest) throw new Error("DECISION_CONTINUATION_DECISION_INVALID: persisted consumed choice does not match the current operation and saved request.");
  const binding: HumanDecisionBindingV2 = { operationId: decision.operationId, candidate: decision.candidate, operationExecutionRevision: decision.operationExecutionRevision, policyDigest: decision.policyDigest, controllerEpoch: decision.controllerEpoch };
  assertCurrentConsumedProductChoiceBinding(operation, continuation, binding);
  const receiptBinding = continuation.selectedDecisionBinding!;
  if (!await ledger.consumedExact(receiptBinding, decision.purpose, decision.decisionId, decision.actorId)) throw new Error("DECISION_CONTINUATION_DECISION_UNCONSUMED: saved operation continuation has no exact one-time HumanDecision consumption receipt.");
  const choice = checkpoint.decisionDraft.choices.find((item) => item.choiceId === continuation.selectedChoiceId);
  if (!choice) throw new Error("DECISION_CONTINUATION_CHOICE_INVALID: consumed selection is absent from its saved bounded options.");
  return { requestId: continuation.requestId, decisionId: decision.decisionId, choiceId: choice.choiceId, choice, reason: decision.reason };
}

function productChoiceBinding(operation: OperationRecordV2): HumanDecisionBindingV2 {
  const candidate = operation.candidateRevision;
  const policy = operation.resolvedOperationPolicy;
  if (!candidate || !policy || !Number.isSafeInteger(operation.operationExecutionRevision)) throw new Error("DECISION_AUTHORITY_REQUIRED: current candidate, operation revision, and policy are required.");
  assertResolvedOperationPolicyV2(policy);
  if (policy.operationId !== operation.id || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.operationExecutionRevision !== operation.operationExecutionRevision || policy.controllerEpoch !== currentControllerEpoch(operation)) throw new Error("DECISION_BINDING_STALE: operation policy does not match the current candidate, revision, and epoch.");
  return { operationId: operation.id, candidate, operationExecutionRevision: operation.operationExecutionRevision!, policyDigest: policy.digest, controllerEpoch: currentControllerEpoch(operation) };
}

function sameProductChoiceBinding(left: HumanDecisionBindingV2, right: HumanDecisionBindingV2): boolean {
  return left.operationId === right.operationId
    && candidateRevisionsEqual(left.candidate, right.candidate)
    && left.operationExecutionRevision === right.operationExecutionRevision
    && left.policyDigest === right.policyDigest
    && left.controllerEpoch === right.controllerEpoch;
}

function parseProductChoiceCheckpoint(value: unknown): ProductChoiceCheckpointV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint must be an object.");
  const checkpoint = value as Record<string, unknown>;
  const allowed = ["version", "taskId", "title", "changeName", "triageReasons", "priorSelections", "decisionDraft", "blockedResult", "explorerEvidence", "plannerEvidence", "inputs"];
  const extra = Object.keys(checkpoint).filter((key) => !allowed.includes(key));
  if (extra.length || checkpoint.version !== 1 || typeof checkpoint.taskId !== "string" || typeof checkpoint.title !== "string" || typeof checkpoint.changeName !== "string"
    || !Array.isArray(checkpoint.triageReasons) || !checkpoint.triageReasons.every((item) => typeof item === "string")
    || !Array.isArray(checkpoint.priorSelections) || checkpoint.priorSelections.length > 16 || !Array.isArray(checkpoint.inputs)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint identity or shape is malformed.");
  const draft = checkpoint.decisionDraft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: typed decision draft is missing.");
  const blockedResult = parseCheckpointEvidence(checkpoint.blockedResult, specAuthoringOutputSchema);
  if (blockedResult.payload.status !== "BLOCKED" || blockedResult.payload.decisionRequests.length !== 1 || JSON.stringify(blockedResult.payload.decisionRequests[0]) !== JSON.stringify(draft)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: saved Spec Manager handoff does not contain the exact typed BLOCKED decision.");
  const inputs = checkpoint.inputs as ChangeInputReference[];
  for (const item of inputs) if (!item || typeof item !== "object" || typeof item.artifact !== "string" || typeof item.sha256 !== "string") throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: saved input reference is malformed.");
  const explorerEvidence = checkpoint.explorerEvidence === undefined ? undefined : parseCheckpointEvidence(checkpoint.explorerEvidence, explorerOutputSchema);
  const plannerEvidence = checkpoint.plannerEvidence === undefined ? undefined : parseCheckpointEvidence(checkpoint.plannerEvidence, plannerOutputSchema);
  const priorSelections = checkpoint.priorSelections.map(parseProductChoiceSelection);
  if (new Set(priorSelections.map((item) => item.decisionId)).size !== priorSelections.length) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product decision identities must be unique.");
  return { version: 1, taskId: checkpoint.taskId, title: checkpoint.title, changeName: checkpoint.changeName, triageReasons: checkpoint.triageReasons as string[], priorSelections, decisionDraft: draft as ProductChoiceDraftV1, blockedResult, ...(explorerEvidence ? { explorerEvidence } : {}), ...(plannerEvidence ? { plannerEvidence } : {}), inputs };
}

function parseProductChoiceSelection(value: unknown): ProductChoiceSelectionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product choice is malformed.");
  const selection = value as Record<string, unknown>;
  const allowed = ["requestId", "decisionId", "choiceId", "choice", "reason"];
  if (Object.keys(selection).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in selection))) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product choice has unsupported or missing fields.");
  if (typeof selection.requestId !== "string" || !selection.requestId.startsWith("request:") || typeof selection.decisionId !== "string" || !/^decision:[0-9a-f-]{36}$/i.test(selection.decisionId)
    || typeof selection.choiceId !== "string" || typeof selection.reason !== "string") throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product choice identity is malformed.");
  const choiceValue = selection.choice;
  if (!choiceValue || typeof choiceValue !== "object" || Array.isArray(choiceValue)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product choice option is missing.");
  const choice = choiceValue as Record<string, unknown>;
  if (Object.keys(choice).some((key) => !["choiceId", "label", "description", "consequences"].includes(key)) || choice.choiceId !== selection.choiceId
    || typeof choice.label !== "string" || typeof choice.description !== "string" || !Array.isArray(choice.consequences) || !choice.consequences.every((item) => typeof item === "string")) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: prior product choice option is malformed.");
  return { requestId: selection.requestId, decisionId: selection.decisionId, choiceId: selection.choiceId, choice: choice as unknown as DecisionChoiceV1, reason: selection.reason };
}

function parseCheckpointEvidence<T>(value: unknown, schema: { parse(value: unknown): T }): DurableAgentEvidence<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: saved evidence reference is malformed.");
  const evidence = value as Record<string, unknown>;
  if (typeof evidence.artifact !== "string" || !evidence.artifact.startsWith(".harness/") || typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: saved evidence artifact or digest is invalid.");
  return { artifact: evidence.artifact, sha256: evidence.sha256, payload: schema.parse(evidence.payload) };
}

export function validateSpecAuthoringResult(expectedChange: string, result: SpecAuthoringOutput): void {
  if (result.change !== expectedChange) throw new Error(`SPEC_MANAGER_CHANGE_MISMATCH: expected '${expectedChange}', received '${result.change}'.`);
  if (result.status === "BLOCKED") {
    if (result.validationReady || result.decisionRequests.length !== 1) {
      throw new Error("SPEC_MANAGER_BLOCKED_UNSCOPED: a blocked Spec Manager result must contain exactly one typed, scoped product decision and cannot claim validation readiness.");
    }
    return;
  }
  if (!result.validationReady || result.decisionRequests.length !== 0) {
    throw new Error("SPEC_MANAGER_READY_INVALID: READY spec authoring must be validation-ready and contain no pending product decisions.");
  }
  if (!result.artifacts.proposal?.trim() || !result.artifacts.tasks?.trim()) {
    throw new Error("SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal.md and tasks.md artifacts.");
  }
  // DETERMINISTIC pre-persistence gate: the typed READY result must already be a canonical
  // OpenSpec change delta. A non-canonical result is rejected here, before any controller-owned
  // write, with a typed error naming the exact artifact (AEH-V2-0115).
  validateOpenSpecAuthoringContentCanonicalityV1(expectedChange, { specs: result.artifacts.specs });
}

function operationBootstrapContract(taskId: string, title: string, payload: ChangeOperationPayload, route: ImplementationRoute = "DELEGATED", assurance: AssuranceLevel = "STANDARD", routeEvidence: RouteEvidence[] = [{ route: "DELEGATED", source: "change-bootstrap", statement: "Change operations use the selected canonical implementation route." }]): TaskContract {
  return {
    version: 1,
    task: { id: taskId, title },
    scope: { allowed: payload.files?.length ? payload.files : ["**"], forbidden: [], frozen: [] },
    routing: { intent: "change", domains: payload.domains ?? [], risk: payload.risk ?? "low", profile: payload.profile, route, assurance, routeEvidence },
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false }
  };
}

export function buildSpecManagerPrompt(
  payload: ChangeOperationPayload,
  changeName: string,
  explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined,
  plannerEvidence: DurableAgentEvidence<PlannerOutput> | undefined,
  inputs: ChangeInputReference[],
  selectedChoice?: ProductChoiceSelectionV1
): string {
  return [
    `Author OpenSpec change '${changeName}' for the existing durable CHANGE operation.`,
    `Set output field "change" to exactly '${changeName}' (the OpenSpec change ID); it is an identifier, not a title.`,
    `User request: ${payload.request}`,
    `Explicit acceptance: ${JSON.stringify(payload.acceptance ?? [])}`,
    changeInputsPrompt(inputs),
    explorerEvidence ? `Explorer durable result: ${explorerEvidence.artifact}\n${compactJson(explorerEvidence.payload, 10_000)}` : "Explorer result: not expected by topology.",
    plannerEvidence ? `Planner durable result: ${plannerEvidence.artifact}\n${compactJson(plannerEvidence.payload, 12_000)}` : "Planner result: not expected by topology.",
    "Return complete authored file contents in artifacts.proposal, artifacts.tasks, optional artifacts.design, and artifacts.specs. artifacts.specs is one entry per capability: { capability: \"<kebab-case-capability>\", content: \"<complete OpenSpec change spec delta markdown>\" }. Every content value MUST be a canonical OpenSpec change spec delta: it starts with (or contains) a '## ADDED Requirements', '## MODIFIED Requirements', '## REMOVED Requirements' or '## RENAMED Requirements' section; every requirement is written as '### Requirement: <name>' inside a delta section; every requirement has at least one '#### Scenario: <name>' block; and every requirement statement MUST contain the normative keyword SHALL or MUST (OpenSpec strict validation rejects non-normative requirements). Flat requirement documents without delta headers, requirements without scenarios, requirements without SHALL/MUST and non-kebab-case capability names are rejected before persistence. Do not write files or request repository-write access; the deterministic controller persists these validated contents into the prepared OpenSpec change directory (openspec/changes/<change>/specs/<capability>/spec.md) before OpenSpec validation and compilation.",
    selectedChoice ? [
      "Resume the saved SPEC_AUTHORING stage using this paired human product choice as requirement input only:",
      JSON.stringify({ requestId: selectedChoice.requestId, issue: selectedChoice.choice.description, choiceId: selectedChoice.choiceId, label: selectedChoice.choice.label, consequences: selectedChoice.choice.consequences }, null, 2),
      "Update the OpenSpec requirement/design/tasks to reflect this choice when needed. This choice does not grant tools, capability, mutation authority, or action authorization. If another genuine product decision is still required, return one new typed decisionRequests item and status=BLOCKED."
    ].join("\n") : "Return the spec-authoring output contract. For one true product decision that cannot be derived, mark status=BLOCKED and return exactly one typed decisionRequests item with issue, evidence-independent whatTried, whyUnresolvable, bounded choices and consequences, and workThatCanContinue. Otherwise return status=READY, decisionRequests=[], identify authored artifacts and set validationReady=true.",
    "Do not invoke `aeh spec`, `aeh run`, `aeh operation ...` or another Harness workflow. The deterministic controller will validate, compile, seal and execute after your authoring turn."
  ].join("\n\n");
}

function relativeContract(config: HarnessProjectConfig, taskId: string): string {
  return `${config.sdd?.contractsDir ?? ".harness/contracts"}/${taskId}.yaml`;
}
function compactJson(value: unknown, max: number): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= max ? serialized : `${serialized.slice(0, max)}\n[truncated ${serialized.length - max} chars; durable artifact remains authoritative]`;
}
