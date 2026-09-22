import { loadResolvedAgentTopology } from "../agents/config.js";
import { explorerOutputSchema, plannerOutputSchema, specAuthoringOutputSchema, type ExplorerOutput, type PlannerOutput, type SpecAuthoringOutput } from "../agents/outputContracts.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import { loadTaskContract } from "../core/config.js";
import { createRoutedContract } from "../core/contract.js";
import { runTask, type TaskRunResult } from "../core/run.js";
import { validateSddChange } from "../core/sdd.js";
import { sealTask } from "../core/seal.js";
import { triageChangeWithSemanticAssessment, type TriageDecision } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { AssuranceLevel, ImplementationRoute, RouteEvidence } from "../architecture/contracts.js";
import { createRouteEvidence } from "../architecture/contracts.js";
import { createDelegatedFeatureCapsule, persistFeatureCapsule } from "../architecture/featureCapsule.js";
import { compileOpenSpecChange, preflightOpenSpec, prepareOpenSpecChange, type OpenSpecPreflightResult } from "../spec/openspec.js";
import { recordEvent } from "../telemetry/events.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { requireDurableChangeHandoff, type DurableAgentEvidence } from "./changeHandoff.js";
import { changeInputsPrompt, resolveChangeInputs, type ChangeInputReference } from "./changeInputs.js";
import {
  loadOperation,
  patchOperation,
  setOperationStage,
  type ChangeOperationPayload,
  type OperationRecordV2
} from "./state.js";
import { ensureOperationSupervisor, maybeRotateOperationSupervisor } from "./supervisor.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1 } from "../semantic/runtime.js";

export interface ChangeOperationResult {
  taskId: string;
  route: ImplementationRoute;
  triageReasons: string[];
  run: TaskRunResult;
  specChange?: string;
}

export async function runChangeOperation(
  root: string,
  controlRoot: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  payload: ChangeOperationPayload
): Promise<ChangeOperationResult> {
  const taskId = payload.taskId?.trim() || operation.id;
  const title = payload.title?.trim() || payload.request.slice(0, 120) || `Change ${taskId}`;
  const semanticRuntime = await createSemanticAssessmentRuntimeV1(root, config, { profile: normalizeAgentProfile(payload.profile) });
  const semanticBinding = await createSemanticRepositoryBindingV1(root, config, { operationId: operation.id, candidate: operation.candidateRevision });
  let triage = await triageChangeWithSemanticAssessment(config, { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk }, { service: semanticRuntime.service, binding: semanticBinding, policyRevision: semanticRuntime.policyRevision });
  let route = triage.route;
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
  if (route === "DELEGATED" || route === "FORMAL_SDD") {
    await setOperationStage(controlRoot, operation.id, "planning", "RUNNING");
    plannerEvidence = await runPlanning(root, controlRoot, config, bootstrapContract, plannerSelection, operation.id, payload, explorerEvidence, inputs);
    await setOperationStage(controlRoot, operation.id, "planning", "COMPLETED", { artifact: plannerEvidence?.artifact, message: plannerEvidence ? "Planner durable result accepted." : "Planner disabled or unavailable by topology." });
  }

  if (route !== "FORMAL_SDD" && requiresSpecEscalation(explorerEvidence, plannerEvidence)) {
    route = "FORMAL_SDD";
    triage = formalizeEscalatedTriage(triage);
    bootstrapContract = operationBootstrapContract(taskId, title, payload, route, triage.assurance, triage.routeEvidence);
    triageReasons = [...triageReasons, "SPEC escalation came from durable explorer/planner evidence."];
    await patchOperation(controlRoot, operation.id, { intent: { ...(await loadOperation(controlRoot, operation.id)).intent, route, assurance: triage.assurance } });
    await recordEvent(controlRoot, config, "harness.change.triage-escalated", { operationId: operation.id, reason: triageReasons.at(-1), explorerArtifact: explorerEvidence?.artifact, plannerArtifact: plannerEvidence?.artifact });
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "RUNNING");
    specPreflight = await preflightOpenSpec(root, config);
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "COMPLETED", { message: `OpenSpec ${specPreflight.version}; schema=${specPreflight.schema}; manager=${specPreflight.managerAgent}` });
    const manager = topology.agents[specPreflight.managerAgent];
    if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${specPreflight.managerAgent}`);
  }

  let contract: TaskContract;
  let specChange: string | undefined;
  if (route === "DELEGATED") {
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "RUNNING");
    const capsule = createDelegatedFeatureCapsule({ taskId, objective: payload.request, scope: { allowed: payload.files?.length ? payload.files : ["**"], forbidden: [] }, acceptance: payload.acceptance, assurance: triage.assurance, routeEvidence: triage.routeEvidence, candidateRevision: (await loadOperation(controlRoot, operation.id)).candidateRevision as unknown as Record<string, unknown> });
    const capsuleArtifact = await persistFeatureCapsule(root, capsule);
    const routed = await createRoutedContract(root, config, taskId, { title, request: payload.request, scope: capsule.scope?.allowed ?? ["**"], acceptance: payload.acceptance, domains: payload.domains, risk: payload.risk, profile: payload.profile, routeDecision: triage });
    contract = { ...routed.contract, scope: capsule.scope };
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "COMPLETED", { artifact: capsuleArtifact });
  } else if (route === "DIRECT") {
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "RUNNING");
    const routed = await createRoutedContract(root, config, taskId, { title, request: payload.request, scope: payload.files ?? [], acceptance: payload.acceptance, domains: payload.domains, risk: payload.risk, profile: payload.profile, routeDecision: triage });
    contract = routed.contract;
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "COMPLETED", { artifact: relativeContract(config, taskId) });
  } else {
    if (!specPreflight) throw new Error("SPEC_PREFLIGHT_STATE: formal SDD authoring reached without a completed OpenSpec preflight.");
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "RUNNING");
    const preparedSpec = await prepareOpenSpecChange(root, config, taskId, title);
    specChange = preparedSpec.changeName;
    if (preparedSpec.managerAgent !== specPreflight.managerAgent) throw new Error(`SPEC_MANAGER_PREFLIGHT_DRIFT: preflight=${specPreflight.managerAgent} prepared=${preparedSpec.managerAgent}`);
    const selection = executionSelectionForAgent(topology, preparedSpec.managerAgent);
    const specSession = await executeAgentPrompt(
      root,
      config,
      bootstrapContract,
      selection,
      buildSpecManagerPrompt(payload, preparedSpec.changeName, explorerEvidence, plannerEvidence, inputs),
      { outputContract: "spec-authoring", phase: "spec-authoring", operationKind: "change", requireExecutionAuthority: true }
    );
    const specEvidence = await requireDurableChangeHandoff(root, "SPEC_MANAGER", specSession, specAuthoringOutputSchema, controlRoot, { operationId: operation.id, contract: "spec-authoring", phase: "spec-authoring" });
    validateSpecAuthoringResult(preparedSpec.changeName, specEvidence.payload);
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "COMPLETED", { artifact: specEvidence.artifact });
    await maybeRotateOperationSupervisor(root, config, bootstrapContract, supervisorSelection);

    await setOperationStage(controlRoot, operation.id, "spec-compilation", "RUNNING");
    await compileOpenSpecChange(root, config, taskId, title, preparedSpec.changeName);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`SDD validation failed after OpenSpec compilation: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    contract.routing = { ...contract.routing, route, assurance: triage.assurance, routeEvidence: triage.routeEvidence };
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "COMPLETED", { artifact: relativeContract(config, taskId) });
  }

  await setOperationStage(controlRoot, operation.id, "implementation", "RUNNING");
  const run = await runTask(root, config, contract, { profile: payload.profile, planning: plannerEvidence?.payload, semanticRuntime });
  await setOperationStage(controlRoot, operation.id, "implementation", run.status === "PASS" ? "COMPLETED" : "FAILED");
  await recordEvent(controlRoot, config, "harness.change.finish", { operationId: operation.id, taskId, route, status: run.status, triageReasons, specChange, inputArtifacts: inputs.map((item) => item.artifact) });
  return { taskId, route, triageReasons, run, specChange };
}

export function requiresSpecEscalation(explorerEvidence?: DurableAgentEvidence<ExplorerOutput>, plannerEvidence?: DurableAgentEvidence<PlannerOutput>): boolean {
  const explorerEscalates = explorerEvidence?.payload.findings.some((finding) => (finding.status === "BLOCKED" || finding.status === "PARTIAL") && finding.evidence.length > 0) ?? false;
  const plannerEscalates = plannerEvidence?.payload.formalizationNeed === "REQUIRED";
  return explorerEscalates || plannerEscalates;
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
  const session = await executeAgentPrompt(root, config, contract, selection, [
    "Perform bounded repository discovery for this CHANGE operation.",
    `Operation: ${operationId}`,
    `Request: ${payload.request}`,
    `Explicit files: ${(payload.files ?? []).join(", ") || "none"}`,
    `Domains: ${(payload.domains ?? []).join(", ") || "unspecified"}`,
    changeInputsPrompt(inputs),
    "Return the explorer output contract with only relevant files/symbols/tests/module boundaries, verified finding status and concrete evidence. Do not implement, author specs or start another AEH workflow."
  ].join("\n\n"), { outputContract: "explorer", phase: "discovery", operationKind: "change", requireExecutionAuthority: true });
  return requireDurableChangeHandoff(root, "EXPLORER", session, explorerOutputSchema, controlRoot, { operationId: operationId, contract: "explorer", phase: "discovery" });
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
  const explorerContext = explorerEvidence
    ? [`Explorer durable result artifact: ${explorerEvidence.artifact}`, `Explorer evidence projection:\n${compactJson(explorerEvidence.payload, 12_000)}`].join("\n")
    : "Explorer is disabled/unavailable by topology; no explorer result was expected.";
  const session = await executeAgentPrompt(root, config, contract, selection, [
    "Produce planning/triage evidence only for this CHANGE operation. Do not implement or author the specification.",
    `Operation: ${operationId}`,
    `Request: ${payload.request}`,
    changeInputsPrompt(inputs),
    explorerContext,
    "Identify affected areas, dependencies, bounded implementer ownership, reviewers and deterministic validation gates. Keep normative requirements unchanged."
  ].join("\n\n"), { outputContract: "planner", phase: "planning", operationKind: "change", requireExecutionAuthority: true });
  return requireDurableChangeHandoff(root, "PLANNER", session, plannerOutputSchema, controlRoot, { operationId, contract: "planner", phase: "planning" });
}

function validateSpecAuthoringResult(expectedChange: string, result: SpecAuthoringOutput): void {
  if (result.change !== expectedChange) throw new Error(`SPEC_MANAGER_CHANGE_MISMATCH: expected '${expectedChange}', received '${result.change}'.`);
  if (result.status === "BLOCKED" || !result.validationReady) {
    throw new Error(`SPEC_MANAGER_BLOCKED: ${result.unresolvedDecisions.join("; ") || "spec authoring did not reach validation-ready state"}`);
  }
  if (!result.artifacts.proposal?.trim() || !result.artifacts.tasks?.trim()) {
    throw new Error("SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal.md and tasks.md artifacts.");
  }
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

function buildSpecManagerPrompt(
  payload: ChangeOperationPayload,
  changeName: string,
  explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined,
  plannerEvidence: DurableAgentEvidence<PlannerOutput> | undefined,
  inputs: ChangeInputReference[]
): string {
  return [
    `Author OpenSpec change '${changeName}' for the existing durable CHANGE operation.`,
    `User request: ${payload.request}`,
    `Explicit acceptance: ${JSON.stringify(payload.acceptance ?? [])}`,
    changeInputsPrompt(inputs),
    explorerEvidence ? `Explorer durable result: ${explorerEvidence.artifact}\n${compactJson(explorerEvidence.payload, 10_000)}` : "Explorer result: not expected by topology.",
    plannerEvidence ? `Planner durable result: ${plannerEvidence.artifact}\n${compactJson(plannerEvidence.payload, 12_000)}` : "Planner result: not expected by topology.",
    "Use `openspec status`, `openspec instructions` and the OpenSpec authoring workflow to complete proposal.md, specs, design.md when needed and tasks.md.",
    "Return the spec-authoring output contract. Mark status=BLOCKED and enumerate unresolvedDecisions if a true product decision cannot be derived; otherwise identify the authored artifacts and set validationReady=true.",
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
