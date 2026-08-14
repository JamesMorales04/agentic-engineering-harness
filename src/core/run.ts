import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology, ResolvedRoute } from "../agents/types.js";
import { auditAgentTopology } from "../agents/audit.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { classifyFailure, formatRecoveryAction, resolveRecoveryStep } from "../agents/recovery.js";
import { executionSelectionForAgent, selectExecutionForTask, selectFallbackExecution } from "../agents/routing.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import { runReviewLifecycle } from "../agents/reviewLifecycle.js";
import type { SeverityCounts } from "../agents/qualityConvergence.js";
import { executePlannerWaves, type PlannerWaveResult } from "../agents/waveExecutor.js";
import type { PlannerOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, RunMetrics, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "./types.js";
import { loadTaskContract } from "./config.js";
import { validateSddChange } from "./sdd.js";
import { validateQuickTaskContract } from "./quick.js";
import { sealTask, verifyTaskSeal } from "./seal.js";
import { verifyTask } from "./verify.js";
import { createRepairPacket, writeRepairPacket } from "./repair.js";
import { createWorkerExecutor } from "../workers/factory.js";
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
import { currentOperationContext, resolveOperationStateRoot, setOperationStage } from "../operations/state.js";
import { ensureOperationSupervisor, maybeRotateOperationSupervisor, settleDrainingSupervisorGenerations } from "../operations/supervisor.js";
import { assertContextReadiness } from "../context/preflight.js";
import { createMemoryProvider } from "../providers/memory.js";

export interface TaskRunResult {
  taskId: string;
  status: "PASS" | "FAIL";
  attempts: number;
  worker: WorkerSession;
  report: ValidationReport;
  metrics: RunMetrics;
  routing?: { profile?: string; ruleIds: string[]; agent: string; runtime: string; model: string; nativeAgent?: string; reviewers: string[]; validators: string[]; };
  planning?: { used: boolean; tasks: number; waves: number; distributed: boolean; graphUsed?: boolean; };
  controlPlane?: { sha256: string; gitCommit?: string; drifted: boolean; changed: string[]; missing: string[]; added: string[]; };
  evidence?: { sha256: string; complete: boolean; requirements: number; reasons: string[]; };
  review?: { status: "PASS" | "FAIL"; finalState: string; humanRequired: boolean; rounds: number; findings: number; debtScore: number; debtPoints: number; counts: SeverityCounts; convergence: string; leadAccepted?: boolean; reviewerSessions: number; };
  delivery?: DeliveryFinalizationResult;
}

export async function runTask(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: { profile?: string }): Promise<TaskRunResult> {
  const controlRoot = path.resolve(root);
  const operationStateRoot = resolveOperationStateRoot(root);
  const operationId = currentOperationContext().id;
  const policyResolution = await resolveOrganizationPolicyBundles(controlRoot, config);
  const effectiveConfig = withOrganizationPolicies(config, policyResolution);
  const workspaceRoot = path.resolve(await deliveryWorkspacePath(controlRoot, effectiveConfig, contract.task.id) ?? controlRoot);
  const effectiveContract = workspaceRoot === controlRoot ? contract : await loadTaskContract(workspaceRoot, contract.task.id, effectiveConfig);
  await assertContextReadiness(workspaceRoot, effectiveConfig);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const issueDrift = await verifyGithubIssueDrift(controlRoot, effectiveConfig, effectiveContract);
  if (!issueDrift.ok) throw new Error(issueDrift.message);
  if (effectiveContract.issue) await recordEvent(controlRoot, effectiveConfig, "harness.issue.drift-check", { taskId: effectiveContract.task.id, issue: effectiveContract.issue.number, repository: effectiveContract.issue.repository, ok: true, contentSha256: effectiveContract.issue.contentSha256 });
  if (effectiveContract.mode === "quick") {
    const quick = validateQuickTaskContract(effectiveConfig, effectiveContract);
    if (!quick.ok) throw new Error(`QuickContract validation failed before delegation:\n${quick.issues.map((item) => `- ${item}`).join("\n")}\nEscalate this change to SDD/spec mode.`);
  } else {
    const trace = await validateSddChange(workspaceRoot, effectiveContract.task.id, effectiveConfig);
    if (!trace.ok) throw new Error(`SDD validation failed before delegation:\n${[...trace.missing, ...trace.issues].map((item) => `- ${item}`).join("\n")}`);
  }
  if (workspaceRoot === controlRoot) await sealTask(controlRoot, effectiveConfig, effectiveContract);
  else {
    const seal = await verifyTaskSeal(workspaceRoot, effectiveContract, effectiveConfig.validation?.requireSeal ?? true);
    if (seal.status === "FAIL") throw new Error(`Delivery workspace trust check failed before delegation: ${seal.message}`);
  }

  const topologyState = await resolveTopology(controlRoot, effectiveConfig, effectiveContract, options?.profile);
  const topology = topologyState.topology;
  const route = topologyState.route;
  let selection = topologyState.selection;
  if (selection) selection = enforceSandboxPolicy(selection, effectiveConfig, effectiveContract.routing?.risk ?? "low").selection;

  // SPEC/RUN is multi-phase by construction. QUICK remains cheap for a single
  // worker and materializes its LLM supervisor only if review/remediation is needed.
  const quickReviewEnabled = effectiveContract.mode === "quick" && effectiveConfig.workflow?.reviews?.reviewQuick === true && Boolean(route?.reviewers.length);
  if (operationId && topology && (effectiveContract.mode !== "quick" || quickReviewEnabled)) {
    await runStage(operationStateRoot, operationId, "supervision", "RUNNING");
    await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology, { required: true, forceMaterialize: true });
    await runStage(operationStateRoot, operationId, "supervision", "COMPLETED");
  }

  let controller: ControlPlaneSnapshot | undefined;
  try { controller = await createControlPlaneSnapshot(controlRoot, effectiveConfig, effectiveContract.task.id); }
  catch (error) {
    if (effectiveConfig.controlPlane?.required !== false) throw error;
    await recordEvent(controlRoot, effectiveConfig, "harness.control.snapshot-failed", { taskId: effectiveContract.task.id, error: String(error) });
  }
  if (controller && workspaceRoot !== controlRoot) await materializeControlPlaneSnapshot(controller, workspaceRoot, effectiveConfig);
  await recordEvent(controlRoot, effectiveConfig, "harness.run.start", { taskId: effectiveContract.task.id, mode: effectiveContract.mode ?? "spec", workspaceRoot: workspaceRoot === controlRoot ? undefined : workspaceRoot, issue: effectiveContract.issue ? { repository: effectiveContract.issue.repository, number: effectiveContract.issue.number } : undefined, controllerSha256: controller?.compositeSha256, policyBundles: policyResolution.bundles.map((bundle) => bundle.name) });

  await refreshGraphIfConfigured(workspaceRoot, effectiveConfig);
  const beforeSnapshot = await snapshotGraph(workspaceRoot, effectiveConfig, effectiveContract.task.id, "before");
  if (!beforeSnapshot && effectiveConfig.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify before snapshot could not be created.");

  let worker: WorkerSession;
  let waveResult: PlannerWaveResult | undefined;
  let executionSessions: WorkerSession[] = [];
  let report: ValidationReport;
  const planningEnabled = topology && route && selection && effectiveConfig.workflow?.planning?.enabled !== false && effectiveContract.mode !== "quick";
  if (planningEnabled) {
    if (operationId) await runStage(operationStateRoot, operationId, "planning", "RUNNING");
    waveResult = await executePlannerWaves({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, topology, implementationSelection: selection, controller, revalidate: async () => verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection) });
    executionSessions = [...waveResult.sessions];
    if (operationId) {
      await runStage(operationStateRoot, operationId, "planning", waveResult.aggregateSession?.exitCode === 0 || !waveResult.aggregateSession ? "COMPLETED" : "FAILED");
      await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology);
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
    worker = await executor.start(workspaceRoot, effectiveConfig, effectiveContract, selection);
    executionSessions.push(worker);
    report = withWorkerExecutionCheck(await verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection), worker);
  }
  if (operationId) await runStage(operationStateRoot, operationId, "implementation", report.status === "PASS" ? "COMPLETED" : "FAILED");

  let evidenceGraph: RequirementEvidenceGraph | undefined;
  const attachEvidence = async (candidate: ValidationReport): Promise<ValidationReport> => {
    if (candidate.status !== "PASS" || effectiveConfig.evidence?.enabled !== true) return candidate;
    evidenceGraph = await buildRequirementEvidenceGraph({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, report: candidate, plan: waveResult?.plan, sessions: executionSessions });
    return mergeChecks(candidate, [evidenceValidationCheck(evidenceGraph, effectiveConfig)]);
  };
  report = await attachEvidence(report);
  const firstPassSuccess = report.status === "PASS";
  const maxRepairs = effectiveContract.repair?.maxAttempts ?? effectiveConfig.orchestration?.worker?.maxRepairAttempts ?? 2;
  let attempts = 0;
  let executor = createWorkerExecutor(effectiveConfig, selection);
  while (report.status === "FAIL" && attempts < maxRepairs) {
    if (operationId && topology) {
      await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology, { required: true, forceMaterialize: true });
      await runStage(operationStateRoot, operationId, "remediation", "RUNNING");
    }
    attempts += 1;
    const failureType = classifyFailure({ report, worker });
    const recovery = topology ? resolveRecoveryStep(topology, failureType, attempts) : { action: "same-agent" as const };
    const recoveryAction = formatRecoveryAction(recovery, selection?.logicalAgent ?? "legacy-worker");
    const packet = createRepairPacket(report, attempts, { failureType, failedAgent: selection?.logicalAgent, recoveryAction });
    if (!packet.failures.length) break;
    await writeRepairPacket(controlRoot, effectiveConfig, packet);
    await recordEvent(controlRoot, effectiveConfig, "harness.repair.start", { taskId: effectiveContract.task.id, attempt: attempts, failureType, recoveryAction, failures: packet.failures.length });
    if (recovery.action === "lead" || recovery.action === "stop") break;
    if (topology && recovery.action === "agent" && recovery.agent) selection = executionSelectionForAgent(topology, recovery.agent);
    else if (topology && recovery.action === "reroute") {
      const fallback = selectFallbackExecution(topology, effectiveContract, selection?.logicalAgent ?? "");
      if (!fallback) break;
      selection = fallback;
    }
    if (selection) {
      selection = enforceSandboxPolicy(selection, effectiveConfig, effectiveContract.routing?.risk ?? "low").selection;
      const transport = selection.transport === "inherit" ? (effectiveConfig.orchestration?.provider ?? "none") : selection.transport;
      const issues = validateExecutionCapabilities(selection, transport);
      if (issues.length) throw new Error(`Recovery agent ${selection.logicalAgent} is not executable: ${issues.join("; ")}`);
    }
    executor = createWorkerExecutor(effectiveConfig, selection);
    const recoveryHealth = await executor.doctor(workspaceRoot, effectiveConfig, selection);
    if (!recoveryHealth.ok) throw new Error(`${executor.name} recovery executor unavailable: ${recoveryHealth.message}`);
    worker = await executor.repair(workspaceRoot, effectiveConfig, effectiveContract, worker, packet, selection);
    executionSessions.push(worker);
    report = withWorkerExecutionCheck(await verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection), worker);
    report = await attachEvidence(report);
    await recordEvent(controlRoot, effectiveConfig, "harness.repair.finish", { taskId: effectiveContract.task.id, attempt: attempts, status: report.status, agent: selection?.logicalAgent });
    if (operationId && topology) await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology);
  }
  if (operationId && attempts > 0) await runStage(operationStateRoot, operationId, "remediation", report.status === "PASS" ? "COMPLETED" : "FAILED");

  let reviewSummary: TaskRunResult["review"];
  let reviewFindings: import("../agents/outputContracts.js").NormalizedFinding[] = [];
  let reviewSessions: WorkerSession[] = [];
  if (report.status === "PASS" && topology && route && selection) {
    const willRunReviewers = effectiveContract.mode !== "quick" || effectiveConfig.workflow?.reviews?.reviewQuick === true;
    if (operationId && willRunReviewers && route.reviewers.length) {
      await ensureOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology, { required: true, forceMaterialize: true });
      await runStage(operationStateRoot, operationId, "review", "RUNNING");
    }
    const review = await runReviewLifecycle({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, topology, route, implementationSelection: selection, report, revalidate: async () => verifyAfterWorker(workspaceRoot, controlRoot, effectiveConfig, effectiveContract, controller, selection) });
    report = mergeChecks(withWorkerExecutionCheck(review.report, worker), review.checks);
    reviewFindings = review.findings.findings;
    reviewSessions = review.sessions;
    const quality = review.qualityHistory.at(-1)!;
    reviewSummary = { status: review.status, finalState: review.finalState, humanRequired: review.humanRequired, rounds: review.rounds, findings: review.findings.outputCount, debtScore: quality.debtScore, debtPoints: quality.debtPoints, counts: quality.counts, convergence: quality.convergence, leadAccepted: review.leadAccepted, reviewerSessions: review.sessions.length };
    await recordEvent(controlRoot, effectiveConfig, "harness.review.finish", { taskId: effectiveContract.task.id, status: review.status, finalState: review.finalState, humanRequired: review.humanRequired, rounds: review.rounds, findings: review.findings.outputCount, debtScore: quality.debtScore, convergence: quality.convergence, leadAccepted: review.leadAccepted, sessions: review.sessions.length });
    if (operationId && willRunReviewers && route.reviewers.length) {
      await runStage(operationStateRoot, operationId, "review", review.status === "PASS" ? "COMPLETED" : review.humanRequired ? "BLOCKED" : "FAILED");
      await maybeRotateOperationSupervisor(workspaceRoot, effectiveConfig, effectiveContract, topology);
    }
    if (report.status === "PASS" && effectiveConfig.evidence?.enabled === true) {
      evidenceGraph = await buildRequirementEvidenceGraph({ root: workspaceRoot, stateRoot: controlRoot, config: effectiveConfig, contract: effectiveContract, report, plan: waveResult?.plan, findings: reviewFindings, sessions: [...executionSessions, ...reviewSessions] });
      report = mergeChecks(report, [evidenceValidationCheck(evidenceGraph, effectiveConfig)]);
    }
  }

  let deliverySummary: DeliveryFinalizationResult | undefined;
  if (report.status === "PASS") {
    if (operationId) await runStage(operationStateRoot, operationId, "delivery", "RUNNING");
    try {
      deliverySummary = await finalizeAcceptedIssue(workspaceRoot, effectiveConfig, effectiveContract);
      if (deliverySummary.status !== "SKIPPED") await recordEvent(controlRoot, effectiveConfig, "harness.delivery.finalize", { taskId: effectiveContract.task.id, status: deliverySummary.status, commitSha: deliverySummary.commitSha, pullRequest: deliverySummary.pullRequest });
      if (operationId) await runStage(operationStateRoot, operationId, "delivery", "COMPLETED");
    } catch (error) {
      deliverySummary = deliveryFinalizationFailure(error);
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

  if (operationId && topology) await settleDrainingSupervisorGenerations(workspaceRoot, operationId);
  const usageText = [...executionSessions, ...reviewSessions].map((session) => `${session.stdout}\n${session.stderr}`).join("\n");
  worker.metrics = extractUsageMetrics(usageText || `${worker.stdout}\n${worker.stderr}`);
  const metrics = buildRunMetrics({ firstPassSuccess, repairCount: attempts, humanInterventions: await countHumanInterventions(controlRoot, effectiveConfig, effectiveContract.task.id, startedAt), durationMs: Date.now() - startedMs, usage: worker.metrics });
  const routing = selection ? { profile: selection.profile, ruleIds: route?.ruleIds ?? [], agent: selection.logicalAgent, runtime: selection.runtimeName, model: selection.modelId, nativeAgent: selection.nativeAgent, reviewers: route?.reviewers ?? [], validators: route?.validators ?? [] } : undefined;
  const result: TaskRunResult = { taskId: effectiveContract.task.id, status: report.status, attempts, worker, report, metrics, routing, planning: waveResult ? { used: waveResult.used, tasks: waveResult.plan?.tasks.length ?? 0, waves: waveResult.schedule?.waves.length ?? 0, distributed: effectiveConfig.workflow?.planning?.distributed === true && effectiveConfig.distributed?.enabled === true, graphUsed: waveResult.schedule?.graphUsed } : undefined, controlPlane: controller ? { sha256: controller.compositeSha256, gitCommit: controller.gitCommit, drifted: drift.drifted, changed: drift.changed, missing: drift.missing, added: drift.added } : undefined, evidence: evidenceGraph ? { sha256: evidenceGraph.sha256, complete: evidenceGraph.complete, requirements: evidenceGraph.requirements.length, reasons: evidenceGraph.reasons } : undefined, review: reviewSummary, delivery: deliverySummary };
  const runsDir = path.resolve(controlRoot, effectiveConfig.sdd?.runsDir ?? ".harness/runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runFile = path.join(runsDir, `${effectiveContract.task.id}.json`);
  await fs.writeFile(runFile, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "PASS" && effectiveConfig.memory?.provider && effectiveConfig.memory.provider !== "none") {
    try {
      const memory = await createMemoryProvider(controlRoot, effectiveConfig);
      if (memory) await memory.remember({ project: effectiveConfig.project.name, type: "summary", title: `Accepted operation ${effectiveContract.task.id}`, content: `Accepted task ${effectiveContract.task.id}: ${effectiveContract.task.title}. Validation=${result.report.status}; attempts=${result.attempts}; review=${result.review?.status ?? "not-run"}.`, source: path.relative(controlRoot, runFile).replaceAll("\\", "/"), tags: ["aeh", "accepted", effectiveContract.mode ?? "spec"] });
    } catch (error) {
      await recordEvent(controlRoot, effectiveConfig, "harness.memory.persist-failed", { taskId: effectiveContract.task.id, error: String(error) });
      if (effectiveConfig.memory.required) throw error;
    }
  }
  await recordEvent(controlRoot, effectiveConfig, "harness.run.finish", { taskId: effectiveContract.task.id, status: result.status, attempts, mode: effectiveContract.mode ?? "spec", workspaceRoot: workspaceRoot === controlRoot ? undefined : workspaceRoot, agent: selection?.logicalAgent, runtime: selection?.runtimeName, model: selection?.modelId, profile: selection?.profile, waves: result.planning?.waves, controllerSha256: result.controlPlane?.sha256, controllerDrifted: result.controlPlane?.drifted, evidenceComplete: result.evidence?.complete, evidenceSha256: result.evidence?.sha256, reviewStatus: reviewSummary?.status, reviewFinalState: reviewSummary?.finalState, humanRequired: reviewSummary?.humanRequired ?? deliverySummary?.humanRequired, debtScore: reviewSummary?.debtScore, deliveryStatus: deliverySummary?.status, pullRequest: deliverySummary?.pullRequest, durationMs: metrics.durationMs, totalTokens: metrics.usage.totalTokens ?? 0, costUsd: metrics.usage.costUsd ?? 0 });
  return result;
}

async function resolveTopology(root: string, config: HarnessProjectConfig, contract: TaskContract, profileOverride?: string): Promise<{ topology?: ResolvedAgentTopology; route?: ResolvedRoute; selection?: AgentExecutionSelection }> {
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
    await recordEvent(root, config, "harness.agent.route", { taskId: contract.task.id, profile, agent: selection.logicalAgent, runtime: selection.runtimeName, model: selection.modelId, nativeAgent: selection.nativeAgent, transport, ruleIds: route.ruleIds, reviewers: route.reviewers });
    return { topology, route, selection };
  } catch (error) {
    if (config.agents.required) throw error;
    await recordEvent(root, config, "harness.agent.topology-fallback", { taskId: contract.task.id, error: String(error) });
    return {};
  }
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
