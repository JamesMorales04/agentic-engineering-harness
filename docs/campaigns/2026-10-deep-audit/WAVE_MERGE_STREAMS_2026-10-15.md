# WAVE + MERGE streams dispatched — 2026-10-15 (early session)

## LIVE-A turn bounds — PR #176 MERGED (R8 ACCEPT, no findings)

- `466f834` (30m/15m/5m deadlines + typed terminals + stall discrimination + config keys).
- R1 REJECT (P1a race not bounding active wait; P1b lease-before-recency; P2a participant
  key shadowed; P2b classifier uncalled) → `d2352c3`.
- R2 REJECT, single P1 (race unconditional + no wait-start producer) → gated watch +
  mid-turn waitStartedAt capture.
- R3 REJECT, single P1 (no timer at all after race deletion; conversion-time stamping) →
  deferred-armed watch + earliest-marker preference.
- R4 REJECT (isPending hardwired false; sdk.run path + post-activity window miss) →
  live-signal wiring + notePendingStart in watch polls.
- R5 REJECT (stale global tracker contaminates later clean turns; __test exports) →
  clear-on-every-terminal-settle + hook deletion.
- R6 REJECT (stop-error bypass; native __test remainder) → try/finally + repo-wide hygiene.
- R7 REJECT (hygiene regex misses multiline exports) → Director test-only micro-fix.
- R8 ACCEPT on final head; CI 14/14 → PR #176 MERGED.
- Exact intermediate SHAs: see PR #176 commit history (authoritative). FAM-LIVE fully
  closed (streams A + B). AEH-V2-0132/0133 addressed with preventive tests.

## WAVE live gate — PR #177, worker `36666c9e` done, review running

- `fbd4ce4` (rebased onto 3d8f3e4): snapshotWaveWorktreeV1 + checkWaveWorktreeOffPatchV1 +
  OFF_PATCH_WRITE_DENIED terminal/event/receipt; assembler diff gate retained;
  comments updated; 3-test adversarial suite. Focused 14 green; full 2648/2fail
  (corpus env + isolation flake, both triaged unrelated).
- Luna review `9e84c64b` running (enforcement-path trace, compliant-write pass,
  write-revert bypass, isolation:false behavior).

## MERGE sufficiency pin — PR #178, worker `e4580478` done, review running

- `a9cf549` (rebased onto 3d8f3e4): MERGE_AUTHORIZATION record (option (b)) +
  6 pins in tests/mergeSufficiency.test.ts (57/57 focused incl. actionPolicy/prReview/
  gatedAction/deliveryFinalize). Full 2652/1fail (corpus env).
- Product finding handled per instructions (no behavior change): literal high-risk
  RISK_GATED auto-merge correctly BLOCKED (prReview.ts:403-405); sufficiency pinned via
  AUTO_MERGE+high-assurance and RISK_GATED+low-risk; stale→STALE; double-exec→
  ALREADY_COMPLETED.
- Luna review `b9303ca8` running (doc-only diff proof, pin truthfulness, no overclaim,
  boundary consistency).
