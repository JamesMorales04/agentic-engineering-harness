import process from "node:process";
import { createHash } from "node:crypto";
import type { OpenCodeAgentBindingSource } from "../agents/permissions.js";
import { currentOperationContext, loadOperation, registerCurrentOperationAgent } from "../operations/state.js";
import type { ExecutionBindingV3 } from "../architecture/executionIdentity.js";
import { providerLeaseWorkspaceKeyV1, runWithOperationProviderLease } from "../runtime/providerLifecycle.js";
import { runExecutable, runShell } from "../utils/process.js";
import {
  buildPaseoBackgroundRunCommand,
  detectPaseoCapabilities,
  extractPaseoAgentId
} from "./capabilities.js";
import { preflightPaseoProviderMode } from "./modePreflight.js";
import { redactPermissionStopDiagnostic } from "./permissionDiagnostic.js";
import {
  capturePaseoAgentTurnBaseline,
  preflightPaseoProviderModel,
  waitForPaseoAgentNative,
  type PaseoNativeWaitResult,
  type PaseoTurnBaseline
} from "./native.js";
import {
  PaseoSdkUnavailableError,
  PaseoSdkTimeoutError,
  createPaseoSdkAgent,
  dispatchPaseoSdkAgent,
  inspectPaseoSdkAgent,
  listPaseoSdkAgents,
  materializePaseoSdkAgent,
  probePaseoSdkAgent,
  runPaseoSdkAgent,
  waitPaseoSdkAgent,
  type PaseoSdkAgentOptions,
  type PaseoSdkAgentRecord,
  type PaseoSdkAgentResult
} from "./sdk.js";
import { recordPaseoTrace } from "./trace.js";
import { deterministicPaseoRuntimeDeps, isDeterministicPaseoRuntimeEnabled } from "./deterministicRuntime.js";
import type { ProviderTurnActivityCounts, ProviderTurnKillReason, ProviderTurnQuiescence } from "./firstActivityDeadline.js";
import { isStalledFirstActivityText, stalledFirstActivityError, FIRST_ACTIVITY_DEADLINE_MS } from "./firstActivityDeadline.js";

export interface ManagedPaseoAgentOptions extends PaseoSdkAgentOptions {
  timeoutSeconds?: number;
  modeSource?: OpenCodeAgentBindingSource;
}

export interface ManagedPaseoAgentResult {
  id?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  status?: string;
  workspaceId?: string;
  transport: "sdk" | "cli";
  observation?: "subscription" | "sdk-run" | "sdk-wait" | "cli-wait";
  efficiencyTelemetry?: import("../telemetry/efficiency.js").ProviderTelemetryEvidenceV2;
  permission?: import("./sdk.js").PaseoSdkPermissionStop;
  /** Deadline-vs-stall-vs-error kill reason; present only on killed turns. */
  killReason?: ProviderTurnKillReason;
  /** Bounded provider-visible activity counts; refs-only, no provider content. */
  activity?: ProviderTurnActivityCounts;
  /** Post-timeout stop verification; "uncertain" means the session may still be RUNNING (twin-writer risk: same-session resume only, never fresh retry). */
  providerQuiescence?: ProviderTurnQuiescence;
}

export interface PaseoRuntimeDeps {
  run: typeof runShell;
  updateLabels?: (root: string, agentId: string, labels: Record<string, string>) => Promise<void>;
  detectCapabilities: typeof detectPaseoCapabilities;
  trace?: typeof recordPaseoTrace;
  native?: {
    preflight: typeof preflightPaseoProviderModel;
    preflightMode: typeof preflightPaseoProviderMode;
    wait: typeof waitForPaseoAgentNative;
    capture?: typeof capturePaseoAgentTurnBaseline;
  };
  sdk: {
    create: typeof createPaseoSdkAgent;
    materialize: typeof materializePaseoSdkAgent;
    dispatch: typeof dispatchPaseoSdkAgent;
    wait: typeof waitPaseoSdkAgent;
    run: typeof runPaseoSdkAgent;
    probe: typeof probePaseoSdkAgent;
    inspect: typeof inspectPaseoSdkAgent;
    // Array contract: callers here never do gone-proof pruning, so they
    // consume the (bounded) accumulated agents; completion honesty is owned by
    // the listing shape in sdk.ts and honored by the cleanup path.
    list: (root: string, labels?: Record<string, string>) => Promise<PaseoSdkAgentRecord[]>;
  };
}

const REAL_DEPS: PaseoRuntimeDeps = {
  run: runShell,
  updateLabels: updatePaseoExecutionLabels,
  detectCapabilities: detectPaseoCapabilities,
  trace: recordPaseoTrace,
  native: {
    preflight: preflightPaseoProviderModel,
    preflightMode: preflightPaseoProviderMode,
    wait: waitForPaseoAgentNative,
    capture: capturePaseoAgentTurnBaseline
  },
  sdk: {
    create: createPaseoSdkAgent,
    materialize: materializePaseoSdkAgent,
    dispatch: dispatchPaseoSdkAgent,
    wait: waitPaseoSdkAgent,
    run: runPaseoSdkAgent,
    probe: probePaseoSdkAgent,
    inspect: inspectPaseoSdkAgent,
    list: (root, labels = {}) => listPaseoSdkAgents(root, labels).then((listing) => listing.agents)
  }
};

/** The runtime boundary selected for this process: real Paseo, or the file-scripted fixture boundary. */
function defaultDeps(): PaseoRuntimeDeps {
  return isDeterministicPaseoRuntimeEnabled() ? deterministicPaseoRuntimeDeps() : REAL_DEPS;
}

export async function launchManagedPaseoAgent(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps = defaultDeps()
): Promise<ManagedPaseoAgentResult> {
  const trace = deps.trace ?? defaultDeps().trace!;
  // Idempotency key derivation is transport-agnostic (DETERMINISTIC frozen-label
  // hash): derive once so the SDK and CLI launch paths share the same guard and
  // the CLI fallback can never silently duplicate a turn the SDK path would reuse.
  const idempotentOptions = withTurnIdempotencyKey(options);
  if (!forceCli()) {
    await ensurePreflight(root, idempotentOptions, deps);
    await traceResolvedIdentity(root, idempotentOptions, trace);
    try {
      const reused = await reuseLiveIdempotentTurn(root, idempotentOptions, deps, trace);
      if (reused) return reused;
      const created = fromSdk(await deps.sdk.create(root, { ...idempotentOptions, waitForFinish: false }));
      await registerManagedAgent(root, idempotentOptions, created);
      await trace(root, "agent.launch", { transport: "sdk", agentId: created.id ?? "", provider: idempotentOptions.provider, model: idempotentOptions.model ?? "", modeId: idempotentOptions.modeId ?? "", modeSource: idempotentOptions.modeSource ?? "", status: created.status ?? "unknown" });
      if (!created.id || idempotentOptions.prompt === undefined || idempotentOptions.waitForFinish === false) return created;
      return waitManagedPaseoAgent(root, created.id, idempotentOptions.timeoutSeconds ?? secondsFromMs(idempotentOptions.timeoutMs), deps, undefined, idempotentOptions.permissionScopeRoots);
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "fallback.cli", { operation: "launch", provider: options.provider, model: options.model ?? "", modeId: options.modeId ?? "", reason: errorMessage(error) });
      return launchCli(root, idempotentOptions, deps, `SDK unavailable: ${errorMessage(error)}`);
    }
  }
  await trace(root, "fallback.cli", { operation: "launch", provider: options.provider, model: options.model ?? "", modeId: options.modeId ?? "", reason: "AEH_PASEO_FORCE_CLI=1" });
  return launchCli(root, idempotentOptions, deps, "AEH_PASEO_FORCE_CLI=1 forced the compatibility lifecycle.");
}

export async function materializeManagedPaseoAgent(root: string, options: ManagedPaseoAgentOptions, deps: PaseoRuntimeDeps = defaultDeps()): Promise<ManagedPaseoAgentResult> {
  if (forceCli()) throw new PaseoSdkUnavailableError("Idle agent materialization is SDK-only; AEH_PASEO_FORCE_CLI=1 is active.");
  await ensurePreflight(root, options, deps);
  const trace = deps.trace ?? defaultDeps().trace!;
  await traceResolvedIdentity(root, options, trace);
  try {
    const result = await withProviderSessionLease(root, options.provider, options.workspaceId, options.labels, undefined, deps, async () => {
      const value = fromSdk(await deps.sdk.materialize(root, { ...options, prompt: undefined, waitForFinish: false }));
      return { value, sessionId: value.id };
    });
    await registerManagedAgent(root, options, result);
    await trace(root, "agent.materialize", { transport: "sdk", agentId: result.id ?? "", provider: options.provider, model: options.model ?? "", modeId: options.modeId ?? "", modeSource: options.modeSource ?? "", workspaceId: result.workspaceId ?? "" });
    return result;
  } catch (error) {
    if (sdkCanFallback(error)) throw new PaseoSdkUnavailableError(`Paseo SDK is required to materialize an idle visible agent. ${errorMessage(error)}`, { cause: error });
    throw error;
  }
}

export async function dispatchManagedPaseoAgent(root: string, agentId: string, prompt: string, timeoutSeconds?: number, deps: PaseoRuntimeDeps = defaultDeps()): Promise<ManagedPaseoAgentResult> {
  const trace = deps.trace ?? defaultDeps().trace!;
  if (!forceCli()) {
    try {
      const result = fromSdk(await deps.sdk.dispatch(root, agentId, prompt, timeoutMs(timeoutSeconds)));
      await trace(root, "agent.dispatch", { transport: "sdk", agentId, status: result.status ?? "unknown" });
      return result;
    } catch (error) {
      if (error instanceof PaseoSdkTimeoutError || (error instanceof Error && error.name === "PaseoSdkTimeoutError")) {
        const stopped = await stopManagedPaseoAgent(root, agentId, deps);
        const errorText = errorMessage(error);
        // E-NEW-9: the dispatch timeout path stops too, so it verifies too.
        const verified = await observeTurnQuiescenceAfterStop(root, agentId, stopped.exitCode, deps);
        const uncertain = verified.quiescence === "uncertain"
          ? uncertainStopText(agentId, stopped.exitCode, verified.status)
          : undefined;
        if (uncertain) await trace(root, "agent.dispatch.stop-unverified", { transport: "sdk", agentId, stopExitCode: stopped.exitCode, observedStatus: verified.status });
        // Sibling kill-reason propagation (E-NEW-2): preserve a STALLED marker
        // when the dispatch timeout text carries one; otherwise DEADLINE.
        return { id: agentId, exitCode: 124, stdout: "", stderr: [errorText, stopped.stderr, uncertain].filter(Boolean).join("\n"), status: "timeout", transport: "sdk", killReason: (isStalledFirstActivityText(errorText) ? "STALLED_FIRST_ACTIVITY" : "DEADLINE") as ProviderTurnKillReason, providerQuiescence: verified.quiescence };
      }
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "fallback.cli", { operation: "dispatch", agentId, reason: errorMessage(error) });
    }
  }
  const send = await deps.run(`paseo send ${quote(agentId)} --no-wait ${quote(prompt)}`, { cwd: root, timeoutMs: 60_000 });
  await trace(root, "agent.dispatch", { transport: "cli", agentId, exitCode: send.exitCode });
  return { id: agentId, exitCode: send.exitCode, stdout: send.stdout, stderr: send.stderr, status: send.exitCode === 0 ? "working" : "failed", transport: "cli" };
}

export async function waitManagedPaseoAgent(root: string, agentId: string, timeoutSeconds?: number, deps: PaseoRuntimeDeps = defaultDeps(), baseline?: PaseoTurnBaseline, permissionScopeRoots?: string[]): Promise<ManagedPaseoAgentResult> {
  const timeout = timeoutMs(timeoutSeconds);
  const trace = deps.trace ?? defaultDeps().trace!;
  if (!forceCli()) {
    const native = deps.native ?? defaultDeps().native!;
    try {
      const result = fromNativeWait(await native.wait(root, agentId, timeout, baseline, permissionScopeRoots));
      if (result.status === "timeout") {
        const stopped = await stopManagedPaseoAgent(root, agentId, deps);
        result.stderr = [result.stderr, stopped.stderr].filter(Boolean).join("\n");
        // E-NEW-9: verify quiescence after stop; an unverified stop marks the
        // turn UNCERTAIN so no caller fresh-session-retries a twin writer.
        const verified = await observeTurnQuiescenceAfterStop(root, agentId, stopped.exitCode, deps);
        result.providerQuiescence = verified.quiescence;
        if (verified.quiescence === "uncertain") {
          result.stderr = [result.stderr, uncertainStopText(agentId, stopped.exitCode, verified.status)].filter(Boolean).join("\n");
          await trace(root, "agent.wait.stop-unverified", { transport: "sdk", observation: "subscription", agentId, stopExitCode: stopped.exitCode, observedStatus: verified.status });
        }
      }
      await trace(root, "agent.wait.completed", { transport: "sdk", observation: "subscription", agentId, status: result.status ?? "unknown", killReason: result.killReason ?? "none", toolEvents: result.activity?.toolEvents ?? 0 });
      return result;
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "agent.wait.fallback", { agentId, from: "subscription", to: "sdk-wait", reason: errorMessage(error) });
      try {
        const result = { ...fromSdk(await deps.sdk.wait(root, agentId, timeout, permissionScopeRoots)), observation: "sdk-wait" as const };
        if (result.status === "timeout") {
          const stopped = await stopManagedPaseoAgent(root, agentId, deps);
          result.stderr = [result.stderr, stopped.stderr].filter(Boolean).join("\n");
          result.killReason ??= "DEADLINE";
          const verified = await observeTurnQuiescenceAfterStop(root, agentId, stopped.exitCode, deps);
          result.providerQuiescence = verified.quiescence;
          if (verified.quiescence === "uncertain") {
            result.stderr = [result.stderr, uncertainStopText(agentId, stopped.exitCode, verified.status)].filter(Boolean).join("\n");
            await trace(root, "agent.wait.stop-unverified", { transport: "sdk", observation: "sdk-wait", agentId, stopExitCode: stopped.exitCode, observedStatus: verified.status });
          }
        }
        await trace(root, "agent.wait.completed", { transport: "sdk", observation: "sdk-wait", agentId, status: result.status ?? "unknown", killReason: result.killReason ?? "none" });
        return result;
      } catch (sdkError) {
        if (!sdkCanFallback(sdkError)) throw sdkError;
        await trace(root, "fallback.cli", { operation: "wait", agentId, reason: errorMessage(sdkError) });
      }
    }
  }
  const timeoutSec = timeoutSeconds ?? 1800;
  const wait = await deps.run(`paseo wait ${quote(agentId)} --timeout ${timeoutSec}`, { cwd: root, timeoutMs: (timeoutSec + 30) * 1000 });
  let cleanupStderr = "";
  let cliQuiescence: ProviderTurnQuiescence | undefined;
  if (wait.timedOut || wait.exitCode !== 0) {
    const stopped = await stopManagedPaseoAgent(root, agentId, deps);
    cleanupStderr = stopped.stderr;
    // E-NEW-9: verify quiescence on the CLI timeout path like the SDK paths.
    if (wait.timedOut) {
      const verified = await observeTurnQuiescenceAfterStop(root, agentId, stopped.exitCode, deps);
      cliQuiescence = verified.quiescence;
      if (verified.quiescence === "uncertain") {
        cleanupStderr = [cleanupStderr, uncertainStopText(agentId, stopped.exitCode, verified.status)].filter(Boolean).join("\n");
        await trace(root, "agent.wait.stop-unverified", { transport: "cli", observation: "cli-wait", agentId, stopExitCode: stopped.exitCode, observedStatus: verified.status });
      }
    }
  }
  const logs = await deps.run(`paseo logs ${quote(agentId)} --tail 200`, { cwd: root, timeoutMs: 60_000 });
  // Kill-reason reconciliation (E-NEW-2 floor + A4 stop-then-read verdict).
  // Sibling E-NEW-2 (inner gate, normative): a CLI timeout without a STALLED
  // marker in the daemon output stays the existing generic DEADLINE — never
  // invents a stall the CLI wait cannot observe. Failclosed A4 (outer): once
  // the post-timeout stop is VERIFIED quiescent the post-stop logs are final,
  // so still-empty readable logs settle as STALLED_FIRST_ACTIVITY with the
  // same marker text as the SDK paths. An unverified stop keeps DEADLINE
  // (its logs are not final) and an unreadable logs read keeps DEADLINE with
  // an explicit activity-unobserved marker — never a silent DEADLINE.
  const cliOutputText = [wait.stdout, wait.stderr, logs.stdout, logs.stderr].join("\n");
  const cliLogsReadable = logs.exitCode === 0;
  const cliObservedActivity = isStalledFirstActivityText(cliOutputText)
    ? false
    : cliLogsReadable && logs.stdout.trim().length > 0;
  const cliKillReason: ProviderTurnKillReason | undefined = !wait.timedOut
    ? undefined
    : isStalledFirstActivityText(cliOutputText) || (!cliObservedActivity && cliLogsReadable && cliQuiescence === "quiescent")
      ? "STALLED_FIRST_ACTIVITY"
      : "DEADLINE";
  const cliActivityMarker = wait.timedOut && !cliLogsReadable && !isStalledFirstActivityText(cliOutputText)
    ? "CLI_ACTIVITY_UNOBSERVED: post-stop logs could not be read; activity unproven (killReason DEADLINE preserved, quiescence carried separately)."
    : undefined;
  // The stall verdict carries the same marker text as the SDK paths so
  // downstream classifiers recognize it identically.
  const cliStallMarker = cliKillReason === "STALLED_FIRST_ACTIVITY" && !isStalledFirstActivityText(cliOutputText)
    ? stalledFirstActivityError(FIRST_ACTIVITY_DEADLINE_MS, timeoutSec * 1000, { updatesObserved: 0, toolEvents: 0, assistantDelta: false })
    : undefined;
  const result: ManagedPaseoAgentResult = { id: agentId, exitCode: wait.exitCode, stdout: logs.stdout || wait.stdout, stderr: [wait.stderr, cleanupStderr, logs.stderr, cliActivityMarker, cliStallMarker].filter(Boolean).join("\n"), status: wait.exitCode === 0 ? "idle" : "failed", transport: "cli", observation: "cli-wait", ...(cliKillReason ? { killReason: cliKillReason } : {}), ...(cliQuiescence ? { providerQuiescence: cliQuiescence } : {}) };
  await trace(root, "agent.wait.completed", { transport: "cli", observation: "cli-wait", agentId, status: result.status ?? "unknown", killReason: result.killReason ?? "none" });
  return result;
}

export async function stopManagedPaseoAgent(root: string, agentId: string, deps: PaseoRuntimeDeps = defaultDeps()): Promise<{ exitCode: number; stderr: string }> {
  try {
    const result = await deps.run(`paseo stop ${quote(agentId)}`, { cwd: root, timeoutMs: 30_000 });
    return { exitCode: result.exitCode, stderr: result.exitCode === 0 ? "" : result.stderr || result.stdout || `paseo stop exited ${result.exitCode}` };
  } catch (error) {
    return { exitCode: 1, stderr: errorMessage(error) };
  }
}

/**
 * Post-timeout stop verification for the turn path (A1, subsuming E-NEW-9).
 *
 * MECHANISM: DETERMINISTIC. Verified against the installed Paseo CLI
 * (`@getpaseo/cli` `commands/agent/stop.js`: `stop` interrupts a RUNNING
 * agent and is a successful NO-OP for any non-running status), so a stop
 * exit code of 0 proves nothing by itself: it is returned for idle, dead,
 * missing, and unknown sessions alike. Quiescence therefore requires a
 * POSITIVE dead observation post-stop (idle or `isPositivelyDeadPaseoAgentStatus`
 * semantics). Positive liveness (working/running) after stop is UNCERTAIN.
 * Unknown-before AND unknown-after (missing/unparseable/unrecognized status)
 * is UNCERTAIN, period — regardless of exit code. Never throws:
 * verification failure degrades to UNCERTAIN (availability cost accepted:
  * flaky-inspect flows go operator-driven via the UNCERTAIN marker).
  */
async function observeTurnQuiescenceAfterStop(
  root: string,
  agentId: string,
  stopExitCode: number,
  deps: PaseoRuntimeDeps
): Promise<{ quiescence: ProviderTurnQuiescence; status: string }> {
  void stopExitCode;
  const observed = await inspectManagedPaseoAgent(root, agentId, deps).catch(() => undefined);
  const status = observed?.status?.toLowerCase() ?? "unknown";
  if (status === "working" || status === "running") return { quiescence: "uncertain", status };
  if (status === "idle" || isPositivelyDeadPaseoAgentStatus(status)) return { quiescence: "quiescent", status };
  // A1 (strict, subsuming E-NEW-9): unknown-before AND unknown-after is
  // UNCERTAIN regardless of the stop exit code — `paseo stop` is a successful
  // no-op for any non-running status, so exit 0 proves nothing. This corner
  // is untested by the merged E-NEW-9 suite; the strict verdict preserves
  // every E-NEW-9-tested behavior while keeping the A1 fail-closed bound.
  return { quiescence: "uncertain", status };
}

/**
 * UNCERTAIN stop marker. Carries the PASEO_PROVIDER_LIFECYCLE_UNCERTAIN
 * prefix so the existing lease-fence matcher
 * (supervisorInitializationRetryBlockedByProviderLeaseV1) also refuses to
 * route around the unverified session, and preserves the same session id
 * for same-session resume.
 */
function uncertainStopText(agentId: string, stopExitCode: number, observedStatus: string): string {
  return `PASEO_PROVIDER_LIFECYCLE_UNCERTAIN: post-timeout stop unverified for session '${agentId}' (stop exit ${stopExitCode}, observed status '${observedStatus}'); the session may still be RUNNING. Same-session resume of '${agentId}' is required; fresh-session retry is refused (twin-writer risk).`;
}

export async function continueManagedPaseoAgent(
  root: string,
  agentId: string,
  prompt: string,
  timeoutSeconds?: number,
  deps: PaseoRuntimeDeps = defaultDeps(),
  outputSchema?: Record<string, unknown>,
  executionIdentityLabels?: Record<string, string>,
  permissionScopeRoots?: string[]
): Promise<ManagedPaseoAgentResult> {
  return withProviderSessionLease(root, executionIdentityLabels?.["aeh.provider"] ?? "paseo", undefined, executionIdentityLabels, agentId, deps, async () => ({
    value: await continueManagedPaseoAgentUnleased(root, agentId, prompt, timeoutSeconds, deps, outputSchema, executionIdentityLabels, permissionScopeRoots),
    sessionId: agentId
  }));
}

async function continueManagedPaseoAgentUnleased(
  root: string,
  agentId: string,
  prompt: string,
  timeoutSeconds?: number,
  deps: PaseoRuntimeDeps = defaultDeps(),
  outputSchema?: Record<string, unknown>,
  executionIdentityLabels?: Record<string, string>,
  permissionScopeRoots?: string[]
): Promise<ManagedPaseoAgentResult> {
  const trace = deps.trace ?? defaultDeps().trace!;
  if (executionIdentityLabels?.["aeh.execution.binding"]) {
    const updateLabels = deps.updateLabels ?? defaultDeps().updateLabels!;
    await updateLabels(root, agentId, executionIdentityLabels);
  }
  if (!forceCli()) {
    try {
      const result = {
        ...fromSdk(await deps.sdk.run(root, agentId, prompt, timeoutMs(timeoutSeconds), outputSchema, executionIdentityLabels?.["aeh.operation.phase"], permissionScopeRoots)),
        observation: "sdk-run" as const
      };
      await trace(root, "agent.turn.completed", {
        transport: "sdk",
        observation: "sdk-run",
        agentId,
        status: result.status ?? "unknown",
        killReason: result.killReason ?? "none",
        toolEvents: result.activity?.toolEvents ?? 0,
        structured: Boolean(outputSchema),
        payloadCaptured: Boolean(result.stdout)
      });
      return result;
    } catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "agent.turn.fallback", { agentId, from: "sdk-run", to: "subscription", reason: errorMessage(error), structured: Boolean(outputSchema) });
    }
  }
  let baseline: PaseoTurnBaseline | undefined;
  if (!forceCli()) {
    const native = deps.native ?? defaultDeps().native!;
    if (typeof native.capture === "function") {
      try {
        baseline = await native.capture(root, agentId);
        await trace(root, "agent.turn.baseline", { agentId, assistantMessage: baseline.lastAssistantMessage ? "present" : "absent" });
      } catch (error) {
        if (!sdkCanFallback(error)) throw error;
        await trace(root, "agent.turn.baseline.skipped", { agentId, reason: errorMessage(error) });
      }
    }
  }
  const sent = await dispatchManagedPaseoAgent(root, agentId, prompt, timeoutSeconds, deps);
  if (sent.exitCode !== 0) return sent;
  return waitManagedPaseoAgent(root, agentId, timeoutSeconds, deps, baseline);
}

async function withProviderSessionLease<T>(
  root: string,
  provider: string,
  workspaceId: string | undefined,
  labels: Record<string, string> | undefined,
  sessionId: string | undefined,
  deps: PaseoRuntimeDeps,
  action: () => Promise<{ value: T; sessionId?: string }>
): Promise<T> {
  const context = currentOperationContext();
  if (!context.id) return (await action()).value;
  const operationId = labels?.["aeh.operation"]?.trim();
  const participantId = labels?.["aeh.participant"]?.trim();
  if (labels?.["aeh.kind"] === "semantic-assessment" && operationId === context.id) {
    // Controller-side semantic assessments are non-authoritative, tool-less, read-only model calls
    // with no WorkGraph Participant identity. They must not take a mutable writer provider lease
    // (there is no participant or Lead generation actor to bind), but managed foreground turns
    // still materialize and run atomically so the completed reply is captured reliably.
    return (await action()).value;
  }
  if (!operationId || context.id !== operationId || !participantId) {
    const leadAgentId = labels?.["aeh.lead.agentId"]?.trim();
    const leadGeneration = Number(labels?.["aeh.lead.generation"]);
    if (!operationId || context.id !== operationId || !leadAgentId || !Number.isSafeInteger(leadGeneration) || leadGeneration < 1 || participantId) {
      throw new Error("PASEO_PROVIDER_LEASE_CONTEXT_MISMATCH: operation-bound Paseo work requires matching participant or bound Lead generation labels.");
    }
  }
  const supervisorAgentId = participantId && labels?.["aeh.supervisor"] === "true" ? participantId : undefined;
  const leadAgentId = participantId ? undefined : labels?.["aeh.lead.agentId"]?.trim();
  const leadGeneration = leadAgentId ? Number(labels?.["aeh.lead.generation"]) : undefined;
  const stateRoot = context.controlRoot ?? process.env.AEH_CONTROL_ROOT?.trim() ?? root;
  const operation = await loadOperation(stateRoot, operationId);
  const binding = executionBindingFromLabels(labels);
  const stop = async (agentId: string) => {
    const stopped = await stopManagedPaseoAgent(root, agentId, deps);
    if (stopped.exitCode !== 0) throw new Error(stopped.stderr || `Paseo stop exited ${stopped.exitCode}.`);
  };
  return runWithOperationProviderLease({
    root: stateRoot,
    provider,
    workspaceId: providerLeaseWorkspaceKeyV1({ explicitWorkspaceId: workspaceId, labelWorkspaceId: labels?.["aeh.workspace.id"], launchRoot: root, stateRoot, operationWorkspaceId: operation.workspaceId, operationId }),
    operationId,
    ...(supervisorAgentId ? { supervisorAgentId } : participantId ? { participantId } : { leadAgentId, leadGeneration }),
    sessionId,
    executionBinding: binding,
    inspect: async (agentId) => deps.sdk.inspect(root, agentId),
    stop,
    discoverSession: async () => {
      const found = await deps.sdk.list(root, labels).catch(() => []);
      if (found.length === 1) return found[0]!.id;
      if (found.length === 0) return undefined;
      // Lease-level ambiguous discovery (A3, same contract as the turn
      // path): same-operation duplicates are stopped and re-discovered
      // (empty ⇒ proceed fresh); still-ambiguous or cross-operation matches
      // throw fenced via resolveAmbiguousIdempotentTurns. Never swallows
      // into a silent undefined (which reads as "no session" and invites a
      // duplicate).
      const leaseOperation = labels?.["aeh.operation"]?.trim() ?? "";
      const leaseIdempotency = labels?.["aeh.turn.idempotency"]?.trim();
      const trace = deps.trace ?? defaultDeps().trace!;
      await resolveAmbiguousIdempotentTurns({
        root,
        operation: leaseOperation,
        ...(leaseIdempotency ? { idempotency: leaseIdempotency } : {}),
        candidates: found,
        transport: "lease",
        trace,
        stopAgent: (id) => stopManagedPaseoAgent(root, id, deps),
        relist: () => deps.sdk.list(root, labels).catch(() => []),
      });
      return undefined;
    }
  }, action).then((value) => value);
}

function executionBindingFromLabels(labels?: Record<string, string>): ExecutionBindingV3 | undefined {
  const raw = labels?.["aeh.execution.binding"];
  if (!raw) return undefined;
  const decoded = labels?.["aeh.execution.binding.encoding"] === "base64url"
    ? Buffer.from(raw, "base64url").toString("utf8")
    : raw;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as ExecutionBindingV3;
  } catch (error) {
    throw new Error(`PASEO_PROVIDER_LEASE_EXECUTION_BINDING_INVALID: ${String(error)}`);
  }
}

async function updatePaseoExecutionLabels(root: string, agentId: string, labels: Record<string, string>): Promise<void> {
  const encoded = { ...labels };
  for (const key of ["aeh.execution.binding", "aeh.result.provenance"] as const) {
    const value = encoded[key];
    if (value === undefined) continue;
    try { JSON.parse(value); }
    catch { throw new Error(`PASEO_EXECUTION_IDENTITY_INVALID: ${key} is not valid JSON before metadata binding.`); }
    encoded[key] = Buffer.from(value, "utf8").toString("base64url");
    encoded[`${key}.encoding`] = "base64url";
  }
  const args = ["agent", "update", agentId, ...Object.entries(encoded).flatMap(([key, value]) => ["--label", `${key}=${value}`])];
  const updated = await runExecutable("paseo", args, { cwd: root, timeoutMs: 60_000 });
  if (updated.exitCode !== 0) throw new Error(`PASEO_EXECUTION_IDENTITY_UPDATE_FAILED: ${updated.stderr || updated.stdout || `paseo agent update exited ${updated.exitCode}`}`);
  const observed = await inspectPaseoSdkAgent(root, agentId);
  if (!observed) throw new Error("PASEO_EXECUTION_IDENTITY_UPDATE_UNVERIFIED: Paseo could not read back the materialized agent labels before first-turn dispatch.");
  for (const [key, value] of Object.entries(encoded)) {
    if (observed.labels?.[key] !== value) throw new Error(`PASEO_EXECUTION_IDENTITY_UPDATE_UNVERIFIED: Paseo did not persist label '${key}' before first-turn dispatch.`);
  }
}

export async function probeManagedPaseoAgent(root: string, agentId: string, deps: PaseoRuntimeDeps = defaultDeps()): Promise<boolean> {
  if (!forceCli()) {
    try {
      const inspected = await deps.sdk.inspect(root, agentId);
      if (inspected) return isLivePaseoAgentStatus(inspected.status);
      // Fall back to legacy boolean probe only when inspect is unavailable (no status):
      // fail-closed to false when liveness cannot be positively verified.
      try {
        const legacy = await deps.sdk.probe(root, agentId);
        if (!legacy) return false;
        const verified = await deps.sdk.inspect(root, agentId).catch(() => undefined);
        return verified ? isLivePaseoAgentStatus(verified.status) : false;
      } catch {
        return false;
      }
    } catch (error) { if (!sdkCanFallback(error)) return false; }
  }
  // CLI resume: check status positively via `paseo ls --json`, never logs-only.
  // `paseo logs` success alone is insufficient (dead sessions retain logs);
  // unknown/missing/unverifiable status is fail-closed to false (never reuse).
  try {
    const record = (await listCliAgents(root, deps)).find((agent) => agent.id === agentId);
    if (!record) return false;
    return isLivePaseoAgentStatus(record.status);
  } catch {
    return false;
  }
}

export async function inspectManagedPaseoAgent(root: string, agentId: string, deps: PaseoRuntimeDeps = defaultDeps()): Promise<PaseoSdkAgentRecord | undefined> {
  if (!forceCli()) { try { return await deps.sdk.inspect(root, agentId); } catch (error) { if (!sdkCanFallback(error)) return undefined; } }
  return (await listCliAgents(root, deps)).find((agent) => agent.id === agentId);
}

export async function listManagedPaseoAgents(root: string, labels: Record<string, string> = {}, deps: PaseoRuntimeDeps = defaultDeps()): Promise<PaseoSdkAgentRecord[]> {
  const trace = deps.trace ?? defaultDeps().trace!;
  if (!forceCli()) {
    try { return await deps.sdk.list(root, labels); }
    catch (error) {
      if (!sdkCanFallback(error)) throw error;
      await trace(root, "agent.list.cli.required", { reason: errorMessage(error), labelCount: Object.keys(labels).length });
    }
  }
  return (await listCliAgents(root, deps)).filter((agent) => Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value));
}

async function ensurePreflight(root: string, options: ManagedPaseoAgentOptions, deps: PaseoRuntimeDeps): Promise<void> {
  const native = deps.native ?? defaultDeps().native!;
  const trace = deps.trace ?? defaultDeps().trace!;
  try {
    const result = await native.preflight(root, options.provider, options.model, options.cwd);
    if (!result.ok) {
      const available = result.availableModels?.length ? ` Available models: ${result.availableModels.join(", ")}.` : "";
      throw new Error(`Paseo provider preflight failed: ${result.message}${available}`);
    }
  } catch (error) {
    if (sdkCanFallback(error)) await trace(root, "provider.preflight.skipped", { provider: options.provider, model: options.model ?? "", reason: errorMessage(error) });
    else throw error;
  }
  if (!options.modeId) return;
  if (options.modeSource === "aeh-managed") {
    await trace(root, "provider.mode.preflight", { ok: true, provider: options.provider, modeId: options.modeId, source: "aeh-inline-config", message: "AEH injects this primary OpenCode agent through the session launch environment; ambient provider mode discovery is not authoritative for the dedicated helper." });
    return;
  }
  const mode = await native.preflightMode(root, options.provider, options.modeId, options.cwd);
  if (!mode.ok) {
    const available = mode.availableModes.length ? ` Available modes: ${mode.availableModes.join(", ")}.` : "";
    throw new Error(`Paseo mode preflight failed: ${mode.message}${available}`);
  }
}

async function traceResolvedIdentity(root: string, options: ManagedPaseoAgentOptions, trace: typeof recordPaseoTrace): Promise<void> {
  if (!options.modeId) return;
  await trace(root, "agent.identity", { provider: options.provider, model: options.model ?? "", modeId: options.modeId, source: options.modeSource ?? "provider-mode", sessionScopedEnv: options.env?.OPENCODE_CONFIG_CONTENT ? true : false });
}

async function launchCli(root: string, options: ManagedPaseoAgentOptions, deps: PaseoRuntimeDeps, fallbackReason: string): Promise<ManagedPaseoAgentResult> {
  if (options.prompt === undefined && options.systemPrompt !== undefined) throw new PaseoSdkUnavailableError(`Paseo SDK is required to create an idle systemPrompt-only agent. Refusing CLI fallback because it would expose session instructions as a user turn. ${fallbackReason}`);
  if (options.env && Object.keys(options.env).length) throw new PaseoSdkUnavailableError(`Paseo SDK is required for session-scoped launch environment used by provider ${options.provider}${options.modeId ? ` mode ${options.modeId}` : ""}. Refusing CLI fallback because dropping that environment could change the native execution identity or permissions. ${fallbackReason}`);
  if (options.providerOptions && Object.keys(options.providerOptions).length) throw new PaseoSdkUnavailableError(`Paseo SDK is required for provider-native options used by provider ${options.provider}. Refusing CLI fallback because dropping the projected sandbox policy could change the participant's execution authority. ${fallbackReason}`);
  const trace = deps.trace ?? defaultDeps().trace!;
  // CLI idempotency guard: same key derivation (applied by the caller), same
  // reuse-live/reap-dead semantics adapted to CLI handles (`paseo ls --json`
  // records + `paseo stop`). A retry after SDK fallback or under
  // AEH_PASEO_FORCE_CLI=1 reuses the live CLI orphan instead of silently
  // creating a duplicate.
  const reused = await reuseLiveIdempotentCliTurn(root, options, deps, trace, fallbackReason);
  if (reused) return reused;
  const capabilities = await deps.detectCapabilities(root, deps.run);
  const prompt = options.prompt;
  if (prompt === undefined) throw new Error("Paseo CLI fallback requires a prompt.");
  const timeout = options.timeoutSeconds ?? Math.max(1, Math.ceil((options.timeoutMs ?? 1_800_000) / 1000));
  // Propagate the idempotency filter labels onto the CLI agent so a later retry
  // can match this launch. Task/role/phase ride along for observability; large
  // JSON labels (execution binding, provenance) are never propagated to CLI.
  const labelArgs = cliIdempotencyLabels(options).map(([key, value]) => `--label ${quote(`${key}=${value}`)}`);
  if (options.outputSchema) {
    if (!capabilities.outputSchema) throw new Error(`Installed Paseo${capabilities.version ? ` ${capabilities.version}` : ""} does not advertise --output-schema required by this agent.`);
    const parts = ["paseo run --quiet", `--title ${quote(options.title)}`, `--provider ${quote(options.provider)}`];
    if (options.workspaceId) parts.push(`--workspace ${quote(options.workspaceId)}`);
    if (options.model) parts.push(`--model ${quote(options.model)}`);
    parts.push(`--output-schema ${quote(JSON.stringify(options.outputSchema))}`, ...labelArgs, quote(prompt));
    const result = await deps.run(parts.join(" "), { cwd: root, timeoutMs: timeout * 1000 });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: [fallbackReason, result.stderr].filter(Boolean).join("\n"), status: result.exitCode === 0 ? "idle" : "failed", transport: "cli" };
  }
  const base = buildPaseoBackgroundRunCommand({ title: options.title, provider: options.provider, model: options.model, workspaceId: options.workspaceId, prompt }, capabilities);
  const quotedPrompt = quote(prompt);
  // buildPaseoBackgroundRunCommand always appends the quoted prompt last; the
  // labels must precede it. Fail-closed: never launch unlabeled when the shape
  // is unexpected (that would silently reintroduce the duplicate-create bypass).
  if (!base.endsWith(quotedPrompt)) throw new Error(`PASEO_CLI_IDEMPOTENCY_LABEL_FAILED: background run command does not end with the quoted prompt; refusing to launch without idempotency labels. ${fallbackReason}`);
  const command = labelArgs.length ? `${base.slice(0, base.length - quotedPrompt.length)}${labelArgs.join(" ")} ${quotedPrompt}` : base;
  const launch = await deps.run(command, { cwd: root, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) return { exitCode: launch.exitCode, stdout: launch.stdout, stderr: [fallbackReason, launch.stderr].filter(Boolean).join("\n"), status: "failed", transport: "cli" };
  const id = extractPaseoAgentId(launch.stdout);
  if (!id) return { exitCode: 1, stdout: launch.stdout, stderr: [fallbackReason, "Paseo returned no parseable agent id."].join("\n"), status: "failed", transport: "cli" };
  const launched: ManagedPaseoAgentResult = { id, exitCode: 0, stdout: launch.stdout, stderr: launch.stderr, status: "working", workspaceId: options.workspaceId, transport: "cli" };
  await registerManagedAgent(root, options, launched);
  if (options.waitForFinish === false) return launched;
  const waited = await waitManagedPaseoAgent(root, id, timeout, deps);
  return { ...waited, stderr: [fallbackReason, launch.stderr, waited.stderr].filter(Boolean).join("\n") };
}

async function registerManagedAgent(root: string, options: ManagedPaseoAgentOptions, result: ManagedPaseoAgentResult): Promise<void> {
  if (!result.id) return;
  const role = options.labels?.["aeh.role"];
  if (!role) return;
  // The Semantic Assessor is an AEH Agent, not automatically a WorkGraph Participant: its
  // read-only assessment turns carry no WorkUnit ownership and never produce participant receipts.
  if (options.labels?.["aeh.kind"] === "semantic-assessment") return;
  // A launch that carries a controller-issued participant identity is already durably registered
  // by the execution-authority path; minting a second participant for the runtime session would
  // split one bounded work unit across two terminal-gate identities.
  if (options.labels?.["aeh.participant"] || options.env?.AEH_PARTICIPANT_ID) return;
  await registerCurrentOperationAgent(root, { id: result.id, role, phase: options.labels?.["aeh.operation.phase"], workspaceId: result.workspaceId ?? options.workspaceId, transport: result.transport });
}

async function listCliAgents(root: string, deps: PaseoRuntimeDeps): Promise<PaseoSdkAgentRecord[]> {
  const result = await deps.run("paseo ls -a -g --json", { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  try { const records = new Map<string, PaseoSdkAgentRecord>(); collectCliAgents(JSON.parse(result.stdout) as unknown, records); return [...records.values()]; }
  catch { return []; }
}

function collectCliAgents(value: unknown, out: Map<string, PaseoSdkAgentRecord>): void {
  if (Array.isArray(value)) { for (const child of value) collectCliAgents(child, out); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const id = firstString(record, ["id", "agentId", "agent_id"]);
  if (id && ("status" in record || "title" in record || "labels" in record)) out.set(id, { id, title: firstString(record, ["title", "name"]), status: statusText(record.status), workspaceId: firstString(record, ["workspaceId", "workspace_id"]), labels: stringRecord(record.labels), raw: record });
  for (const child of Object.values(record)) collectCliAgents(child, out);
}

/**
 * Orphan/duplicate-turn guards (D5).
 *
 * MECHANISM: DETERMINISTIC. Idempotency key derived from frozen operation labels
 * plus prompt/provider/model (sha256, no model reasoning, no clock). Encoding is
 * length-prefixed (byte-length + ":" + field + "\0" concatenated) so NUL- or
 * separator-containing fields cannot collide (unlike naive "\0"-join, where
 * ["a\0b","c"] and ["a","b\0c"] hash identically). Orphan reaper lists by
 * `aeh.operation` (+ idempotency) before create/retry; best-effort.
 * Ambiguous live matches self-heal first (A3 outer: stop-all same-operation
 * duplicates + re-verify empty, then create-new; cross-operation matches
 * fence, stop-failure/survivors throw AMBIGUOUS — the E-NEW-1 inner
 * fail-closed contract: no create-new ever runs next to live survivors).
 * List failure fails closed to create-new (never blocks launch).
 * Liveness is positive-only (idle/working/running); unknown/terminal/dead never
 * reuses. Reaper reaps only positively-dead statuses; unknown is left alone.
 * No retry budgets, leases authority, or vagueness gates touched.
 *
 * CLI parity: the SDK-fallback and AEH_PASEO_FORCE_CLI=1 launch paths share the
 * same derived key (derived once, transport-agnostic) and run the same
 * reuse-live/reap-dead guard adapted to CLI handles (`paseo ls --json` records
 * filtered client-side + `paseo stop`). CLI launches propagate the
 * `aeh.operation` + `aeh.turn.idempotency` filter labels via `paseo run
 * --label` so a retry can match the orphan; without them the CLI path would
 * silently duplicate every retried turn.
 */
export function derivePaseoTurnIdempotencyKey(options: ManagedPaseoAgentOptions): string | undefined {
  const operation = options.labels?.["aeh.operation"]?.trim();
  if (!operation) return undefined;
  const task = options.labels?.["aeh.task"]?.trim() ?? "";
  const role = options.labels?.["aeh.role"]?.trim() ?? "";
  const phase = options.labels?.["aeh.operation.phase"]?.trim() ?? "";
  const provider = options.provider ?? "";
  const model = options.model ?? "";
  const prompt = options.prompt ?? "";
  const title = options.title ?? "";
  return createHash("sha256").update(encodeIdempotencyFields([operation, task, role, phase, provider, model, title, prompt])).digest("hex");
}

/**
 * Length-prefixed unambiguous field encoding (DETERMINISTIC).
 * Each field as `<utf8-byte-length>:<field>\0`, concatenated. The byte length
 * makes parsing unambiguous even when fields contain NUL, colons, digits, or
 * any other bytes: distinct field tuples always produce distinct encodings.
 */
export function encodeIdempotencyFields(fields: string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}\0`).join("");
}

function withTurnIdempotencyKey(options: ManagedPaseoAgentOptions): ManagedPaseoAgentOptions {
  const key = derivePaseoTurnIdempotencyKey(options);
  if (!key) return options;
  if (options.labels?.["aeh.turn.idempotency"] === key) return options;
  return { ...options, labels: { ...(options.labels ?? {}), "aeh.turn.idempotency": key } };
}

function isLivePaseoAgentStatus(status?: string): boolean {
  return status === "idle" || status === "working" || status === "running";
}

/**
 * Positively-dead statuses only (DETERMINISTIC, fail-closed the other direction).
 * Unknown (undefined/empty/unrecognized, including permission/waiting approval
 * prompts whose session may still be resumable) is NEVER dead: reaper leaves it
 * alone. Only statuses that definitively mean a dead/terminal session are reaped.
 */
export function isPositivelyDeadPaseoAgentStatus(status?: string): boolean {
  return status === "failed"
    || status === "error"
    || status === "cancelled"
    || status === "timeout"
    || status === "finished"
    || status === "completed"
    || status === "dead"
    || status === "exited"
    || status === "stopped";
}

/**
 * Self-healing resolution for ambiguous live idempotent turns (A3).
 *
 * MECHANISM: DETERMINISTIC. The idempotency key binds matches to one
 * operation: `derivePaseoTurnIdempotencyKey` hashes the operation id as its
 * first field, so same-key matches are same-operation duplicates by
 * construction. The binding is asserted in code, not assumed:
 * - missing operation/idempotency binding ⇒ fail closed (fencing throw);
 * - any candidate whose labels do NOT carry our operation key (matches span
 *   operations — shouldn't happen through server-side filters, but coded
 *   anyway) ⇒ PASEO_TURN_FENCING_REQUIRED throw, and foreign sessions are
 *   never stopped;
 * - all matches share our operation key ⇒ STOP-ALL matching + re-verify
 *   empty + proceed fresh (self-healing: no operator, no permanent fence).
 * A stop failure, a re-list failure, or a still-unresolved re-list (live OR
 * unknown/unrecognized — only positively-dead reads as resolved) ⇒
 * PASEO_TURN_IDEMPOTENCY_AMBIGUOUS throw (never silently create-new next
 * to survivors or unverified sessions).
 */
export async function resolveAmbiguousIdempotentTurns(input: {
  root: string;
  operation: string;
  idempotency?: string;
  candidates: PaseoSdkAgentRecord[];
  transport: "sdk" | "cli" | "lease";
  trace: (root: string, event: string, details: Record<string, unknown>) => Promise<void>;
  stopAgent: (id: string) => Promise<{ exitCode: number; stderr: string }>;
  relist: () => Promise<PaseoSdkAgentRecord[]>;
}): Promise<void> {
  const { root, operation, idempotency, candidates, transport, trace } = input;
  if (!operation || !idempotency) {
    await trace(root, "agent.launch.ambiguous", { transport, operation: operation || "missing", idempotency: "missing", live: candidates.map((agent) => agent.id) });
    throw new Error(`PASEO_TURN_FENCING_REQUIRED: ${candidates.length} sessions match without a complete operation-bound idempotency key; refusing to select or stop. Resolve the duplicate sessions explicitly.`);
  }
  const foreign = candidates.filter(
    (agent) => agent.labels?.["aeh.operation"] !== operation || agent.labels?.["aeh.turn.idempotency"] !== idempotency
  );
  if (foreign.length > 0) {
    await trace(root, "agent.launch.ambiguous", { transport, operation, idempotency, live: candidates.map((agent) => agent.id), foreign: foreign.map((agent) => agent.id) });
    throw new Error(`PASEO_TURN_FENCING_REQUIRED: ${candidates.length} sessions share idempotency key '${idempotency}' across operations [${foreign.map((agent) => agent.id).join(", ")} not bound to '${operation}']; refusing to stop or reuse. Fence and resolve explicitly.`);
  }
  await trace(root, "agent.launch.ambiguous-self-heal", { transport, operation, idempotency, live: candidates.map((agent) => agent.id) });
  for (const agent of candidates) {
    const stopped = await input.stopAgent(agent.id);
    if (stopped.exitCode !== 0) {
      await trace(root, "agent.launch.ambiguous-stop-failed", { transport, operation, idempotency, agentId: agent.id, stopExitCode: stopped.exitCode });
      throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not stop duplicate session '${agent.id}' (stop exit ${stopped.exitCode}: ${stopped.stderr}); refusing create-new next to survivors. Resume one of [${candidates.map((item) => item.id).join(", ")}] explicitly.`);
    }
    await trace(root, "agent.launch.ambiguous-stopped", { transport, operation, idempotency, agentId: agent.id });
  }
  let relisted: PaseoSdkAgentRecord[];
  try {
    relisted = await input.relist();
  } catch (error) {
    await trace(root, "agent.launch.ambiguous-relist-failed", { transport, operation, idempotency, error: errorMessage(error) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not re-verify idempotency key '${idempotency}' for operation '${operation}' after stop-all (${errorMessage(error)}); refusing create-new without proof of empty. Resume one of [${candidates.map((item) => item.id).join(", ")}] explicitly.`);
  }
  if (!Array.isArray(relisted)) {
    await trace(root, "agent.launch.ambiguous-relist-failed", { transport, operation, idempotency, error: "non-array re-list result" });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not re-verify idempotency key '${idempotency}' for operation '${operation}' after stop-all (non-array re-list result); refusing create-new without proof of empty. Resume one of [${candidates.map((item) => item.id).join(", ")}] explicitly.`);
  }
  // Fail-closed re-verify: the re-list must establish NO UNRESOLVED matching
  // sessions. Unknown/unrecognized statuses count as unresolved (a possible
  // live writer we could not read) — only positively-dead reads as resolved.
  const unresolved = relisted.filter((agent) => !isPositivelyDeadPaseoAgentStatus(agent.status));
  if (unresolved.length > 0) {
    await trace(root, "agent.launch.ambiguous", { transport, operation, idempotency, live: unresolved.map((agent) => agent.id), unresolved: unresolved.map((agent) => `${agent.id}:${agent.status ?? "unknown"}`) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: ${unresolved.length} unresolved sessions still share idempotency key '${idempotency}' for operation '${operation}' after stop-all; refusing create-new. Resume one of [${unresolved.map((agent) => agent.id).join(", ")}] explicitly.`);
  }
}

async function reuseLiveIdempotentTurn(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps,
  trace: (root: string, event: string, details: Record<string, unknown>) => Promise<void>
): Promise<ManagedPaseoAgentResult | undefined> {
  const operation = options.labels?.["aeh.operation"]?.trim();
  const idempotency = options.labels?.["aeh.turn.idempotency"]?.trim();
  // No-token first-create path (NOT ambiguous): without an operation label no
  // idempotency key is derivable (see withTurnIdempotencyKey/derive: key is
  // undefined iff operation is missing), so no retry can match under a key
  // and no duplicate-writer hazard exists under any key. Only this path may
  // fall through to create-new without a list proof. When in doubt, fail
  // closed: any present operation+idempotency pair must prove empty below.
  if (!operation || !idempotency) return undefined;
  const listMatching = async (): Promise<PaseoSdkAgentRecord[]> => {
    // Re-list failure must throw (the ambiguity resolver converts it to
    // AMBIGUOUS) — never [] (that would read as verified-empty and
    // fresh-create beside a possible live writer).
    return deps.sdk.list(root, { "aeh.operation": operation, "aeh.turn.idempotency": idempotency });
  };
  // Initial-list failure on this guarded path throws AMBIGUOUS (fail closed):
  // an unobserved matching live writer may exist, so returning undefined
  // (then sdk.create) would duplicate the turn. An empty list below is the
  // only verified-empty signal.
  let candidates: PaseoSdkAgentRecord[];
  try {
    candidates = await deps.sdk.list(root, { "aeh.operation": operation, "aeh.turn.idempotency": idempotency });
  } catch (error) {
    await trace(root, "agent.launch.ambiguous-list-failed", { transport: "sdk", operation, idempotency, error: errorMessage(error) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not list sessions for idempotency key '${idempotency}' for operation '${operation}' (${errorMessage(error)}); refusing create-new without proof of empty. Resume explicitly once the list endpoint recovers.`);
  }
  // Non-array initial list is unverified (same hazard as a list failure):
  // fail closed, never read as verified-empty. Only [] proves empty.
  if (!Array.isArray(candidates)) {
    await trace(root, "agent.launch.ambiguous-list-failed", { transport: "sdk", operation, idempotency, error: "non-array initial list result" });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not list sessions for idempotency key '${idempotency}' for operation '${operation}' (non-array initial list result); refusing create-new without proof of empty. Resume explicitly once the list endpoint recovers.`);
  }
  if (candidates.length === 0) return undefined;
  const live = candidates.filter((agent) => isLivePaseoAgentStatus(agent.status));
  if (live.length > 1) {
    // Ambiguous live orphans: self-heal first (A3 outer — stop-all
    // same-operation duplicates + re-verify empty, then create-new).
    // Healing-impossible shapes throw fenced from inside the resolver
    // (cross-operation PASEO_TURN_FENCING_REQUIRED; stop-failure/survivors
    // PASEO_TURN_IDEMPOTENCY_AMBIGUOUS) — the E-NEW-1 inner fail-closed
    // contract: no create-new ever runs next to live survivors.
    await resolveAmbiguousIdempotentTurns({ root, operation, idempotency, candidates, transport: "sdk", trace, stopAgent: (id) => stopManagedPaseoAgent(root, id, deps), relist: listMatching });
    return undefined;
  }
  if (live.length === 1) {
    const found = live[0]!;
    await trace(root, "agent.launch.reused", { transport: "sdk", agentId: found.id, operation, idempotency });
    await registerManagedAgent(root, options, { id: found.id, exitCode: 0, stdout: "", stderr: "", status: found.status, workspaceId: found.workspaceId, transport: "sdk" });
    if (!found.id || options.prompt === undefined || options.waitForFinish === false) {
      return { id: found.id, exitCode: 0, stdout: "", stderr: "", status: found.status, workspaceId: found.workspaceId, transport: "sdk" };
    }
    return waitManagedPaseoAgent(root, found.id, options.timeoutSeconds ?? secondsFromMs(options.timeoutMs), deps, undefined, options.permissionScopeRoots);
  }
  // Dead orphans only (ambiguity self-healed above): reap ONLY
  // positively-dead best-effort, never throw, then create-new. Unknown
  // (undefined/empty/unrecognized) is left alone fail-closed (never counted
  // as dead, never reaped).
  for (const agent of candidates) {
    if (isLivePaseoAgentStatus(agent.status)) continue;
    if (!isPositivelyDeadPaseoAgentStatus(agent.status)) {
      await trace(root, "agent.launch.left-alone", { transport: "sdk", agentId: agent.id, operation, idempotency, status: agent.status ?? "unknown", reason: "unknown-status-not-dead" });
      continue;
    }
    try {
      await stopManagedPaseoAgent(root, agent.id, deps);
      await trace(root, "agent.launch.reaped", { transport: "sdk", agentId: agent.id, operation, idempotency, status: agent.status ?? "unknown" });
    } catch { /* best-effort reaper never blocks launch */ }
  }
  const stillLive = candidates.filter((agent) => isLivePaseoAgentStatus(agent.status));
  if (stillLive.length > 1) {
    await trace(root, "agent.launch.ambiguous", { transport: "sdk", operation, idempotency, live: stillLive.map((agent) => agent.id) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: ${stillLive.length} live sessions share idempotency key '${idempotency}' for operation '${operation}' after reaping; refusing create-new. Resume one of [${stillLive.map((agent) => agent.id).join(", ")}] explicitly.`);
  }
  if (stillLive.length === 1) {
    const found = stillLive[0]!;
    await registerManagedAgent(root, options, { id: found.id, exitCode: 0, stdout: "", stderr: "", status: found.status, workspaceId: found.workspaceId, transport: "sdk" });
    if (!found.id || options.prompt === undefined || options.waitForFinish === false) {
      return { id: found.id, exitCode: 0, stdout: "", stderr: "", status: found.status, workspaceId: found.workspaceId, transport: "sdk" };
    }
    return waitManagedPaseoAgent(root, found.id, options.timeoutSeconds ?? secondsFromMs(options.timeoutMs), deps, undefined, options.permissionScopeRoots);
  }
  return undefined;
}

/**
 * CLI idempotency filter labels (DETERMINISTIC).
 *
 * `aeh.operation` + `aeh.turn.idempotency` are the reuse filter keys: they must
 * be present on the CLI agent or a retry cannot match it. Task/role/phase ride
 * along for observability when present. Large JSON labels (execution binding,
 * result provenance) are never propagated to CLI launch: they are bound through
 * the verified `agent update` path, not the create command line.
 */
function cliIdempotencyLabels(options: ManagedPaseoAgentOptions): Array<[string, string]> {
  const labels = options.labels ?? {};
  const result: Array<[string, string]> = [];
  for (const key of ["aeh.operation", "aeh.turn.idempotency", "aeh.task", "aeh.role", "aeh.operation.phase"] as const) {
    const value = labels[key]?.trim();
    if (value) result.push([key, value]);
  }
  return result;
}

/**
 * CLI-adapted idempotent-turn reuse (DETERMINISTIC, initial-list fail-closed).
 *
 * Same contract as reuseLiveIdempotentTurn: exactly one live match (idle/
 * working/running, positive-only) is reused; otherwise positively-dead matches
 * are reaped best-effort, unknown statuses are left alone with a trace, and an
 * initial `paseo ls` failure throws PASEO_TURN_IDEMPOTENCY_AMBIGUOUS (never
 * undefined-then-`paseo run`: an unobserved matching live writer may exist).
 * The only create-without-proof path is the no-token path (missing operation
 * or idempotency label — no key, no retry can match, no duplicate hazard;
 * see the SDK guard for the proof). Matching is client-side over
 * `paseo ls --json` records because the CLI has no server-side label query.
 */
async function reuseLiveIdempotentCliTurn(
  root: string,
  options: ManagedPaseoAgentOptions,
  deps: PaseoRuntimeDeps,
  trace: (root: string, event: string, details: Record<string, unknown>) => Promise<void>,
  fallbackReason: string
): Promise<ManagedPaseoAgentResult | undefined> {
  const operation = options.labels?.["aeh.operation"]?.trim();
  const idempotency = options.labels?.["aeh.turn.idempotency"]?.trim();
  // No-token first-create path (NOT ambiguous): same proof as the SDK guard —
  // without operation+idempotency there is no key a retry could match, so no
  // duplicate-writer hazard exists under any key. Only this path may fall
  // through to `paseo run` without a list proof.
  if (!operation || !idempotency) return undefined;
  const listMatching = async (): Promise<PaseoSdkAgentRecord[]> => {
    // Re-list failure must throw (the ambiguity resolver converts it to
    // AMBIGUOUS) — never [] (that would read as verified-empty and
    // fresh-create beside a possible live writer).
    return (await listCliAgents(root, deps)).filter(
      (agent) => agent.labels?.["aeh.operation"] === operation && agent.labels?.["aeh.turn.idempotency"] === idempotency
    );
  };
  // Initial-list failure throws AMBIGUOUS (fail closed): an unobserved
  // matching live writer may exist, so undefined-then-`paseo run` would
  // duplicate the turn. Only a verified empty list below permits create-new.
  let candidates: PaseoSdkAgentRecord[];
  try {
    candidates = (await listCliAgents(root, deps)).filter(
      (agent) => agent.labels?.["aeh.operation"] === operation && agent.labels?.["aeh.turn.idempotency"] === idempotency
    );
  } catch (error) {
    await trace(root, "agent.launch.ambiguous-list-failed", { transport: "cli", operation, idempotency, error: errorMessage(error) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: could not list CLI sessions for idempotency key '${idempotency}' for operation '${operation}' (${errorMessage(error)}); refusing create-new without proof of empty. Resume explicitly once the list endpoint recovers.`);
  }
  if (candidates.length === 0) return undefined;
  const reuse = async (found: PaseoSdkAgentRecord): Promise<ManagedPaseoAgentResult> => {
    await trace(root, "agent.launch.reused", { transport: "cli", agentId: found.id, operation, idempotency });
    await registerManagedAgent(root, options, { id: found.id, exitCode: 0, stdout: "", stderr: "", status: found.status, workspaceId: found.workspaceId, transport: "cli" });
    if (!found.id || options.prompt === undefined || options.waitForFinish === false) {
      return { id: found.id, exitCode: 0, stdout: "", stderr: fallbackReason, status: found.status, workspaceId: found.workspaceId, transport: "cli" };
    }
    const waited = await waitManagedPaseoAgent(root, found.id, options.timeoutSeconds ?? secondsFromMs(options.timeoutMs), deps);
    return { ...waited, stderr: [fallbackReason, waited.stderr].filter(Boolean).join("\n") };
  };
  const live = candidates.filter((agent) => isLivePaseoAgentStatus(agent.status));
  if (live.length > 1) {
    // Same self-healing contract as the SDK path (A3 outer): stop-all
    // same-key matches, re-verify empty, then create-new. Healing-impossible
    // shapes throw fenced from inside the resolver (cross-operation matches
    // fence; stop-failure/survivors throw AMBIGUOUS) — the E-NEW-1 inner
    // fail-closed contract: no CLI create ever runs next to live survivors.
    await resolveAmbiguousIdempotentTurns({ root, operation, idempotency, candidates, transport: "cli", trace, stopAgent: (id) => stopManagedPaseoAgent(root, id, deps), relist: listMatching });
    return undefined;
  }
  if (live.length === 1) return reuse(live[0]!);
  // Dead orphans only (ambiguity self-healed above): reap ONLY
  // positively-dead best-effort, never throw, then create-new. Unknown
  // (undefined/empty/unrecognized) is left alone fail-closed (never counted
  // as dead, never reaped).
  for (const agent of candidates) {
    if (isLivePaseoAgentStatus(agent.status)) continue;
    if (!isPositivelyDeadPaseoAgentStatus(agent.status)) {
      await trace(root, "agent.launch.left-alone", { transport: "cli", agentId: agent.id, operation, idempotency, status: agent.status ?? "unknown", reason: "unknown-status-not-dead" });
      continue;
    }
    try {
      await stopManagedPaseoAgent(root, agent.id, deps);
      await trace(root, "agent.launch.reaped", { transport: "cli", agentId: agent.id, operation, idempotency, status: agent.status ?? "unknown" });
    } catch { /* best-effort reaper never blocks launch */ }
  }
  const stillLive = candidates.filter((agent) => isLivePaseoAgentStatus(agent.status));
  if (stillLive.length > 1) {
    await trace(root, "agent.launch.ambiguous", { transport: "cli", operation, idempotency, live: stillLive.map((agent) => agent.id) });
    throw new Error(`PASEO_TURN_IDEMPOTENCY_AMBIGUOUS: ${stillLive.length} live CLI sessions share idempotency key '${idempotency}' for operation '${operation}' after reaping; refusing create-new. Resume one of [${stillLive.map((agent) => agent.id).join(", ")}] explicitly.`);
  }
  if (stillLive.length === 1) return reuse(stillLive[0]!);
  return undefined;
}

function forceCli(): boolean { return process.env.AEH_PASEO_FORCE_CLI === "1"; }
function sdkCanFallback(error: unknown): boolean { return error instanceof PaseoSdkUnavailableError || (error instanceof Error && error.name === "PaseoSdkUnavailableError"); }
function timeoutMs(seconds?: number): number { return (seconds ?? 1800) * 1000; }
function secondsFromMs(ms?: number): number | undefined { return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000)); }
function providerStopDetail(status?: string, permission?: import("./sdk.js").PaseoSdkPermissionStop): string | undefined {
  if (status !== "permission" && status !== "waiting") return undefined;
  const descriptor = permission
    ? [permission.name, `scope=${permission.scopeRelation}`, permission.requestedScopeDigest ? `scopeDigest=${permission.requestedScopeDigest}` : undefined, permission.sessionId ? `session=${permission.sessionId}` : undefined, permission.turnId ? `turn=${permission.turnId}` : undefined].filter(Boolean).join(" ")
    : undefined;
  return `provider session stopped on an unapproved '${status}' prompt${descriptor ? ` (${descriptor})` : ""}; the turn produced no result`;
}
function fromSdk(result: PaseoSdkAgentResult): ManagedPaseoAgentResult {
  const permission = isPermissionStopStatus(result.status) ? redactPermissionStopDiagnostic(result.permission, result.id) : result.permission ? redactPermissionStopDiagnostic(result.permission, result.id) : undefined;
  return { id: result.id, exitCode: sdkExitCode(result.status, result.error), stdout: permission ? "" : result.lastMessage ?? "", stderr: [permission ? undefined : result.error, providerStopDetail(result.status, permission)].filter(Boolean).join("\n"), status: result.status, workspaceId: result.workspaceId, transport: "sdk", ...(permission ? { permission } : {}), ...(result.killReason ? { killReason: result.killReason } : result.status === "timeout" ? { killReason: "DEADLINE" as ProviderTurnKillReason } : {}), ...(result.activity ? { activity: result.activity } : {}) };
}
function fromNativeWait(result: PaseoNativeWaitResult): ManagedPaseoAgentResult {
  const permission = isPermissionStopStatus(result.status) ? redactPermissionStopDiagnostic(result.permission, result.id) : result.permission ? redactPermissionStopDiagnostic(result.permission, result.id) : undefined;
  return { id: result.id, exitCode: sdkExitCode(result.status, result.error), stdout: permission ? "" : result.lastMessage ?? "", stderr: [permission ? undefined : result.error, providerStopDetail(result.status, permission)].filter(Boolean).join("\n"), status: result.status, workspaceId: result.workspaceId, transport: "sdk", observation: "subscription", ...(permission ? { permission } : {}), ...(result.killReason ? { killReason: result.killReason } : result.status === "timeout" ? { killReason: "DEADLINE" as ProviderTurnKillReason } : {}), ...(result.activity ? { activity: result.activity } : {}), ...(result.efficiencyTelemetry ? { efficiencyTelemetry: result.efficiencyTelemetry } : {}) };
}
function isPermissionStopStatus(status?: string): boolean { return status === "permission" || status === "waiting"; }
function sdkExitCode(status?: string, error?: string): number { if (status === "timeout") return 124; if (error) return 1; if (status === "failed" || status === "error" || status === "cancelled" || status === "permission" || status === "waiting") return 1; return 0; }
function firstString(record: Record<string, unknown>, keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function stringRecord(value: unknown): Record<string, string> | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") result[key] = item; return Object.keys(result).length ? result : undefined; }
function statusText(value: unknown): string | undefined { if (typeof value === "string") return value; if (value && typeof value === "object" && typeof (value as Record<string, unknown>).status === "string") return (value as Record<string, unknown>).status as string; return undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
