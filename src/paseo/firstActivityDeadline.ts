/**
 * First-activity deadline for provider turns.
 *
 * BACKGROUND (verified): provider turns launched through the Paseo SDK atomic
 * run path are opaque until they settle: no timeline subscription observes
 * them mid-turn. A provider that never emits tool calls or stream output
 * therefore wastes the full 30-minute provider turn deadline before the
 * existing timeout kill engages. This module defines the deterministic,
 * content-based first-activity bound that terminates such stalled turns
 * early while leaving every legitimate slow turn untouched.
 *
 * MECHANISM: DETERMINISTIC. The bound is a fixed wall-clock budget from turn
 * dispatch; activity is provider-visible content only (tool-call timeline
 * events or new assistant stream output). Bare subscription updates, raw
 * working/running status, and turn acceptance alone never count: the
 * observed stall signature is zero tool calls/output for the full budget.
 *
 * BOUND JUSTIFICATION (all numbers verified in-tree + durable telemetry):
 * - Provider turn hard cap: 30min (`providerTurnDeadlineMs` default
 *   30*60_000; templates/project.yaml, src/architecture/executionIdentity.ts,
 *   src/paseo/launchSpec.ts). Hard caps are unchanged; this bound only
 *   terminates strictly earlier (25min < 30min, 5min saved per stall).
 * - Durable subscription-path evidence (`.harness/telemetry/paseo.ndjson`,
 *   193 `agent.wait` traces): 179 successful waits settle in max 90.2s
 *   (median 12s, p90 20.1s); 14 timeouts all hit the full 30min with
 *   `updatesObserved=0` — the exact zero-activity stall signature. 25min is
 *   16.6x the max observed successful subscription wait.
 * - Durable SDK-run evidence (126 `PROVIDER_TURN_STARTED`→`ACCEPTED/COMPLETED`
 *   pairs across `.harness/operations/<op>/execution/activity.ndjson`): median
 *   137s, p90 527s, max 1733s (27.7min Implementer COMPLETED + 21.2min
 *   Implementer COMPLETED). Liveness `toolCallCount` is always 0 for SDK runs
 *   (opaque atomic path records no mid-turn tool events), so
 *   time-to-first-tool-call is unmeasurable from durable sources; total turn
 *   time is the only durable bound. 20min therefore has NO margin on total
 *   duration (two healthy Implementer completions exceed it), so CONSERVATISM
 *   requires 25min: it preserves 125/126 completions by total duration,
 *   exceeds the single-journey browser Playwright budget (20min per journey,
 *   `tests/browser/playwright.config.ts`) with 5min margin, and is 5x the
 *   300s semantic model deadline below.
 * - Per-role totals: Planner max 5.9min, Spec Manager 5.7min, Repairer 11.3min
 *   (all under 25min with 2x+ margin); Explorer/Implementer long tails
 *   (28.9min FAILED, 27.7min COMPLETED) need the bound most — role scoping was
 *   rejected because the observed Implementer stall (30min timeout, zero
 *   activity) is the expensive case this bound saves. Any tool call or stream
 *   output satisfies the bound, so long turns with steady output are never
 *   killed; the residual silent->25min risk is closed by the SDK stop-then-read
 *   ordering invariant (post-stop authoritative read classifies late activity
 *   as DEADLINE with forensics, never as STALLED).
 * - Production workhorse (Muse via OpenCode) carries no thinking variant,
 *   so it runs provider-default reasoning; xhigh thinking is reserved for
 *   the Luna brain lanes, which never show the zero-activity signature.
 * - Explorer/Planner/Reviewer turns are read-only discovery and emit tool
 *   calls within seconds; any tool call or stream output satisfies the
 *   bound, so legitimate slow turns with steady output are never killed.
 */

export const PROVIDER_TURN_DEADLINE_MS = 30 * 60_000;
export const FIRST_ACTIVITY_DEADLINE_MS = 25 * 60_000;
export const SEMANTIC_MODEL_DEADLINE_MS_V1 = 300_000;

/** Default poll cadence while racing an opaque provider run for first activity. */
export const FIRST_ACTIVITY_POLL_MS = 30_000;

export type ProviderTurnKillReason = "DEADLINE" | "STALLED_FIRST_ACTIVITY" | "ERROR";

export interface ProviderVisibleActivitySignal {
  updatesObserved: number;
  toolEventCount: number;
  assistantDelta: boolean;
}

export interface ProviderTurnActivityCounts {
  updatesObserved: number;
  toolEvents: number;
  assistantDelta: boolean;
}

const STALLED_FIRST_ACTIVITY_MARKER = "STALLED_FIRST_ACTIVITY";

/**
 * Content-based activity test. Only tool-call timeline events or new
 * assistant stream output count. Bare subscription pings and raw
 * working/running status never satisfy the bound.
 */
export function hasProviderVisibleActivity(signal: ProviderVisibleActivitySignal): boolean {
  return signal.toolEventCount > 0 || signal.assistantDelta;
}

/** Bounded stall error text. Refs-only: counts and budgets, never provider content. */
export function stalledFirstActivityError(
  firstActivityMs: number,
  timeoutMs: number,
  counts: ProviderTurnActivityCounts
): string {
  return (
    `${STALLED_FIRST_ACTIVITY_MARKER}: provider turn produced zero provider-visible activity ` +
    `after ${firstActivityMs}ms (turn deadline ${timeoutMs}ms retained; ` +
    `updates=${counts.updatesObserved} toolEvents=${counts.toolEvents} ` +
    `assistantDelta=${counts.assistantDelta}); turn stopped and existing retry budgets apply.`
  );
}

/**
 * Classify the kill reason from the settled turn shape. Stall kills carry
 * the explicit marker; plain 124/timeout kills are the existing deadline
 * path; anything else is an error kill. Existing retry/recovery paths key
 * on the settled FAILED shape, so all three route identically downstream.
 */
export function classifyProviderTurnKillReason(turn: { exitCode: number; stderr?: string; stdout?: string }): ProviderTurnKillReason {
  const text = `${turn.stderr ?? ""} ${turn.stdout ?? ""}`;
  if (text.includes(STALLED_FIRST_ACTIVITY_MARKER)) return "STALLED_FIRST_ACTIVITY";
  if (turn.exitCode === 124 || /timed out|timeout/i.test(text)) return "DEADLINE";
  return "ERROR";
}

/** True when the settled text carries the stall marker (used to widen existing timeout classifiers). */
export function isStalledFirstActivityText(value: string): boolean {
  return value.includes(STALLED_FIRST_ACTIVITY_MARKER);
}
