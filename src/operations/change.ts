import { loadResolvedAgentTopology } from "../agents/config.js";
import { explorerOutputSchema, plannerOutputSchema, specAuthoringOutputSchema, type ExplorerOutput, type PlannerOutput, type SpecAuthoringOutput } from "../agents/outputContracts.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import { loadTaskContract } from "../core/config.js";
import { createQuickContract } from "../core/quick.js";
import { runTask, type TaskRunResult } from "../core/run.js";
import { validateSddChange } from "../core/sdd.js";
import { sealTask } from "../core/seal.js";
import { triageChange } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { compileOpenSpecChange, preflightOpenSpec, prepareOpenSpecChange, type OpenSpecPreparedChange } from "../spec/openspec.js";
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

export interface ChangeOperationResult {
  taskId: string;
  mode: "quick" | "spec";
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
  const bootstrapContract = operationBootstrapContract(taskId, title, payload);
  await createControlPlaneSnapshot(root, config, taskId);

  await setOperationStage(controlRoot, operation.id, "input-resolution", "RUNNING");
  const inputs = await resolveChangeInputs(controlRoot, operation.id, payload.request);
  await setOperationStage(controlRoot, operation.id, "input-resolution", "COMPLETED", {
    artifact: inputs[0]?.artifact,
    message: inputs.length ? `${inputs.length} durable input artifact(s) frozen.` : "No external durable inputs referenced."
  });

  await setOperationStage(controlRoot, operation.id, "triage", "RUNNING");
  const triage = triageChange(config, { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk });
  const mode: "quick" | "spec" = triage.quickEligible && (payload.acceptance?.length ?? 0) > 0 ? "quick" : "spec";
  const triageReasons = mode === "quick" ? triage.reasons : [...triage.reasons, ...(payload.acceptance?.length ? [] : ["SPEC selected because no explicit observable QUICK acceptance was supplied"])];
  const current = await loadOperation(controlRoot, operation.id);
  await patchOperation(controlRoot, operation.id, { intent: { ...current.intent, request: payload.request, classification: "CHANGE", mode, risk: payload.risk ?? "low", priority: payload.priority ?? current.intent?.priority } });
  await setOperationStage(controlRoot, operation.id, "triage", "COMPLETED", { message: `${mode.toUpperCase()}: ${triageReasons.join("; ")}` });

  let preparedSpec: OpenSpecPreparedChange | undefined;
  let specChange: string | undefined;
  if (mode === "spec") {
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "RUNNING");
    const preflight = await preflightOpenSpec(root, config);
    preparedSpec = await prepareOpenSpecChange(root, config, taskId, title);
    specChange = preparedSpec.changeName;
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "COMPLETED", {
      artifact: `openspec/changes/${preparedSpec.changeName}`,
      message: `OpenSpec ${preflight.version}; schema=${preflight.schema}; manager=${preflight.managerAgent}`
    });
  } else {
    await setOperationStage(controlRoot, operation.id, "environment-preflight", "SKIPPED", { message: "QUICK mode does not require OpenSpec." });
  }

  const topology = await loadResolvedAgentTopology(root, config, payload.profile ?? config.agents?.activeProfile);
  await ensureOperationSupervisor(root, config, bootstrapContract, topology, { required: true, forceMaterialize: true });

  await setOperationStage(controlRoot, operation.id, "discovery", "RUNNING");
  const explorerEvidence = await runDiscovery(root, config, bootstrapContract, topology, operation.id, payload, inputs);
  await setOperationStage(controlRoot, operation.id, "discovery", "COMPLETED", {
    artifact: explorerEvidence?.artifact,
    message: explorerEvidence ? "Explorer durable result accepted." : "Explorer disabled or unavailable by topology."
  });
  await maybeRotateOperationSupervisor(root, config, bootstrapContract, topology);

  await setOperationStage(controlRoot, operation.id, "planning", "RUNNING");
  const plannerEvidence = await runPlanning(root, config, bootstrapContract, topology, operation.id, payload, explorerEvidence, inputs);
  await setOperationStage(controlRoot, operation.id, "planning", "COMPLETED", {
    artifact: plannerEvidence?.artifact,
    message: plannerEvidence ? "Planner durable result accepted." : "Planner disabled or unavailable by topology."
  });

  let contract: TaskContract;
  if (mode === "quick") {
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "RUNNING");
    const quick = await createQuickContract(root, config, taskId, {
      title,
      request: payload.request,
      scope: payload.files ?? [],
      acceptance: payload.acceptance ?? [],
      domains: payload.domains,
      risk: payload.risk,
      profile: payload.profile
    });
    contract = quick.contract;
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "contract-authoring", "COMPLETED", { artifact: relativeContract(config, taskId) });
  } else {
    if (!preparedSpec) throw new Error("SPEC_PREFLIGHT_STATE: SPEC mode reached authoring without a prepared OpenSpec change.");
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "RUNNING");
    const manager = topology.agents[preparedSpec.managerAgent];
    if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${preparedSpec.managerAgent}`);
    const selection = executionSelectionForAgent(topology, preparedSpec.managerAgent);
    const specSession = await executeAgentPrompt(
      root,
      config,
      bootstrapContract,
      selection,
      buildSpecManagerPrompt(payload, preparedSpec.changeName, explorerEvidence, plannerEvidence, inputs),
      { outputContract: "spec-authoring", phase: "spec-authoring", operationKind: "change" }
    );
    const specEvidence = await requireDurableChangeHandoff(root, "SPEC_MANAGER", specSession, specAuthoringOutputSchema);
    validateSpecAuthoringResult(preparedSpec.changeName, specEvidence.payload);
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "COMPLETED", { artifact: specEvidence.artifact });
    await maybeRotateOperationSupervisor(root, config, bootstrapContract, topology);

    await setOperationStage(controlRoot, operation.id, "spec-compilation", "RUNNING");
    await compileOpenSpecChange(root, config, taskId, title, preparedSpec.changeName);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`SDD validation failed after OpenSpec compilation: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "COMPLETED", { artifact: relativeContract(config, taskId) });
  }

  await setOperationStage(controlRoot, operation.id, "implementation", "RUNNING");
  const run = await runTask(root, config, contract, { profile: payload.profile });
  await setOperationStage(controlRoot, operation.id, "implementation", run.status === "PASS" ? "COMPLETED" : "FAILED");
  await recordEvent(controlRoot, config, "harness.change.finish", { operationId: operation.id, taskId, mode, status: run.status, triageReasons, specChange, inputArtifacts: inputs.map((item) => item.artifact) });
  return { taskId, mode, triageReasons, run, specChange };
}

async function runDiscovery(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: Awaited<ReturnType<typeof loadResolvedAgentTopology>>,
  operationId: string,
  payload: ChangeOperationPayload,
  inputs: ChangeInputReference[]
): Promise<DurableAgentEvidence<ExplorerOutput> | undefined> {
  const explorer = topology.agents.explorer;
  if (!explorer || explorer.disabled) return undefined;
  const session = await executeAgentPrompt(root, config, contract, executionSelectionForAgent(topology, "explorer"), [
    "Perform bounded repository discovery for this CHANGE operation.",
    `Operation: ${operationId}`,
    `Request: ${payload.request}`,
    `Explicit files: ${(payload.files ?? []).join(", ") || "none"}`,
    `Domains: ${(payload.domains ?? []).join(", ") || "unspecified"}`,
    changeInputsPrompt(inputs),
    "Return the explorer output contract with only relevant files/symbols/tests/module boundaries, verified finding status and concrete evidence. Do not implement, author specs or start another AEH workflow."
  ].join("\n\n"), { outputContract: "explorer", phase: "discovery", operationKind: "change" });
  return requireDurableChangeHandoff(root, "EXPLORER", session, explorerOutputSchema);
}

async function runPlanning(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: Awaited<ReturnType<typeof loadResolvedAgentTopology>>,
  operationId: string,
  payload: ChangeOperationPayload,
  explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined,
  inputs: ChangeInputReference[]
): Promise<DurableAgentEvidence<PlannerOutput> | undefined> {
  const planner = topology.agents.planner;
  if (!planner || planner.disabled) return undefined;
  const selection = executionSelectionForAgent(topology, "planner");
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
  ].join("\n\n"), { outputContract: "planner", phase: "planning", operationKind: "change" });
  return requireDurableChangeHandoff(root, "PLANNER", session, plannerOutputSchema);
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

function operationBootstrapContract(taskId: string, title: string, payload: ChangeOperationPayload): TaskContract {
  return {
    version: 1,
    task: { id: taskId, title },
    scope: { allowed: payload.files?.length ? payload.files : ["**"], forbidden: [], frozen: [] },
    routing: { intent: "change", domains: payload.domains ?? [], risk: payload.risk ?? "low", profile: payload.profile },
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
