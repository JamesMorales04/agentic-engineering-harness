# Phase E scoping — WAVE/LIVE/MERGE vs main a59a664 — 2026-10-14B

Explorer `98bd0213` (Muse low, read-only, archived). #171–174 touched NONE of the
wave/liveness/merge core paths (one incidental 17-line strict-projection touch in
`agentPrompt.ts` by #174).

## FAM-WAVE: NARROWED

- "Parallel Implementers share one write root" REFUTED: per-unit `mkdtemp` git worktrees
  (`waveExecutor.ts:824-836`, DIRECT `direct.ts:150-166`), serial assembly under lock
  (`assembler.ts:386-390`), lease-key isolation (`providerLeaseWorkspaceKeyV1`),
  `worktreeIsolation:false` serializes (`waveConcurrencyV1 → 1`). Isolation predates v0.25.5.
- Residual OPEN: off-patch worker writes observed only through captured diff, never
  live-gated (`assembler.ts:334-347`, `binding.ts:60-71` — documented by design).
- Repair: deterministic live gate on the worktree path (launch snapshot → deny
  off-patch write/edit with `OFF_PATCH_WRITE_DENIED` receipt) + 2-unit adversarial test.
  No product-shape change; fail-closed.

## FAM-LIVE: STILL-OPEN (highest Home-path risk)

Constants verified: provider-turn 30m, first-activity 25m/poll 30s, semantic 300s,
progress/stall 15m, hard 8h, supervisor init 120s / turn 300s clamped, stall-retry 2/phase,
repair 2, review-remediation 6 rounds, watchdog poll 15s / wake 45s / retries [0,500,1500]ms,
wake budget 2+1/rev, validator default 900s.
Gaps (ledger AEH-V2-0132/0133/0134 open):
1. No per-participant wall-clock turn deadline (steady-output reviewer never trips stall).
2. Watchdog stall-vs-progress conflation (`livenessV2.ts:277` busy-child suppresses wake).
3. No reviewer-turn dedicated timeout (`reviewLifecycle.ts:472` inherits generic 30m).
4. Attempt accounting per-identity, not chain-aware (`participantAccounting.ts:17-31`).
5. Paseo permission-wait has no timer (post-hoc SYSTEM_FAILURE / prompt text only).
- Repair stream A (turn bounds): `participantTurnDeadlineMs` in provider-turn loop +
  review loop, stall-vs-progress discrimination, permission-wait short timer with typed
  `PERMISSION_WAIT_EXHAUSTED`. Stream B (accounting): chain-aware receipt resolution.
  Regression sketches in explorer report (40-min heartbeat reviewer, stalled+progressing
  pair, permission-prompt fixture).

## FAM-MERGE: NARROWED

- `github.pull-request.merge` absent from `requiredHumanActionAuthorizations`
  (`actionPolicy.ts:70-71`) — the ONLY open member, and it is the family's original
  stated decision (enumerate merge OR document independent-review sufficiency).
- Review-freshness REFUTED-as-fixed (head/policy/CI gates, `PR_REVIEW_STALE`,
  live-observation-only green). Double-apply REFUTED-as-fixed (intent+receipt dedupe,
  observation-grounded reconcile).
- Repair: (b) document Owner-delegated-policy sufficiency + pin test (merge succeeds
  with push/PR-create authorizations + frozen policy + fresh review + live gates;
  re-run same key → `ALREADY_COMPLETED`; rebase → `PR_REVIEW_STALE`). No silent option.

## Workstream order

1. LIVE stream A (turn bounds) — new branch, worker + Luna + CI + merge.
2. LIVE stream B (chain accounting) — parallel branch, same loop.
3. WAVE live gate + MERGE sufficiency pin — smaller, follow.
4. Then L1–L4 evidence sweep → L5 charter request (Owner HUMAN_REQUIRED).
