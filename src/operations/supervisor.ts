import type { AgentExecutionSelection } from "../agents/types.js";
import { supervisorOutputSchema, type NormalizedFinding, type SupervisorOutput } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { sha256Utf8 } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { statusLeadContext } from "../paseo/context.js";
import { archivePaseoSdkAgent } from "../paseo/sdk.js";
import { stopManagedPaseoAgent } from "../paseo/runtimeCore.js";
import { isUncertainProviderTurn } from "../paseo/firstActivityDeadline.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { structuredResultProvenanceForAgent } from "../workers/resultGateway.js";
import { dispatchMaterializedAgentPrompt, executeAgentPrompt, materializeAgentPrompt } from "../workers/agentPrompt.js";
import { hasTraceableAcceptance } from "../workers/promptPolicy.js";
import { persistOperationConsolidation, persistSupervisorCheckpoint } from "./artifacts.js";
import { supervisorEventSkills, type SupervisorSemanticEvent } from "./supervisorEventPolicy.js";
import { compactDeterministicEvidence, supervisorCheckpointProjection, supervisorConsolidationProjection, supervisorHandoffProjection, supervisorInitializationProjection } from "./supervisorPrompt.js";
import { activeOperationSupervisor, currentOperationContext, loadOperation, patchOperation, registerSupervisorGeneration, resolveOperationStateRoot, updateSupervisorGeneration, withOperationCoordinationLock, type OperationRecordV2 } from "./state.js";
import { STALL_RETRY_MAX_ATTEMPTS_PER_PHASE, transactStallRetrySpend } from "./stallRetryBudget.js";

/**
 * A supervisor generation's structured-result channel is bound to the candidate digest it was
 * materialized under. The generation is only reusable while that binding matches the operation's
 * current candidate; otherwise a consolidation continuation fails closed with
 * `AEH_RESULT_STALE_CANDIDATE` and the generation must be rotated (AEH-V2-0120).
 */
export function supervisorGenerationCandidateCurrentV1(
  provenance: { status: string; candidate?: { identityDigest: string } } | undefined,
  operation: Pick<OperationRecordV2, "candidateRevision">
): boolean {
  if (!provenance || provenance.status !== "BOUND" || !provenance.candidate) return true;
  if (!operation.candidateRevision) return false;
  return provenance.candidate.identityDigest === operation.candidateRevision.identityDigest;
}

export function supervisorSourceFindingIdsMatchV1(expected: readonly string[], received: readonly string[]): boolean {
  const left = [...new Set(expected)].sort();
  const right = [...new Set(received)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function supervisorConsolidationCorrectionPromptV1(input: SupervisorConsolidationInput, requiredIds: readonly string[], receivedIds: readonly string[]): string {
  const disallowed = [...new Set(receivedIds)].filter((id) => !requiredIds.includes(id)).sort();
  return [
    "[AEH_SUPERVISOR_CONSOLIDATE_CORRECTION]",
    "The previous consolidation response did not preserve the exact frozen source finding set.",
    `Required sourceFindingIds (exactly these ids, each once, nothing else): ${JSON.stringify([...new Set(requiredIds)].sort())}`,
    ...(disallowed.length ? [`Superseded finding ids from earlier review rounds, repair rounds, or consolidation events that must never appear: ${JSON.stringify(disallowed)}`] : []),
    `Raw findings: ${JSON.stringify(input.findings)}`,
    "Return the corrected consolidation output matching the frozen supervisor contract. Keep the exact raw finding set; add no ids and omit none."
  ].join("\n\n");
}

export function supervisorConsolidationContractCorrectionPromptV1(input: SupervisorConsolidationInput, requiredIds: readonly string[], failure: string): string {
  return [
    "[AEH_SUPERVISOR_CONSOLIDATE_CORRECTION]",
    `The previous consolidation response did not match the frozen supervisor output contract: ${failure}`,
    `Required sourceFindingIds (exactly these ids, each once, nothing else): ${JSON.stringify([...new Set(requiredIds)].sort())}`,
    "Serialize only the result already present in this session: one JSON object with summary (string), consolidatedFindings, sourceFindingIds (strings), conflicts, missingEvidence (array of strings), unresolved, roadmap, finalizationSafety. Do not add findings, ids, or conclusions.",
    `Raw findings: ${JSON.stringify(input.findings)}`
  ].join("\n\n");
}

export interface SupervisorConsolidationTurnV1 {
  session: WorkerSession;
  output?: SupervisorOutput;
  failure?: string;
}

/**
 * Bounded consolidation correction loop: at most two supervisor turns (initial plus one correction).
 * The single correction covers either a contract-invalid response or a provenance mismatch by
 * re-stating the frozen contract and the exact required id set. The schema and exact-set checks
 * still fail closed; no field is repaired or coerced and a second failure is a hard error.
 */
export async function withBoundedSupervisorConsolidationCorrectionV1(input: {
  expectedFindingIds: readonly string[];
  initialPrompt: string;
  provenanceCorrectionPrompt: (receivedIds: readonly string[]) => string;
  contractCorrectionPrompt: (failure: string) => string;
  onCorrection?: (detail: { receivedIds?: string[]; failure?: string }) => Promise<void>;
  requestTurn: (prompt: string) => Promise<SupervisorConsolidationTurnV1>;
}): Promise<{ session: WorkerSession; output: SupervisorOutput; prompt: string }> {
  const expected = [...new Set(input.expectedFindingIds)].sort();
  const first = await input.requestTurn(input.initialPrompt);
  if (first.output) {
    const firstIds = [...new Set(first.output.sourceFindingIds)].sort();
    if (supervisorSourceFindingIdsMatchV1(expected, firstIds)) return { session: first.session, output: first.output, prompt: input.initialPrompt };
    await input.onCorrection?.({ receivedIds: firstIds });
    const correction = input.provenanceCorrectionPrompt(firstIds);
    const corrected = await input.requestTurn(correction);
    if (!corrected.output) throw new Error(`AEH_OPERATION_SUPERVISOR_CONTRACT: ${corrected.failure ?? "correction response did not match the supervisor contract"}`);
    const correctedIds = [...new Set(corrected.output.sourceFindingIds)].sort();
    if (!supervisorSourceFindingIdsMatchV1(expected, correctedIds)) {
      throw new Error(`AEH_OPERATION_SUPERVISOR_PROVENANCE: consolidation did not account for the exact raw finding set. expected=${expected.join(",")} received=${correctedIds.join(",")}`);
    }
    return { session: corrected.session, output: corrected.output, prompt: correction };
  }
  const failure = first.failure ?? "unparseable supervisor response";
  await input.onCorrection?.({ failure });
  const correction = input.contractCorrectionPrompt(failure);
  const corrected = await input.requestTurn(correction);
  if (!corrected.output) throw new Error(`AEH_OPERATION_SUPERVISOR_CONTRACT: ${corrected.failure ?? "correction response did not match the supervisor contract"}`);
  const correctedIds = [...new Set(corrected.output.sourceFindingIds)].sort();
  if (!supervisorSourceFindingIdsMatchV1(expected, correctedIds)) {
    throw new Error(`AEH_OPERATION_SUPERVISOR_PROVENANCE: consolidation did not account for the exact raw finding set. expected=${expected.join(",")} received=${correctedIds.join(",")}`);
  }
  return { session: corrected.session, output: corrected.output, prompt: correction };
}

export interface EnsureSupervisorOptions { required?: boolean; forceMaterialize?: boolean; }
export interface OperationSupervisorHandle { operationId: string; generation: number; agentId?: string; materialized: boolean; selection: AgentExecutionSelection; session?: WorkerSession; }
export interface SupervisorConsolidationInput { key: string; purpose: string; findings: NormalizedFinding[]; sourceArtifacts?: string[]; deterministicEvidence?: unknown; }
export interface SupervisorConsolidationResult { output: SupervisorOutput; artifact: string; session: WorkerSession; }

/**
 * DETERMINISTIC bounded retry budget for supervisor consolidation stall/timeout kills (A3
 * stall-retry parity: consolidation turn timeout `AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT`
 * was terminal while init/rotation have 2 attempts). Exactly one retry is allowed per
 * consolidation with a fresh generation and IDENTICAL inputs (same finding-set, same prompt
 * content, no hints); a second stall/timeout kill rethrows the original class. Reuses the
 * existing timeout taxonomy (`supervisorTurnTimedOutV1`: exit 124 / timed out|timeout|
 * stalled_first_activity) — no new error classes. INVALID/schema/contract/provenance always
 * terminal. Mirrors the repair maxAttempts=2 budget language: max 2 attempts total.
 * Consolidation retry is idempotent (no artifact persisted until success; fresh generation,
 * same finding-set; never silently retry semantic content — same inputs, fresh turn).
 * Structured diagnostics (exitCode/killReason/status/activityCounts) are preserved via the
 * session passed to the classifier and in the turn-timeout trace.
 */
export const SUPERVISOR_CONSOLIDATION_STALL_MAX_ATTEMPTS = 2;
export const SUPERVISOR_CONSOLIDATION_STALL_MAX_RETRIES = 1;

type SupervisorConsolidationStallSessionShape = Pick<WorkerSession, "exitCode" | "stdout" | "stderr"> & {
  killReason?: WorkerSession["killReason"];
  status?: WorkerSession["status"];
};

export function isSupervisorConsolidationStallKill(
  error: unknown,
  session?: SupervisorConsolidationStallSessionShape | undefined
): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/AEH_OPERATION_SUPERVISOR_CONTRACT|AEH_OPERATION_SUPERVISOR_PROVENANCE|AEH_OPERATION_SUPERVISOR_FAILED|AEH_OPERATION_SUPERVISOR_BINDING|AEH_OPERATION_SUPERVISOR_UNAVAILABLE|AEH_OPERATION_SUPERVISOR_ROTATION_FAILED|RESULT_INVALID|RESULT_ARTIFACT_MISSING|RESULT_ID_MISSING|AEH_RESULT_PROVENANCE|CANDIDATE_WORKSPACE_MISMATCH/.test(message)) return false;
  if (/AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT/.test(message)) return true;
  if (session) {
    if (session.killReason === "STALLED_FIRST_ACTIVITY" || (session as { killReason?: string }).killReason === "DEADLINE") return true;
    if (session.status === "timeout") return true;
    if (session.exitCode === 124) return true;
    try {
      if (supervisorTurnTimedOutV1(session)) return true;
    } catch {
      // Classifier is total over the picked shape; a malformed shape is not a stall.
    }
  }
  if (/exit[^0-9]*124|exitCode[^0-9]*124|exit=124/.test(message)) return true;
  if (/STALLED_FIRST_ACTIVITY|stalled_first_activity/.test(message)) return true;
  if (/timed out|timeout/i.test(message)) return true;
  return false;
}

export function shouldRetrySupervisorConsolidationStall(
  error: unknown,
  retriesSoFar: number,
  session?: SupervisorConsolidationStallSessionShape | undefined
): boolean {
  // E-NEW-9: never fresh-generation retry an unverified stop (twin-writer risk).
  if (isUncertainProviderTurn(session, error)) return false;
  return isSupervisorConsolidationStallKill(error, session) && retriesSoFar < SUPERVISOR_CONSOLIDATION_STALL_MAX_RETRIES;
}

/**
 * DETERMINISTIC testable stall-retry wrapper for consolidation attempts. Retries once with
 * IDENTICAL inputs (the same frozen prompt, no hints) on STALL/timeout kill classes only;
 * INVALID/schema/contract/provenance always terminal; second failure rethrows. Preserves
 * structured diagnostics by forwarding the session when the attempt failure carries one.
 * Production `consolidateWithOperationSupervisor` uses the same classifier with fresh
 * generation re-materialization; this wrapper covers the identical-inputs fresh-turn
 * contract in isolation (No Paseo: stub `requestAttempt`).
 */
export async function withBoundedSupervisorConsolidationStallRetryV1<T>(input: {
  prompt: string;
  requestAttempt: (prompt: string) => Promise<T>;
  sessionOf?: (error: unknown) => SupervisorConsolidationStallSessionShape | undefined;
}): Promise<T> {
  const frozenPrompt = input.prompt;
  let retries = 0;
  for (;;) {
    try {
      return await input.requestAttempt(frozenPrompt);
    } catch (error) {
      const session = input.sessionOf?.(error);
      // UNCERTAIN turns never fresh-turn retry (twin-writer risk).
      if (isUncertainProviderTurn(session, error)) throw error;
      if (shouldRetrySupervisorConsolidationStall(error, retries, session)) {
        retries += 1;
        continue;
      }
      throw error;
    }
  }
}
interface SupervisorContextPolicy { handoffThreshold: number; hardHandoffThreshold: number; }
interface SupervisionConfigExtension { operations?: { supervision?: { initializationTimeoutSeconds?: number; turnTimeoutSeconds?: number; context?: { handoffThreshold?: number; hardHandoffThreshold?: number; }; }; }; }
const SUPERVISOR_INITIALIZATION_ATTEMPTS = 2;
// The readiness barrier (initialization and candidate-drift handoff) must fit a cold codex session:
// a 60 s barrier was marginal in real lanes (a completed handoff acknowledgment missed the window
// and failed the rotation). 120 s stays bounded and comfortably covers a cold session.
const DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS = 120;
const DEFAULT_SUPERVISOR_TURN_TIMEOUT_SECONDS = 300;

export function operationSupervisorContextPolicy(config: HarnessProjectConfig): SupervisorContextPolicy {
  const configured = (config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined)?.operations?.supervision?.context;
  const handoffThreshold = ratio(configured?.handoffThreshold, 0.75);
  return { handoffThreshold, hardHandoffThreshold: Math.max(handoffThreshold, ratio(configured?.hardHandoffThreshold, 0.85)) };
}
export function operationSupervisorInitializationTimeoutSeconds(config: HarnessProjectConfig): number {
  const value = (config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined)?.operations?.supervision?.initializationTimeoutSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS;
}
export function operationSupervisorTurnTimeoutSeconds(config: HarnessProjectConfig): number {
  const value = (config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined)?.operations?.supervision?.turnTimeoutSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), DEFAULT_SUPERVISOR_TURN_TIMEOUT_SECONDS) : DEFAULT_SUPERVISOR_TURN_TIMEOUT_SECONDS;
}
export function supervisorTurnTimedOutV1(session: Pick<WorkerSession, "exitCode" | "stdout" | "stderr">): boolean {
  return session.exitCode === 124 || /timed out|timeout|stalled_first_activity/i.test(`${session.stderr} ${session.stdout}`);
}

/** A provider lifecycle failure leaves a durable lease fenced; retrying with a new session
 * at the same controller epoch cannot make progress and must not create another actor. */
export function supervisorInitializationRetryBlockedByProviderLeaseV1(error: string): boolean {
  return /PASEO_PROVIDER_LIFECYCLE_UNCERTAIN|PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED/.test(error);
}

export async function ensureOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, options: EnsureSupervisorOptions = {}): Promise<OperationSupervisorHandle | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  return withOperationCoordinationLock(root, operationId, () => ensureOperationSupervisorUnlocked(root, config, contract, selection, operationId, options));
}

async function ensureOperationSupervisorUnlocked(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, operationId: string, options: EnsureSupervisorOptions): Promise<OperationSupervisorHandle | undefined> {
  const stateRoot = resolveOperationStateRoot(root);
  let operation = await loadOperation(stateRoot, operationId);
  const required = options.required ?? operation.supervision.required;
  if (!required && !options.forceMaterialize) return undefined;
  if (!selection) {
    if (required) throw new Error("AEH_OPERATION_SUPERVISOR_REQUIRED: no frozen operation-supervisor execution selection is available.");
    return undefined;
  }
  const active = activeOperationSupervisor(operation);
  if (active?.agentId) return { operationId, generation: active.generation, agentId: active.agentId, materialized: true, selection };

  let lastError: string | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= SUPERVISOR_INITIALIZATION_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    operation = await loadOperation(stateRoot, operationId);
    const initSelection = eventSelection(selection, contract, "initialize", operation.kind);
    const materialized = await materializeAgentPrompt(root, config, contract, initSelection, { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
    if (!materialized?.id) { lastError = "Paseo SDK did not materialize a persistent supervisor session"; break; }
    operation = await registerSupervisorGeneration(stateRoot, operationId, { agentId: materialized.id, materialized: true, status: "INITIALIZING", initializationAttempt: attempt });
    const generation = [...operation.supervision.generations].reverse().find((item) => item.agentId === materialized.id && item.status === "INITIALIZING")?.generation;
    if (!generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: materialized supervisor generation was not durably registered as INITIALIZING.");
    await recordPaseoTrace(stateRoot, "operation.supervisor.materialized", { operationId, generation, agentId: materialized.id, revision: operation.revision, attempt, status: "INITIALIZING" });
    try {
      operation = await updateSupervisorGeneration(stateRoot, operationId, generation, { initializationDispatchedAt: new Date().toISOString(), error: undefined });
      const session = await dispatchMaterializedAgentPrompt(root, config, contract, initSelection, materialized, initializationPrompt(operation, generation), { phase: "supervision", operationKind: operation.kind, supervisorAgent: true, providerTurnDeadlineMs: operationSupervisorInitializationTimeoutSeconds(config) * 1000 });
      if (session.exitCode !== 0 || !session.id) throw new Error(session.stderr || session.stdout || `exit ${session.exitCode}`);
      const completedAt = new Date().toISOString();
      const activated = await updateSupervisorGeneration(stateRoot, operationId, generation, { status: "ACTIVE", activatedAt: completedAt, initializationCompletedAt: completedAt, initializationEvidence: session.transport?.includes("paseo") ? "paseo-sdk-turn-barrier" : "turn-barrier", error: undefined });
      if (activated.supervision.activeGeneration !== generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: initialized supervisor did not become the active generation.");
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialized", { operationId, generation, agentId: session.id, revision: activated.revision, attempt, timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config), evidence: "turn-barrier" });
      return { operationId, generation, agentId: session.id, materialized: true, selection, session };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await updateSupervisorGeneration(stateRoot, operationId, generation, { status: "FAILED", error: `initialization failed: ${lastError}` }).catch(() => undefined);
      const providerLeaseFenced = supervisorInitializationRetryBlockedByProviderLeaseV1(lastError);
      // Keep an uncertain provider session untouched: archiving it could change the lifecycle
      // whose quiescence has not been established.
      if (!providerLeaseFenced) await archivePaseoSdkAgent(root, materialized.id).catch(() => undefined);
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialization-failed", { operationId, generation, agentId: materialized.id, attempt, error: lastError, timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config) }).catch(() => undefined);
      if (providerLeaseFenced) break;
    }
  }
  throw new Error(`AEH_OPERATION_SUPERVISOR_UNAVAILABLE: initialization failed after ${attempts} bounded attempt(s): ${lastError ?? "unknown error"}`);
}

export async function consolidateWithOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, supervisorSelection: AgentExecutionSelection | undefined, input: SupervisorConsolidationInput): Promise<SupervisorConsolidationResult> {
  const stateRoot = resolveOperationStateRoot(root);
  // Frozen finding-set for idempotent stall retry: the same sorted raw ids across attempts.
  // No artifact is persisted until success, so a stall retry with a fresh generation and the
  // same finding-set is idempotent; semantic content is never retried with hints (same inputs,
  // fresh turn).
  const rawIds = [...new Set(input.findings.map((finding) => finding.id))].sort();
  // Durable stall budget (fail-closed): without an operation context there is
  // no ledger key, so only the local budget applies. With a context, the
  // first attempt and each stall retry are spent upfront through a single
  // locked transact BEFORE acting; ledger failure throws with zero attempts.
  const consolidationOperationId = currentOperationContext().id;
  let stallRetries = 0;
  let firstAttempt = true;
  let stallSpendPending = false;
  let spentTotal = 0;
  for (;;) {
    let supervisor = await ensureOperationSupervisor(root, config, contract, supervisorSelection, { required: true, forceMaterialize: true });
    if (!supervisor?.agentId) throw new Error("AEH_OPERATION_SUPERVISOR_UNAVAILABLE: semantic consolidation requires a materialized supervisor session.");
    let operation = await loadOperation(stateRoot, supervisor.operationId);
    let provenance = await structuredResultProvenanceForAgent(stateRoot, supervisor.agentId).catch(() => undefined);
    // Safety net: the active generation's structured-result binding must belong to the current
    // candidate. If a rotation call site was missed, force one here instead of failing the
    // operation on a stale continuation (AEH-V2-0120).
    if (!supervisorGenerationCandidateCurrentV1(provenance, operation)) {
      const rotated = await maybeRotateOperationSupervisor(root, config, contract, supervisorSelection);
      if (!rotated?.agentId) throw new Error("AEH_OPERATION_SUPERVISOR_UNAVAILABLE: candidate-advanced supervisor generation could not be replaced for consolidation.");
      supervisor = rotated;
      operation = await loadOperation(stateRoot, rotated.operationId);
      provenance = await structuredResultProvenanceForAgent(stateRoot, rotated.agentId).catch(() => undefined);
    }
    const generation = activeOperationSupervisor(operation);
    const selection = eventSelection(supervisor.selection, contract, "consolidate", operation.kind);
    const prompt = consolidationPrompt(operation, input, generation?.checkpointArtifact);
    if (!provenance || provenance.status !== "BOUND" || !provenance.participantId) {
      throw new Error(`AEH_OPERATION_SUPERVISOR_BINDING: active supervisor session '${supervisor.agentId}' has no complete bound structured-result identity for a continuation event.`);
    }
    // Consolidation is a continuation turn on the supervisor's already-bound generation session:
    // the event prompt/context changes but the session binding (candidate, policy, blueprint, epoch,
    // participant generation, runtime session) must remain exactly the one materialized for the
    // generation. The activated structured-result turn and persisted consolidation artifact carry
    // the delivered event evidence.
    // Stall-retry diagnostics: the last turn session is hoisted so structured diagnostics
    // (exitCode/killReason/status/activityCounts) reach the stall classifier.
    let lastTurnSession: SupervisorConsolidationStallSessionShape | undefined;
    try {
      if (consolidationOperationId && (firstAttempt || stallSpendPending)) {
        spentTotal = await transactStallRetrySpend(stateRoot, consolidationOperationId, "consolidation");
        firstAttempt = false;
        stallSpendPending = false;
      }
      const turn = await withBoundedSupervisorConsolidationCorrectionV1({
        expectedFindingIds: rawIds,
        initialPrompt: prompt,
        provenanceCorrectionPrompt: (receivedIds) => supervisorConsolidationCorrectionPromptV1(input, rawIds, receivedIds),
        contractCorrectionPrompt: (failure) => supervisorConsolidationContractCorrectionPromptV1(input, rawIds, failure),
        onCorrection: async (detail) => { await recordPaseoTrace(stateRoot, "operation.supervisor.consolidation-correction", { operationId: supervisor.operationId, generation: supervisor.generation, agentId: supervisor.agentId, expectedFindingIds: rawIds, receivedFindingIds: detail.receivedIds ?? [], failure: detail.failure ?? null }).catch(() => undefined); },
        requestTurn: async (turnPrompt) => {
          const turnTimeoutSeconds = operationSupervisorTurnTimeoutSeconds(config);
          const turnSession = await executeAgentPrompt(root, config, contract, selection, turnPrompt, {
            outputContract: "supervisor",
            resumeSessionId: supervisor.agentId,
            phase: "consolidating",
            operationKind: operation.kind,
            supervisorAgent: true,
            requireExecutionAuthority: true,
            continueBoundSession: true,
            participantId: provenance.participantId,
            providerTurnDeadlineMs: turnTimeoutSeconds * 1000
          });
          lastTurnSession = turnSession;
          if (turnSession.exitCode !== 0) {
            const timedOut = supervisorTurnTimedOutV1(turnSession);
            if (timedOut) {
              await stopManagedPaseoAgent(root, supervisor.agentId!).catch(() => undefined);
              await updateSupervisorGeneration(stateRoot, supervisor.operationId, supervisor.generation, { status: "FAILED", error: `consolidation turn timed out after ${turnTimeoutSeconds}s; persistent session stopped` }).catch(() => undefined);
              await recordPaseoTrace(stateRoot, "operation.supervisor.turn-timeout", { operationId: supervisor.operationId, generation: supervisor.generation, agentId: supervisor.agentId, timeoutSeconds: turnTimeoutSeconds, outcome: "FAILED_CLOSED_SESSION_STOPPED", exitCode: turnSession.exitCode, killReason: (turnSession as { killReason?: unknown }).killReason ?? null, status: (turnSession as { status?: unknown }).status ?? null, activityCounts: (turnSession as { activityCounts?: unknown }).activityCounts ?? null }).catch(() => undefined);
              throw new Error(`AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT: consolidation turn exceeded ${turnTimeoutSeconds}s; session stopped and generation failed closed`);
            }
            throw new Error(`AEH_OPERATION_SUPERVISOR_FAILED: supervisor exited with ${turnSession.exitCode}: ${turnSession.stderr || turnSession.stdout}`);
          }
          try {
            return { session: turnSession, output: supervisorOutputSchema.parse(extractMarkedJson(turnSession.stdout, turnSession.stderr)) };
          } catch (error) {
            return { session: turnSession, failure: String(error) };
          }
        }
      });
      const artifact = await persistOperationConsolidation(stateRoot, supervisor.operationId, input.key, {
        generation: supervisor.generation,
        sourceArtifacts: input.sourceArtifacts ?? [],
        rawFindingIds: rawIds,
        output: turn.output,
        deliveredTurn: {
          sessionId: supervisor.agentId,
          participantId: provenance.participantId,
          event: "consolidate",
          promptDigest: sha256Utf8(turn.prompt),
          bindingDigest: provenance.executionBinding?.digest ?? provenance.provenanceDigest
        }
      });
      const current = await loadOperation(stateRoot, supervisor.operationId);
      await patchOperation(stateRoot, supervisor.operationId, { supervision: { ...current.supervision, latestConsolidationRevision: current.revision + 1, latestConsolidationArtifact: artifact } });
      return { output: turn.output, artifact, session: turn.session };
    } catch (error) {
      // Bounded fresh-generation identical-inputs retry for STALL/timeout kill classes ONLY.
      // The failed generation was already stopped and marked FAILED closed; the retry
      // re-materializes a fresh generation with the same frozen finding-set and same inputs.
      // UNCERTAIN first: the turn's stop is unverified (may still be RUNNING),
      // so no fresh generation ever — same-session resume or fail-closed error.
      // INVALID/schema/contract/provenance always terminal; second failure rethrows original.
      if (isUncertainProviderTurn(lastTurnSession, error)) {
        throw new Error(`PASEO_PROVIDER_LIFECYCLE_UNCERTAIN: consolidation turn stop unverified for session '${(lastTurnSession as { id?: unknown } | undefined)?.id ?? supervisor.agentId ?? "unknown-session"}'; same-session resume is required, fresh-generation retry refused (twin-writer risk). ${String(error instanceof Error ? error.message : error)}`);
      }
      if (isSupervisorConsolidationStallKill(error, lastTurnSession) && stallRetries < SUPERVISOR_CONSOLIDATION_STALL_MAX_RETRIES && (spentTotal < STALL_RETRY_MAX_ATTEMPTS_PER_PHASE || !consolidationOperationId)) {
        stallRetries += 1;
        stallSpendPending = true;
        await recordPaseoTrace(stateRoot, "operation.supervisor.consolidation-stall-retry", { operationId: supervisor.operationId, generation: supervisor.generation, agentId: supervisor.agentId, attempt: stallRetries, maxAttempts: SUPERVISOR_CONSOLIDATION_STALL_MAX_ATTEMPTS, expectedFindingIds: rawIds }).catch(() => undefined);
        continue;
      }
      throw error;
    }
  }
}

export async function maybeRotateOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined): Promise<OperationSupervisorHandle | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  return withOperationCoordinationLock(root, operationId, () => maybeRotateOperationSupervisorUnlocked(root, config, contract, selection, operationId));
}

async function maybeRotateOperationSupervisorUnlocked(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, operationId: string): Promise<OperationSupervisorHandle | undefined> {
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId);
  const active = activeOperationSupervisor(operation);
  if (!active?.agentId) return ensureOperationSupervisorUnlocked(root, config, contract, selection, operationId, { required: operation.supervision.required });
  if (!selection) {
    if (operation.supervision.required) throw new Error("AEH_OPERATION_SUPERVISOR_REQUIRED: no frozen operation-supervisor execution selection is available.");
    return undefined;
  }
  const context = await statusLeadContext(root, config, active.agentId);
  const policy = operationSupervisorContextPolicy(config);
  const usageRatio = context.usage.ratio;
  // A supervisor generation's structured-result channel is bound to the candidate digest it was
  // materialized under. Once the operation candidate advances, the generation can no longer deliver
  // consolidation turns (`AEH_RESULT_STALE_CANDIDATE`) and must be replaced by a fresh generation
  // bound to the current candidate (AEH-V2-0120).
  const activeProvenance = await structuredResultProvenanceForAgent(stateRoot, active.agentId).catch(() => undefined);
  // Candidate binding deliberately clears the frozen policy until the next blueprint/assurance
  // compile re-binds it for the new candidate. A replacement generation cannot be materialized
  // before that policy exists, so drift rotation is deferred to the next call site.
  const policyCurrent = Boolean(
    operation.resolvedOperationPolicy && operation.candidateRevision
    && operation.resolvedOperationPolicy.candidateDigest === operation.candidateRevision.identityDigest
    && operation.resolvedOperationPolicy.operationExecutionRevision === operation.operationExecutionRevision
  );
  const candidateDrift = policyCurrent && !supervisorGenerationCandidateCurrentV1(activeProvenance, operation);
  const rotate = candidateDrift || (usageRatio !== undefined ? usageRatio >= policy.handoffThreshold : context.state === "HANDOFF_REQUIRED" || context.state === "HARD_HANDOFF");
  if (!rotate) {
    if (usageRatio !== undefined) await updateSupervisorGeneration(stateRoot, operationId, active.generation, { contextRatio: usageRatio, error: undefined });
    return { operationId, generation: active.generation, agentId: active.agentId, materialized: true, selection };
  }
  const checkpointArtifact = await persistSupervisorCheckpoint(stateRoot, operationId, active.generation, buildSupervisorCheckpoint(operation, usageRatio));
  await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "DRAINING", drainingAt: new Date().toISOString(), checkpointArtifact, contextRatio: usageRatio, error: undefined });
  const handoffSelection = eventSelection(selection, contract, "handoff", operation.kind);
  // The replacement readiness barrier is provider-flaky at the turn boundary: a real lane observed
  // a completed handoff acknowledgment whose turn never reported completion, failing the rotation.
  // Like the initial supervisor materialization, the rotation gets a bounded retry with a fresh
  // session; semantic consolidation turns are never retried.
  let lastRotationError: string | undefined;
  for (let attempt = 1; attempt <= SUPERVISOR_INITIALIZATION_ATTEMPTS; attempt += 1) {
    const latest = await loadOperation(stateRoot, operationId);
    const materialized = await materializeAgentPrompt(root, config, contract, handoffSelection, { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
    if (!materialized?.id) {
      lastRotationError = "Paseo SDK did not materialize the replacement supervisor.";
      if (attempt < SUPERVISOR_INITIALIZATION_ATTEMPTS) continue;
      await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "ACTIVE", drainingAt: undefined, error: "replacement materialization failed" });
      throw new Error("AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: Paseo SDK did not materialize the replacement supervisor.");
    }
    const registered = await registerSupervisorGeneration(stateRoot, operationId, { agentId: materialized.id, materialized: true, checkpointArtifact, status: "INITIALIZING", initializationAttempt: attempt });
    const replacementGeneration = [...registered.supervision.generations].reverse().find((item) => item.agentId === materialized.id && item.status === "INITIALIZING")?.generation;
    if (!replacementGeneration) throw new Error("AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: replacement generation was not durably registered as INITIALIZING.");
    await recordPaseoTrace(stateRoot, "operation.supervisor.materialized", { operationId, generation: replacementGeneration, agentId: materialized.id, revision: registered.revision, replacementFor: active.generation, status: "INITIALIZING", attempt });
    try {
      await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { initializationDispatchedAt: new Date().toISOString(), error: undefined });
      const session = await dispatchMaterializedAgentPrompt(root, config, contract, handoffSelection, materialized, handoffPrompt(latest, replacementGeneration, checkpointArtifact), { phase: "supervision", operationKind: operation.kind, supervisorAgent: true, providerTurnDeadlineMs: operationSupervisorInitializationTimeoutSeconds(config) * 1000 });
      if (session.exitCode !== 0 || !session.id) throw new Error(session.stderr || session.stdout || `exit ${session.exitCode}`);
      const completedAt = new Date().toISOString();
      const activated = await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { status: "ACTIVE", activatedAt: completedAt, initializationCompletedAt: completedAt, initializationEvidence: "paseo-sdk-turn-barrier", error: undefined });
      if (activated.supervision.activeGeneration !== replacementGeneration) throw new Error("replacement supervisor did not become active after initialization");
      await recordPaseoTrace(stateRoot, "operation.supervisor.rotated", { operationId, reason: candidateDrift ? "candidate-advanced" : "context-pressure", fromGeneration: active.generation, fromAgentId: active.agentId, toGeneration: replacementGeneration, toAgentId: session.id, contextRatio: usageRatio ?? -1, handoffThreshold: policy.handoffThreshold, hardHandoffThreshold: policy.hardHandoffThreshold, checkpointArtifact, attempt });
      return { operationId, generation: replacementGeneration, agentId: session.id, materialized: true, selection, session };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastRotationError = message;
      await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { status: "FAILED", error: `replacement initialization failed: ${message}` }).catch(() => undefined);
      await archivePaseoSdkAgent(root, materialized.id).catch(() => undefined);
      await recordPaseoTrace(stateRoot, "operation.supervisor.rotation-attempt-failed", { operationId, generation: replacementGeneration, agentId: materialized.id, attempt, error: message }).catch(() => undefined);
    }
  }
  await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "ACTIVE", drainingAt: undefined, error: `replacement initialization failed: ${lastRotationError}` });
  throw new Error(`AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: ${lastRotationError ?? "unknown"}`);
}

export async function settleDrainingSupervisorGenerations(root: string, operationId: string): Promise<OperationRecordV2> {
  return withOperationCoordinationLock(root, operationId, () => settleDrainingSupervisorGenerationsUnlocked(root, operationId));
}

async function settleDrainingSupervisorGenerationsUnlocked(root: string, operationId: string): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root);
  let record = await loadOperation(stateRoot, operationId);
  for (const generation of record.supervision.generations.filter((item) => item.status === "DRAINING")) {
    const unsettled = Object.values(record.participants).some((participant) => participant.parentSupervisorGeneration === generation.generation && !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status));
    if (unsettled) continue;
    if (generation.agentId) {
      try { await archivePaseoSdkAgent(root, generation.agentId); await recordPaseoTrace(stateRoot, "operation.supervisor.archived", { operationId, generation: generation.generation, agentId: generation.agentId }); }
      catch (error) { record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, { error: error instanceof Error ? error.message : String(error) }); await recordPaseoTrace(stateRoot, "operation.supervisor.archive-failed", { operationId, generation: generation.generation, agentId: generation.agentId, error: error instanceof Error ? error.message : String(error) }); continue; }
    }
    record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, { status: "ARCHIVED", archivedAt: new Date().toISOString(), error: undefined });
  }
  return record;
}

function initializationPrompt(operation: OperationRecordV2, generation: number): string {
  return ["[AEH_SUPERVISOR_INITIALIZE]", `State: ${JSON.stringify(supervisorInitializationProjection(operation, generation))}`, "No semantic work is requested on this turn. This is only the bounded session-readiness turn barrier.", "Acknowledge initialization compactly and become idle."].join("\n\n");
}
export function handoffPrompt(operation: OperationRecordV2, generation: number, checkpointArtifact: string): string {
  // The rotation turn is a session-readiness barrier with a bounded timeout. It must not invite
  // file reads or commands: a real candidate-drift rotation exceeded the 60 s barrier because the
  // model started inspecting the durable checkpoint instead of acknowledging the inline state
  // projection (formal lane r16-formal-1). The checkpoint remains continuity authority for later
  // consolidation turns.
  return ["[AEH_SUPERVISOR_HANDOFF]", `State: ${JSON.stringify(supervisorHandoffProjection(operation, generation, checkpointArtifact))}`, "This is a session-readiness turn barrier: do not read files, run commands, or perform semantic work on this turn. The durable checkpoint plus OperationRecord are continuity authority for later turns instead of transcript replay.", "Acknowledge the handoff compactly and become idle."].join("\n\n");
}
function consolidationPrompt(operation: OperationRecordV2, input: SupervisorConsolidationInput, checkpointArtifact?: string): string {
  return ["[AEH_SUPERVISOR_CONSOLIDATE]", `Purpose: ${input.purpose}`, `State: ${JSON.stringify(supervisorConsolidationProjection(operation))}`, checkpointArtifact ? `Continuity checkpoint: ${checkpointArtifact}` : undefined, `Source artifacts: ${JSON.stringify(input.sourceArtifacts ?? [])}`, `Deterministic evidence digest: ${JSON.stringify(compactDeterministicEvidence(input.deterministicEvidence ?? null))}`, `Raw findings: ${JSON.stringify(input.findings)}`, "Consolidate using the frozen semantic protocol. Preserve the exact source finding set, surface conflicts and missing evidence, and preserve deterministic validation outcomes.", operation.kind === "audit" ? "Include a compact prioritized roadmap derived only from the consolidated findings." : undefined].filter(Boolean).join("\n\n");
}
function eventSelection(selection: AgentExecutionSelection, contract: TaskContract, event: SupervisorSemanticEvent, operationKind?: string): AgentExecutionSelection {
  return { ...selection, skills: supervisorEventSkills(event, operationKind, hasTraceableAcceptance(contract)) };
}
function buildSupervisorCheckpoint(operation: OperationRecordV2, contextRatio?: number): Record<string, unknown> {
  return { ...supervisorCheckpointProjection(operation, contextRatio), instruction: "Resume semantic supervision from this durable checkpoint and OperationRecord without transcript replay." };
}
function ratio(value: number | undefined, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback; }
