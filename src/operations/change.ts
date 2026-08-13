import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { plannerOutputSchema } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { createControlPlaneSnapshot } from "../core/controlPlane.js";
import { loadTaskContract } from "../core/config.js";
import { createQuickContract } from "../core/quick.js";
import { runTask, type TaskRunResult } from "../core/run.js";
import { validateSddChange } from "../core/sdd.js";
import { sealTask } from "../core/seal.js";
import { triageChange } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { prepareOpenSpecChange, compileOpenSpecChange } from "../spec/openspec.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { recordEvent } from "../telemetry/events.js";
import { ensureOperationSupervisor, maybeRotateOperationSupervisor } from "./supervisor.js";
import {
  loadOperation,
  patchOperation,
  setOperationStage,
  type ChangeOperationPayload,
  type OperationRecordV2
} from "./state.js";

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
  const topology = await loadResolvedAgentTopology(root, config, payload.profile ?? config.agents?.activeProfile);
  const bootstrapContract = operationBootstrapContract(taskId, title, payload);
  await createControlPlaneSnapshot(root, config, taskId);
  await setOperationStage(controlRoot, operation.id, "discovery", "RUNNING");
  await ensureOperationSupervisor(root, config, bootstrapContract, topology, { required: true, forceMaterialize: true });

  const explorerEvidence = await runDiscovery(root, config, bootstrapContract, topology, payload);
  await setOperationStage(controlRoot, operation.id, "discovery", "COMPLETED");
  await maybeRotateOperationSupervisor(root, config, bootstrapContract, topology);

  await setOperationStage(controlRoot, operation.id, "planning", "RUNNING");
  const plannerEvidence = await runPlanning(root, config, bootstrapContract, topology, payload, explorerEvidence);
  await setOperationStage(controlRoot, operation.id, "planning", "COMPLETED");

  await setOperationStage(controlRoot, operation.id, "triage", "RUNNING");
  const triage = triageChange(config, { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk });
  const mode: "quick" | "spec" = triage.quickEligible && (payload.acceptance?.length ?? 0) > 0 ? "quick" : "spec";
  const triageReasons = mode === "quick" ? triage.reasons : [...triage.reasons, ...(payload.acceptance?.length ? [] : ["SPEC selected because no explicit observable QUICK acceptance was supplied"] )];
  const current = await loadOperation(controlRoot, operation.id);
  await patchOperation(controlRoot, operation.id, { intent: { ...current.intent, request: payload.request, classification: "CHANGE", mode, risk: payload.risk ?? "low", priority: payload.priority ?? current.intent?.priority } });
  await setOperationStage(controlRoot, operation.id, "triage", "COMPLETED", { message: `${mode.toUpperCase()}: ${triageReasons.join("; ")}` });

  let contract: TaskContract;
  let specChange: string | undefined;
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
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "RUNNING");
    const prepared = await prepareOpenSpecChange(root, config, taskId, title);
    specChange = prepared.changeName;
    const manager = topology.agents[prepared.managerAgent];
    if (!manager || manager.disabled) throw new Error(`SPEC_MANAGER_UNAVAILABLE: ${prepared.managerAgent}`);
    const selection = executionSelectionForAgent(topology, prepared.managerAgent);
    const specSession = await executeAgentPrompt(
      root,
      config,
      bootstrapContract,
      selection,
      buildSpecManagerPrompt(payload, prepared.changeName, explorerEvidence, plannerEvidence),
      { outputContract: selection.outputContract ?? "planner", phase: "spec-authoring", operationKind: "change" }
    );
    if (specSession.exitCode !== 0) throw new Error(`SPEC_MANAGER_FAILED: ${specSession.stderr || specSession.stdout}`);
    await maybeRotateOperationSupervisor(root, config, bootstrapContract, topology);
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "RUNNING");
    await compileOpenSpecChange(root, config, taskId, title, prepared.changeName);
    const validation = await validateSddChange(root, taskId, config);
    if (!validation.ok) throw new Error(`SDD validation failed after OpenSpec compilation: ${[...validation.missing, ...validation.issues].join("; ")}`);
    contract = await loadTaskContract(root, taskId, config);
    await sealTask(root, config, contract);
    await setOperationStage(controlRoot, operation.id, "spec-authoring", "COMPLETED", { artifact: `openspec/changes/${prepared.changeName}` });
    await setOperationStage(controlRoot, operation.id, "spec-compilation", "COMPLETED", { artifact: relativeContract(config, taskId) });
  }

  await setOperationStage(controlRoot, operation.id, "implementation", "RUNNING");
  const run = await runTask(root, config, contract, { profile: payload.profile });
  await setOperationStage(controlRoot, operation.id, "implementation", run.status === "PASS" ? "COMPLETED" : "FAILED");
  await recordEvent(controlRoot, config, "harness.change.finish", { operationId: operation.id, taskId, mode, status: run.status, triageReasons, specChange });
  return { taskId, mode, triageReasons, run, specChange };
}

async function runDiscovery(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: Awaited<ReturnType<typeof loadResolvedAgentTopology>>,
  payload: ChangeOperationPayload
): Promise<string> {
  const explorer = topology.agents.explorer;
  if (!explorer || explorer.disabled) return "Explorer unavailable; deterministic triage will use explicit user evidence only.";
  const session = await executeAgentPrompt(root, config, contract, executionSelectionForAgent(topology, "explorer"), [
    "Perform bounded repository discovery for this CHANGE operation.",
    `Request: ${payload.request}`,
    `Explicit files: ${(payload.files ?? []).join(", ") || "none"}`,
    `Domains: ${(payload.domains ?? []).join(", ") || "unspecified"}`,
    "Return only relevant files/symbols/tests/module boundaries and concrete evidence. Do not implement, author specs or start another AEH workflow."
  ].join("\n"), { phase: "discovery", operationKind: "change" });
  if (session.exitCode !== 0) throw new Error(`EXPLORER_FAILED: ${session.stderr || session.stdout}`);
  return compact(session.stdout || session.stderr, 12_000);
}

async function runPlanning(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: Awaited<ReturnType<typeof loadResolvedAgentTopology>>,
  payload: ChangeOperationPayload,
  explorerEvidence: string
): Promise<string> {
  const planner = topology.agents.planner;
  if (!planner || planner.disabled) return "Planner unavailable; deterministic triage will use explicit user evidence only.";
  const selection = executionSelectionForAgent(topology, "planner");
  const session = await executeAgentPrompt(root, config, contract, selection, [
    "Produce planning/triage evidence only for this CHANGE operation. Do not implement or author the specification.",
    `Request: ${payload.request}`,
    `Explorer evidence:\n${explorerEvidence}`,
    "Identify affected areas, dependencies, likely implementer boundaries, reviewers and validation gates. Keep normative requirements unchanged."
  ].join("\n\n"), { outputContract: "planner", phase: "planning", operationKind: "change" });
  if (session.exitCode !== 0) throw new Error(`PLANNER_FAILED: ${session.stderr || session.stdout}`);
  try {
    const parsed = plannerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    return JSON.stringify(parsed);
  } catch {
    return compact(session.stdout || session.stderr, 12_000);
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

function buildSpecManagerPrompt(payload: ChangeOperationPayload, changeName: string, explorerEvidence: string, plannerEvidence: string): string {
  return [
    `Author OpenSpec change '${changeName}' for the existing durable CHANGE operation.`,
    `User request: ${payload.request}`,
    `Explicit acceptance: ${JSON.stringify(payload.acceptance ?? [])}`,
    `Explorer evidence:\n${explorerEvidence}`,
    `Planner evidence:\n${plannerEvidence}`,
    "Use `openspec status`, `openspec instructions` and the OpenSpec authoring workflow to complete proposal.md, specs, design.md when needed and tasks.md.",
    "Do not invoke `aeh spec`, `aeh run`, `aeh operation ...` or another Harness workflow. The deterministic controller will validate, compile, seal and execute after your authoring turn.",
    "Do not invent a product decision. If a true requirement decision is impossible to derive, make that unresolved state explicit in your final structured output."
  ].join("\n\n");
}

function relativeContract(config: HarnessProjectConfig, taskId: string): string {
  return `${config.sdd?.contractsDir ?? ".harness/contracts"}/${taskId}.yaml`;
}
function compact(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`; }
