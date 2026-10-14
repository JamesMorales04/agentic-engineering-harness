# Phase D interim — 2026-10-14B (L1 + wire repairs implemented, re-reviews pending)

## Supervision correction (Owner-directed, applied)

- Truncated `permit ls` IDs (`per_13b1`) are NO-OPS through `permit allow` (CLI reports
  "allowed", exit 0, request persists). Exact approval REQUIRES the full request ID from
  `paseo inspect <agent> --json` → `PendingPermissions[].id` (e.g. `per_13b153d9e001b…`).
- Verified pattern: full-ID allow → request gone → worker advances exactly one gated op →
  new full ID. Each approval buys one operation; poll-verify every ~55s, no long sleeps.
- Scope check per request via `permit ls --json` description (must stay inside the
  assigned worktree); read-only `src/*` investigation for assigned findings is authorized.
- Root causes for runbook: (a) workers spawned with Director-checkout cwd, so worktree ops
  are `external_directory`; future workers get `--cwd <assigned-worktree>`; (b) Director
  pre-creates node_modules/dist symlinks deterministically before dispatch.
- No bypass mode, no global allow, no over-scope approvals. ~25 exact-ID approvals, all
  `/tmp/aeh-w-l1/*` or `/tmp/aeh-w-wire/*`.

## L1 preflight (worker `667129ea`, archived) — `fix/l1-preflight-gate` → `6043714`, PR #173

- Rebased `598fd39` onto `origin/main` (`f6b3d83` v0.25.8 at the time), force-with-lease pushed.
- All 5 R3 findings repaired in `scripts/preflightL1.mjs` + `tests/preflightL1.test.ts`:
  H1 required-membership + vacuous-branch rejection (5 adversarial tests); H2
  `checkDistBindsSource` with STALE_DIST fail-closed; M1 consumer-topology + compiler-parity
  C1 (C1/C2/A2 now genuine PASS); M2 runtime defaultArgs incl. @alias; M3 F fail-closed.
- Focused 34/34, typecheck clean, full unit 2575/11skip/1fail (`evals/corpus` — Director
  verified it PASSES on the main checkout with native dist: worktree symlinked-dist artifact,
  CI (fresh build) is the arbiter).
- Luna full re-review R4 dispatched (`104f2832`, commit pinned): own-adversarial + STALE_DIST
  + C1/C2/A2 + A3 + F verification requested.

## Wire parity (worker `d7428a4d`, archived) — `fix/wire-schema-parity` → `3dae474`, PR #174

- Rebased onto `origin/main`, force-with-lease pushed (2 commits: `2b88e7d` strict reshape +
  `3dae474` pin migration).
- Strict decision: required ⊇ properties on every object/branch (Zod-optional → nullable);
  Zod untouched/authoritative. Coverage table: all branches 100% (e.g. repair-result 0/5→5/5,
  planner 5/9→9/9). New assertion 72 violations pre-repair → 0 (non-vacuous, read-only proven).
- 2 stale pins migrated in-family (plannerScopeDeclaration:132, scale-governance:180).
  Targeted 47/47; full unit 2557/1fail (same corpus env artifact; isolation flake not recurred).
- Luna full re-review R2 dispatched (`f1cd9891`, commit pinned): independent enumeration +
  strict-subset + no-narrowing probes + pin-migration verification requested.

## Pending

Luna verdicts → resolve findings → verify CI on #173/#174 → governed merge → Phase E
(FAM-WAVE/LIVE/MERGE, SKILLREF checker parity) with L1 gate as preventive control.
Worker worktrees `/tmp/aeh-w-l1`, `/tmp/aeh-w-wire` removed after push (branches persist).
