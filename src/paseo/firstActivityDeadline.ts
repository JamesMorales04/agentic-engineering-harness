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
 * BOUND JUSTIFICATION (all numbers verified in-tree):
 * - Provider turn hard cap: 30min (`providerTurnDeadlineMs` default
 *   30*60_000; templates/project.yaml, src/architecture/executionIdentity.ts,
 *   src/paseo/launchSpec.ts). Hard caps are unchanged; this bound only
 *   terminates strictly earlier (20min < 30min).
 * - Deepest bounded semantic reasoning: STANDARD/DEEP map to medium/high
 *   thinking with at most 12k input tokens and a 300s model deadline
 *   (src/semantic/assessment.ts `boundSemanticThinkingOptionV1`,
 *   `semanticModelDeadlineMsV1`, `semanticCapabilityPolicyV1`); observed
 *   LIGHT turns settle in 2-6 minutes. 20min is 4x that ceiling.
 * - Production workhorse (Muse via OpenCode) carries no thinking variant,
 *   so it runs provider-default reasoning; xhigh thinking is reserved for
 *   the Luna brain lanes, which never show the zero-activity signature.
 * - Explorer/Planner/Reviewer turns are read-only discovery and emit tool
 *   calls within seconds; any tool call or stream output satisfies the
 *   bound, so legitimate slow turns with steady output are never killed.
 */

export const PROVIDER_TURN_DEADLINE_MS = 30 * 60_000;
export const FIRST_ACTIVITY_DEADLINE_MS = 20 * 60_000;
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
