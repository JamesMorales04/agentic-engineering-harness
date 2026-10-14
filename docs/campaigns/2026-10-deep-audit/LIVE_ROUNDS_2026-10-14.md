# LIVE rounds — B merged, A converging — 2026-10-14B (late session)

## LIVE-B (attempt accounting) — PR #175 MERGED (`4d1977b`)

R1 REJECT (P1 no retry-parent edges; P2 cyclic grant) → `d8eedd2` (edge recording
paseo/direct/podman repair() + run.ts closures + reviewLifecycle remediation +
DFS gray/black + controller-path test) → R2 REJECT (P2 self-loop: link() dropped
parent===child) → `1f8260b` (self-edges recorded → GRAY revisit → undefined) →
R3 ACCEPT, no findings. CI 14/14. AEH-V2-0133 closed.

## LIVE-A (turn bounds) — PR #176, R3 review running

- `466f834`: 30m/15m/5m deadlines + typed terminals + stall discrimination + config keys.
- R1 REJECT (P1a race not bounding active wait; P1b lease-before-recency; P2a participant
  key shadowed; P2b classifier uncalled) → `d2352c3` (mid-turn race + wait-duration
  classification; recency-first; managedTurnDeadlineMs tightest-wins; workerTurnTerminalDetail).
- R2 REJECT, single P1: race unconditional (cuts clean turns, no provider cancel) + no
  wait-start producer. Other claims verified (P1b recency order, P2a 300s launch proof,
  P2b typed record, 8/8 + schema suites green).
- `12b71ad`: unconditional race DELETED; PERMISSION_WAIT_TIMEOUT fires only in settled
  approval-wait state (classifyReviewerTurnOutcome + wait evidence) → fenced +
  EXHAUSTED → BLOCKED_EXTERNAL; producer stamps waitStartedAt on PaseoSdkPermissionStop
  (permissionDiagnostic.ts + sdk.ts field); evidence-preference chain with source marking.
  R3 review `7e0cd15d` verifying the exact R2 probe pair + producer path + file necessity
  (sdk.ts/permissionDiagnostic.ts flagged for minimality check).

## Supervision notes (runbook additions)

- Deny uninspectable destructive execs (truncated `rm -rf` card) then perform the exact
  cleanup deterministically; notify the agent. Boundary preserved, no strand.
- Reviewer probe-edits in its private worktree are acceptable ONLY if reverted before
  verdict — verify `git status` clean + candidate == pinned SHA; require the verdict to
  disclose them (R2 did).
- Worker scope drift (B2: direct/podman/run/reviewLifecycle beyond receipt-writer sites)
  → immediate `paseo send` scope check demanding per-file necessity justification;
  reviewer re-verifies necessity per file at R2 (all tied to retry-spawn call sites).
