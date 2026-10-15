# Certification sweep findings — build staging + L1-E — 2026-10-15

## Build staging self-dirties the tree (FOUND + FIXED, PR #179 MERGED)

- `scripts/build.mjs:13` stages at `<root>/.aeh-build-<pid>-<uuid>` BEFORE the
  build-identity dirty probe (`:167`, `git status --porcelain --untracked-files=normal`).
  `.gitignore` did not cover `.aeh-build-*` → every local build recorded `dirty:true`.
- Consequence: L1-E/F failed closed with STALE_DIST on every locally built tree
  (dist 0.26.0/a59a664-dirty vs source). Fail-closed = safe direction, but the gate
  was unusable locally.
- Fix (Director, 2 files): `.gitignore` += `.aeh-build-*/` + buildHygiene pin.
  Luna review ACCEPT (check-ignore verified, pin fails-without-line proven).
  PR #179 CI green → MERGED.
- After fix + clean rebuild: L1-F genuinely PASSES. L1-E still FAIL (see below).
- Related discipline note: worktree `dist`/`node_modules` SYMLINKS show as `??`
  untracked (trailing-slash gitignore entries don't cover symlinks), so worktree
  builds always record dirty → STALE_DIST. CI (fresh, no symlinks) is the arbiter
  for worktree-built branches. Do not chase this locally.

## L1-E reviewer-coherence (FOUND, repair in flight, PR #180)

- With clean dist, L1-E reports exactly one missing gate: reviewer-coherence.
  Checker expectation requires `properties.verdict` to carry explicit `type:string`;
  wire schema declared verdict as bare enum (semantic FAIL-findings gate present).
- Repair (worker `af329af4`, archived): explicit `type:string` alongside enums at 3
  reviewer verdict sites (top + both anyOf branches), wire-only, Zod untouched.
  All 5 gates HOLD at source level; +1 regression test; 79/79 focused (strict,
  crossfield, preflight); tsc clean; full-unit failures triaged pre-existing/env.
- PR #180 opened; Luna review `968f61fd` running (diff minimality, no-narrowing
  probes, checker-expectation sweep for further bare-enum gaps).
- L1-G (adapter coverage) remains FAIL: pre-existing product drift
  (architecture/policy unmapped), documented across rounds, out of scope.
  Owner-visible residual, not a gate regression.

## Stash audit (pending)

5 orphaned stashes on deleted branch `fix/l1-preflight-gate` (previous campaign):
preflight-preserve-race, preflight-only-preserve-for-l1, wire-parity-wip-on-wrong-branch-preserve,
wip-l1-preflight-gate-before-wire-schema-parity, pre-branch-stash. Branches merged;
inspect contents before dropping. NOT blocking deliveries.

## /tmp hygiene (new finding)

Thousands of stale `/tmp/aeh-*` dirs (toolchain/workspace/validation-evidence/
stall-migrate/tagdetect + orphaned reviewer worktrees). Test runs leak temp dirs.
Cleanup scheduled at a quiet point (no blind rm while agents active). No product
repair — record + sweep.
