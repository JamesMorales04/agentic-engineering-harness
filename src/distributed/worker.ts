import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { WorkUnitOutput } from "../agents/outputContracts.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { executeAgentPrompt, materializeAgentPrompt, prepareAgentExecutionBinding, prepareRuntimeSession, type PreparedAgentExecutionIdentity } from "../workers/agentPrompt.js";
import { assertRoleInvocationPolicyV1, assertSkillManifestV1, type RoleInvocationPolicyV1, type SkillManifestV1 } from "../architecture/executionIdentity.js";
import { runExecutable } from "../utils/process.js";
import { claimDistributedJob, completeDistributedJob, publishDistributedSessionReady, releaseDistributedExecutionBinding, submitDistributedJob, waitForDistributedExecutionRelease, waitForDistributedResult, waitForDistributedSessionReady } from "./queue.js";
import type { DistributedDelegationJob, DistributedDelegationResult, DistributedExecutionReleaseV1, DistributedSessionReadyV1 } from "./types.js";
import { enforceSandboxPolicy, sandboxPolicyDigest } from "../security/sandbox.js";
import type { ExecutionAuthorityV1 } from "../security/executionLease.js";
import { assertExecutionBindingV2, assertExecutionBlueprintV2 } from "../architecture/executionIdentity.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { currentControllerEpoch, loadOperation } from "../operations/state.js";
import { assertExecutionAuthority } from "../security/executionLease.js";
import { sha256Canonical } from "../core/digest.js";
import { createPromptManifest } from "../context/runtimeV2.js";

export async function dispatchDistributedDelegation(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  task: WorkUnitOutput;
  participantId: string;
  selection: AgentExecutionSelection;
  controller?: ControlPlaneSnapshot;
  waveBase: CandidateRevisionV1;
  identity: PreparedAgentExecutionIdentity;
}): Promise<DistributedDelegationResult> {
  if (!input.config.distributed?.enabled) throw new Error("Distributed execution is not enabled.");
  const identity = input.identity;
  assertExecutionAuthority(identity.authority);
  assertExecutionBlueprintV2(identity.executionBlueprint);
  assertRoleInvocationPolicyV1(identity.roleInvocationPolicy);
  assertSkillManifestV1(identity.skillManifest);
  const assignment = identity.executionBlueprint.participants.find((participant) => participant.participantId === input.participantId);
  const observedPromptManifestDigest = createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: identity.prompt, role: input.selection.role, source: "agent-prompt-projection" }] }).digest;
  if (!assignment || input.participantId !== identity.authority.participantId || identity.authority.candidateDigest !== input.waveBase.identityDigest || identity.executionBlueprint.candidateDigest !== input.waveBase.identityDigest || identity.executionBlueprint.operationId !== identity.authority.operationId || identity.executionBlueprint.controllerEpoch !== identity.authority.controllerEpoch || assignment.roleInvocationPolicy.digest !== identity.roleInvocationPolicy.digest || identity.roleInvocationPolicy.participantId !== input.participantId || identity.skillManifest.digest !== assignment.skillManifestDigest || identity.skillManifest.scope.participantId !== input.participantId || identity.skillManifest.scope.operationId !== identity.authority.operationId || identity.skillManifest.scope.operationExecutionRevision !== identity.executionBlueprint.operationExecutionRevision || identity.skillManifest.scope.candidateRevision !== identity.executionBlueprint.candidateRevision || identity.skillManifest.scope.candidateDigest !== identity.authority.candidateDigest || identity.skillManifest.scope.controllerEpoch !== identity.authority.controllerEpoch || !/^[a-f0-9]{64}$/.test(identity.contextManifestDigest) || sha256Canonical(identity.contextManifest) !== identity.contextManifestDigest || observedPromptManifestDigest !== identity.promptManifestDigest) throw new Error("DISTRIBUTED_EXECUTION_IDENTITY_INVALID: authority, participant plan, skill manifest, blueprint, and actual context/prompt manifests do not describe the same launch.");
  const operation = await loadOperation(input.root, identity.authority.operationId);
  if (!operation.candidateRevision || operation.candidateRevision.identityDigest !== identity.authority.candidateDigest || operation.operationExecutionRevision !== identity.executionBlueprint.operationExecutionRevision || currentControllerEpoch(operation) !== identity.authority.controllerEpoch || operation.resolvedOperationPolicy?.digest !== identity.executionBlueprint.resolvedOperationPolicy.digest) throw new Error("EXECUTION_BINDING_STALE: distributed launch requires the current candidate, policy, execution revision, and controller epoch.");
  await assertWorkspaceMatchesCandidate(input.root, input.waveBase);
  const remote = await runExecutable("git", ["remote", "get-url", "origin"], { cwd: input.root, timeoutMs: 10_000 }); if (remote.exitCode !== 0 || !remote.stdout.trim()) throw new Error("Distributed execution requires a Git remote named origin.");
  const base = await runExecutable("git", ["rev-parse", "HEAD"], { cwd: input.root, timeoutMs: 10_000 }); if (base.exitCode !== 0) throw new Error("Distributed execution could not resolve the workspace HEAD.");
  const candidatePatch = await createDistributedCandidatePatch(input.root);
  const decision = enforceSandboxPolicy(input.selection, input.config, input.task.risk === "critical" ? "high" : input.task.risk);
  const selection: AgentExecutionSelection = { ...decision.selection };
  const job: DistributedDelegationJob = {
    version: 2,
    id: `${safe(input.contract.task.id)}-${safe(input.task.id)}-${crypto.randomUUID()}`,
    parentTaskId: input.contract.task.id,
    createdAt: new Date().toISOString(),
    repositoryUrl: remote.stdout.trim(),
    baseRef: base.stdout.trim(),
    baseCandidate: input.waveBase,
    candidatePatch,
    controllerSha256: input.controller?.compositeSha256,
    task: input.task,
    contract: input.contract,
    selection,
    sandboxPolicySha256: sandboxPolicyDigest(input.config, selection, input.task.risk === "critical" ? "high" : input.task.risk),
    executionAuthority: identity.authority,
    executionBlueprint: identity.executionBlueprint,
    roleInvocationPolicy: identity.roleInvocationPolicy,
    skillManifest: identity.skillManifest,
    sessionPreparation: { contextManifest: identity.contextManifest, contextManifestDigest: identity.contextManifestDigest, promptManifestDigest: identity.promptManifestDigest },
    config: sanitizeRemoteConfig(input.config),
    prompt: identity.prompt
  };
  await submitDistributedJob(input.root, input.config, job);
  const ready = await waitForDistributedSessionReady(input.root, input.config, job.id);
  validateDistributedSessionReady(ready, job);
  const prepared = await prepareAgentExecutionBinding(input.root, input.config, input.contract, selection, identity.prompt, {
    phase: "distributed",
    capabilityAuthority: identity.authority,
    participantId: input.participantId,
    requireExecutionAuthority: true,
    executionBlueprint: identity.executionBlueprint,
    executionBlueprintDigest: identity.executionBlueprint.digest,
    roleInvocationPolicy: identity.roleInvocationPolicy,
    skillManifest: identity.skillManifest,
    preparedPrompt: identity.prompt,
    contextManifest: identity.contextManifest,
    contextManifestDigest: identity.contextManifestDigest,
    promptManifestDigest: identity.promptManifestDigest,
    executionSessionId: ready.runtime.sessionId
  });
  const release: DistributedExecutionReleaseV1 = { version: 1, jobId: job.id, workerId: ready.workerId, leaseId: ready.leaseId, releasedAt: new Date().toISOString(), executionBinding: prepared.binding };
  await releaseDistributedExecutionBinding(input.root, input.config, release);
  const result = await waitForDistributedResult(input.root, input.config, job.id);
  if (result.version !== 2) throw new Error("UNSUPPORTED_DISTRIBUTED_RESULT_VERSION: migrate this worker result to the two-phase execution identity protocol.");
  if (result.jobId !== job.id || result.workerId !== ready.workerId || result.status === "PASS" && (result.session.executionBinding?.digest !== prepared.binding.digest || result.session.id !== prepared.binding.runtime.sessionId)) throw new Error("DISTRIBUTED_EXECUTION_BINDING_MISMATCH: worker result does not carry the controller-issued binding, the same actual runtime session, and the owning job/worker identity.");
  return result;
}

export async function createDistributedCandidatePatch(root: string): Promise<string> {
  const indexFile = path.join(os.tmpdir(), `aeh-distributed-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const markUntracked = readTree.exitCode === 0 ? await runExecutable("git", ["add", "-N", "--all"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const patch = markUntracked.exitCode === 0 ? await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd: root, timeoutMs: 60_000, env }) : markUntracked;
    if (patch.exitCode !== 0) throw new Error(`DISTRIBUTED_CANDIDATE_SNAPSHOT_FAILED: ${patch.stderr || patch.stdout}`);
    return patch.stdout;
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

export async function runDistributedWorkerOnce(root: string, config: HarnessProjectConfig, workerId = config.distributed?.workerId ?? `worker-${process.pid}`): Promise<DistributedDelegationResult | undefined> {
  const claimed = await claimDistributedJob(root, config, workerId); if (!claimed) return undefined;
  const result = await executeClaimedJob(root, claimed.job, workerId, claimed.leaseId, config);
  await completeDistributedJob(root, config, claimed.leaseId, result);
  return result;
}

export async function runDistributedWorkerLoop(root: string, config: HarnessProjectConfig, options: { workerId?: string; once?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const workerId = options.workerId ?? config.distributed?.workerId ?? `worker-${process.pid}`; const interval = config.distributed?.pollIntervalMs ?? 1000;
  do {
    if (options.signal?.aborted) return;
    const result = await runDistributedWorkerOnce(root, config, workerId);
    if (options.once) return;
    if (!result) await new Promise((resolve) => setTimeout(resolve, interval));
  } while (!options.signal?.aborted);
}

export interface DistributedSandboxValidation {
  selection: AgentExecutionSelection;
  config: HarnessProjectConfig;
}

export function validateDistributedSandboxPolicy(job: DistributedDelegationJob, workerConfig: HarnessProjectConfig): DistributedSandboxValidation {
  if ((job as { version?: number }).version !== 2) throw new Error("UNSUPPORTED_DISTRIBUTED_JOB_VERSION: migrate this job to the two-phase ExecutionBinding session protocol.");
  assertExecutionBlueprintV2(job.executionBlueprint);
  assertRoleInvocationPolicyV1(job.roleInvocationPolicy);
  assertSkillManifestV1(job.skillManifest);
  if (!job.executionAuthority) throw new Error("DISTRIBUTED_EXECUTION_BINDING_INVALID: controller-issued execution authority is missing.");
  try { assertExecutionAuthority(job.executionAuthority); }
  catch (error) { throw new Error(`DISTRIBUTED_EXECUTION_BINDING_INVALID: controller-issued authority is invalid: ${String(error)}`); }
  const participantId = job.executionAuthority.participantId;
  const participant = job.executionBlueprint.participants.find((entry) => entry.participantId === participantId);
  const observedContextDigest = job.sessionPreparation?.contextManifest ? sha256Canonical(job.sessionPreparation.contextManifest) : "";
  const observedPromptDigest = typeof job.prompt === "string" ? createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: job.prompt, role: job.selection.role, source: "agent-prompt-projection" }] }).digest : "";
  if (!participant || job.executionBlueprint.operationId !== job.executionAuthority.operationId || job.executionBlueprint.candidateDigest !== job.executionAuthority.candidateDigest || job.executionBlueprint.controllerEpoch !== job.executionAuthority.controllerEpoch || job.baseCandidate.identityDigest !== job.executionAuthority.candidateDigest || participant.roleInvocationPolicy.digest !== job.roleInvocationPolicy.digest || job.roleInvocationPolicy.participantId !== participantId || participant.skillManifestDigest !== job.skillManifest.digest || job.skillManifest.scope.participantId !== participantId || job.skillManifest.scope.operationId !== job.executionAuthority.operationId || job.skillManifest.scope.operationExecutionRevision !== job.executionBlueprint.operationExecutionRevision || job.skillManifest.scope.candidateRevision !== job.executionBlueprint.candidateRevision || job.skillManifest.scope.candidateDigest !== job.executionAuthority.candidateDigest || job.skillManifest.scope.controllerEpoch !== job.executionAuthority.controllerEpoch || !/^[a-f0-9]{64}$/.test(job.sessionPreparation?.contextManifestDigest ?? "") || observedContextDigest !== job.sessionPreparation.contextManifestDigest || !/^[a-f0-9]{64}$/.test(job.sessionPreparation?.promptManifestDigest ?? "") || observedPromptDigest !== job.sessionPreparation.promptManifestDigest) throw new Error("DISTRIBUTED_EXECUTION_IDENTITY_INVALID: job authority, blueprint, role policy, SkillManifest, candidate, and actual context/prompt manifests do not describe the same launch.");
  const expectedDigest = sandboxPolicyDigest(job.config, job.selection, job.task.risk === "critical" ? "high" : job.task.risk);
  if (job.sandboxPolicySha256 !== expectedDigest) throw new Error("DISTRIBUTED_SANDBOX_POLICY_TAMPERED: job sandbox policy digest does not match its selection/configuration.");
  const originating = enforceSandboxPolicy(job.selection, job.config, job.task.risk === "critical" ? "high" : job.task.risk);
  if (originating.selection.transport !== job.selection.transport) throw new Error("DISTRIBUTED_SANDBOX_POLICY_WEAKENED: job selection does not satisfy the originating sandbox policy.");
  const local = enforceSandboxPolicy(job.selection, workerConfig, job.task.risk === "critical" ? "high" : job.task.risk);
  if (local.selection.transport !== job.selection.transport) throw new Error("DISTRIBUTED_SANDBOX_POLICY_WEAKENED: job selection does not satisfy the worker sandbox policy.");
  return {
    selection: job.selection,
    config: local.required ? { ...job.config, security: { ...job.config.security, sandbox: workerConfig.security?.sandbox } } : job.config
  };
}

async function executeClaimedJob(workerRoot: string, job: DistributedDelegationJob, workerId: string, leaseId: string, workerConfig: HarnessProjectConfig): Promise<DistributedDelegationResult> {
  const startedAt = new Date().toISOString(); const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-remote-${safe(job.id)}-`)); let session: WorkerSession = { provider: job.selection.runtimeAdapter, model: job.selection.modelName, logicalAgent: job.selection.logicalAgent, runtime: job.selection.runtimeName, exitCode: 1, stdout: "", stderr: "remote worker did not start" }; let directWorkerHome: { directory: string } | undefined; let materializedPaseoSession: WorkerSession | undefined;
  try {
    const sandbox = validateDistributedSandboxPolicy(job, workerConfig);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(job.baseRef)) return failure(job, workerId, startedAt, session, "distributed job baseRef is not a full Git object ID");
    const clone = await runExecutable("git", ["clone", "--quiet", "--no-checkout", "--", job.repositoryUrl, worktree], { cwd: os.tmpdir(), timeoutMs: 300_000, toolchain: false }); if (clone.exitCode !== 0) return failure(job, workerId, startedAt, session, `clone failed: ${clone.stderr || clone.stdout}`);
    const checkout = await runExecutable("git", ["checkout", "--quiet", "--detach", job.baseRef], { cwd: worktree, timeoutMs: 120_000 }); if (checkout.exitCode !== 0) return failure(job, workerId, startedAt, session, `checkout failed: ${checkout.stderr || checkout.stdout}`);
    if (job.candidatePatch) { const applied = await runExecutable("git", ["apply", "--binary", "-"], { cwd: worktree, timeoutMs: 60_000, stdin: job.candidatePatch }); if (applied.exitCode !== 0) return failure(job, workerId, startedAt, session, `candidate source patch failed: ${applied.stderr || applied.stdout}`); }
    let observedCandidateSourceDigest: string;
    try { observedCandidateSourceDigest = (await assertWorkspaceMatchesCandidate(worktree, job.baseCandidate)).observedSourceDigest; }
    catch (error) { return failure(job, workerId, startedAt, session, `DISTRIBUTED_CANDIDATE_MISMATCH: remote workspace does not reproduce frozen wave base ${job.baseCandidate.candidateId} r${job.baseCandidate.revision}: ${String(error)}`); }
    const baselineAdd = await runExecutable("git", ["add", "-A"], { cwd: worktree, timeoutMs: 30_000 });
    const baselineCommit = baselineAdd.exitCode === 0 ? await runExecutable("git", ["-c", "user.name=aeh", "-c", "user.email=aeh@localhost", "commit", "--no-gpg-sign", "--allow-empty", "-m", "aeh distributed baseline"], { cwd: worktree, timeoutMs: 60_000 }) : baselineAdd;
    if (baselineCommit.exitCode !== 0) return failure(job, workerId, startedAt, session, `baseline commit failed: ${baselineCommit.stderr || baselineCommit.stdout}`);
    if (!job.executionAuthority || job.executionBlueprint.version !== 2 || job.roleInvocationPolicy.version !== 1 || job.skillManifest.version !== 1) return failure(job, workerId, startedAt, session, "EXECUTION_BINDING_REQUIRED: distributed job lacks a complete versioned identity envelope.");
    const sessionPreparationOptions = { phase: "distributed", capabilityAuthority: job.executionAuthority, participantId: job.executionAuthority.participantId, outputContract: job.roleInvocationPolicy.outputContract, executionBlueprint: job.executionBlueprint, executionBlueprintDigest: job.executionBlueprint.digest, roleInvocationPolicy: job.roleInvocationPolicy, skillManifest: job.skillManifest, contextManifest: job.sessionPreparation.contextManifest, contextManifestDigest: job.sessionPreparation.contextManifestDigest, promptManifestDigest: job.sessionPreparation.promptManifestDigest };
    const sessionId = sandbox.selection.transport === "paseo"
      ? (materializedPaseoSession = await materializeAgentPrompt(worktree, sandbox.config, job.contract, sandbox.selection, sessionPreparationOptions))?.id
      : await prepareRuntimeSession(worktree, sandbox.config, sandbox.selection, sessionPreparationOptions, job.executionAuthority, sandbox.selection.transport, (home) => { directWorkerHome = home; });
    if (!sessionId?.trim() || sessionId.startsWith("launch:")) return failure(job, workerId, startedAt, session, "EXECUTION_BINDING_SESSION_REQUIRED: worker runtime did not materialize an actual durable session before requesting the controller binding.");
    const ready: DistributedSessionReadyV1 = {
      version: 1, jobId: job.id, workerId, leaseId, preparedAt: new Date().toISOString(),
      runtime: { runtimeId: sandbox.selection.runtimeName, provider: sandbox.selection.modelProvider ?? sandbox.selection.paseoProvider ?? sandbox.selection.runtimeAdapter, modelId: sandbox.selection.modelId, model: sandbox.selection.modelName, sessionId },
      contextManifestDigest: job.sessionPreparation.contextManifestDigest,
      promptManifestDigest: job.sessionPreparation.promptManifestDigest,
      sessionPreparation: "RUNTIME_MATERIALIZED"
    };
    await publishDistributedSessionReady(workerRoot, workerConfig, ready);
    const release = await waitForDistributedExecutionRelease(workerRoot, workerConfig, job.id, workerId, leaseId);
    const binding = release.executionBinding;
    assertExecutionBindingV2(binding);
    if (binding.operationId !== job.executionAuthority.operationId || binding.participantId !== job.executionAuthority.participantId || binding.candidateDigest !== job.executionAuthority.candidateDigest || binding.controllerEpoch !== job.executionAuthority.controllerEpoch || binding.executionBlueprintDigest !== job.executionBlueprint.digest || binding.roleInvocationPolicyDigest !== job.roleInvocationPolicy.digest || binding.skillManifestDigest !== job.skillManifest.digest || binding.runtime.sessionId !== sessionId || binding.runtime.runtimeId !== ready.runtime.runtimeId || binding.runtime.provider !== ready.runtime.provider || binding.runtime.modelId !== ready.runtime.modelId || binding.runtime.model !== ready.runtime.model || binding.contextManifestDigest !== job.sessionPreparation.contextManifestDigest || binding.promptManifestDigest !== job.sessionPreparation.promptManifestDigest || binding.outputContract !== job.roleInvocationPolicy.outputContract || binding.leaseIdentities.join("\0") !== job.executionAuthority.leases.map((lease) => lease.leaseId).sort().join("\0")) return failure(job, workerId, startedAt, session, "DISTRIBUTED_EXECUTION_RELEASE_IDENTITY_MISMATCH: controller release changed the prepared runtime or frozen participant identity.");
    session = await executeAgentPrompt(worktree, sandbox.config, job.contract, sandbox.selection, job.prompt, {
      outputContract: job.roleInvocationPolicy.outputContract,
      phase: "distributed",
      capabilityAuthority: job.executionAuthority,
      participantId: job.executionAuthority.participantId,
      requireExecutionAuthority: true,
      executionBinding: binding,
      executionBlueprint: job.executionBlueprint,
      executionBlueprintDigest: job.executionBlueprint.digest,
      roleInvocationPolicy: job.roleInvocationPolicy,
      skillManifest: job.skillManifest,
      contextManifestDigest: binding.contextManifestDigest,
      promptManifestDigest: binding.promptManifestDigest,
      executionSessionId: binding.runtime.sessionId,
      directWorkerHome,
      materializedPaseoSession,
      contextManifest: job.sessionPreparation.contextManifest,
      preparedPrompt: job.prompt,
    });
    if (session.id !== binding.runtime.sessionId || session.executionBinding?.digest !== binding.digest) return failure(job, workerId, startedAt, session, "DISTRIBUTED_EXECUTION_BINDING_MISMATCH: runtime returned a different or unbound session.");
    if (session.exitCode !== 0) return failure(job, workerId, startedAt, session, `agent exited with ${session.exitCode}`);
    const status = await runExecutable("git", ["status", "--porcelain"], { cwd: worktree, timeoutMs: 30_000 }); const untracked = status.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean); if (untracked.length) await runExecutable("git", ["add", "-N", "--", ...untracked], { cwd: worktree, timeoutMs: 30_000 });
    const names = await runExecutable("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, timeoutMs: 30_000 }); const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const escaped = changedFiles.filter((file) => !job.task.scope.some((scope) => matches(file, scope))); if (escaped.length) return failure(job, workerId, startedAt, session, `remote task escaped scope: ${escaped.join(", ")}`, changedFiles);
    const diff = await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: worktree, timeoutMs: 60_000 }); if (diff.exitCode !== 0) return failure(job, workerId, startedAt, session, diff.stderr || "unable to capture patch", changedFiles);
    return { version: 2, jobId: job.id, workerId, startedAt, finishedAt: new Date().toISOString(), status: "PASS", session, changedFiles, patch: diff.stdout, observedCandidateSourceDigest };
  } catch (error) { return failure(job, workerId, startedAt, session, String(error)); }
  finally { if (directWorkerHome) await fs.rm(directWorkerHome.directory, { recursive: true, force: true }).catch(() => undefined); await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined); }
}

function failure(job: DistributedDelegationJob, workerId: string, startedAt: string, session: WorkerSession, message: string, changedFiles: string[] = []): DistributedDelegationResult { return { version: 2, jobId: job.id, workerId, startedAt, finishedAt: new Date().toISOString(), status: "FAIL", session: { ...session, exitCode: session.exitCode || 1, stderr: [session.stderr, message].filter(Boolean).join("\n") }, changedFiles, patch: "", message }; }
function validateDistributedSessionReady(ready: DistributedSessionReadyV1, job: DistributedDelegationJob): void {
  const selection = job.selection;
  const expectedProvider = selection.modelProvider ?? selection.paseoProvider ?? selection.runtimeAdapter;
  const expectedPreparation = "RUNTIME_MATERIALIZED";
  if (ready.version !== 1 || ready.jobId !== job.id || !ready.workerId.trim() || !ready.leaseId.trim() || !ready.runtime?.sessionId?.trim() || ready.runtime.sessionId.startsWith("launch:") || ready.runtime.runtimeId !== selection.runtimeName || ready.runtime.provider !== expectedProvider || ready.runtime.modelId !== selection.modelId || ready.runtime.model !== selection.modelName || ready.contextManifestDigest !== job.sessionPreparation.contextManifestDigest || ready.promptManifestDigest !== job.sessionPreparation.promptManifestDigest || ready.sessionPreparation !== expectedPreparation) throw new Error("DISTRIBUTED_SESSION_READY_IDENTITY_MISMATCH: worker runtime evidence does not match the approved launch and actual prompt manifests.");
}
function sanitizeRemoteConfig(config: HarnessProjectConfig): HarnessProjectConfig { return { ...config, delivery: { ...config.delivery, github: { ...config.delivery?.github, enabled: false }, paseo: { ...config.delivery?.paseo, enabled: false, autoUseWorkspace: false } }, distributed: { ...config.distributed, enabled: false }, telemetry: { ...config.telemetry, exporter: "none" } }; }
function matches(file: string, scope: string): boolean { const prefix = scope.split(/[?*\[]/, 1)[0].replace(/\/+$/, ""); return scope === "**" || minimatch(file, scope, { dot: true }) || (Boolean(prefix) && (file === prefix || file.startsWith(`${prefix}/`))); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
