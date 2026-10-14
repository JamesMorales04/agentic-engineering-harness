# Convergence — L1 ACCEPT+merged, wire R3→R4 — 2026-10-14B

## L1 R6 ACCEPT (agent `57098e44`, commit `2051138`) → PR #173 MERGED

- Delta-only review: 23 impl + 24 test lines, no deletions; version:2 probe fails closed
  (CONFIG_UNRESOLVED); valid trees resolve; 41/41 focused. No findings.
- PR #173 CI: 14/14 SUCCESS (incl. Pact). Merged 2026-10-14 → `9fdb753`.
- FAM-WIRE-adjacent L1 gate now in main: 12 checks, adversarial-PROOF E, STALE_DIST binding,
  consumer-aware C1/C2, A3 defaultArgs, F fail-closed, CONFIG_UNRESOLVED layer validation.
- Worker worktrees removed; `fix/l1-preflight-gate` branch kept until post-merge cleanup.

## Wire R3 REJECT (agent `2bb15830`, commit `6aff0d1`) → repaired in `0e4151d` (PR #174)

- P1 (fallback unimplemented): `outputStrictChannelSchema(name)` added — root-anyOf strip
  only; wired SOLELY at `agentPrompt.ts:896` executeCodex Codex `--output-schema`.
  Paseo launch/continue, MCP inputSchema, provenance digest deliberately unchanged
  (documented reasons: unproven strictness; digests must cover gated schema).
- P2 (null-widened infers): `.nullable().optional()` → `z.preprocess(null→undefined)` for
  formalizationNeed/Reason + exceptionType; type-level + runtime round-trip tests.
- Worker `d821c42b` (archived): typecheck clean, focused 36/36. Full unit 2604/50fail —
  worker ran an UNMARKED `npx vitest run` (env-false class: paseo isolation, openspec
  binary, hygiene); CI on #174 (fresh build, proper env) is the arbiter, not this number.
- R4 review `92c93775` running: projection-diff proof, strict-sink exclusivity (refute with
  any strict channel still receiving root-anyOf), infer-type re-inspection, Zod receipt
  rejection. Prior settled findings frozen unless regressed.

## Supervision notes

- `permit ls` truncated IDs remain no-ops for allow; full IDs from inspect only. Transient
  pending entries may clear without approval — always re-verify before allowing.
- `paseo run --cwd` ignored; workers cd themselves. Reviewer CodexBash prompts: allow
  worktree create/remove + read-only probes inside assigned scope; deny anything else.
- Next: wire R4 verdict → resolve → CI green on #174 → governed merge → Phase E
  (FAM-WAVE/LIVE/MERGE, SKILLREF checker parity) using the merged L1 gate preventively.
