# Review rounds R4/R5 + P1a contract decision — 2026-10-14B

## L1 R4 REJECT (agent `104f2832`, commit `6043714`) — all 6 repaired in `1163bbb` (PR #173)

- H1 :886 spec READY sibling-{} vacuous → every-disjunct-safe rule (specBranchSafe/Qualifies).
- H2 :859 artifacts type unchecked → `type:object` required.
- H3 :917 reviewer FAIL findings unrequired → findings required in branch/then/top-level.
- M1 :1942 broken-topology fallback PASS → CONFIG_UNRESOLVED fail-closed (12th check).
- M2 :651 C2 SKILL.md-for-seeds → seed-skip per compiler split.
- M3 :1767/:1811 dirty-missing/probe-false-as-clean → explicit-boolean-dirty, probe-fail undefined.
- Worker `6b6e7f81` (archived): 40/40 focused, typecheck clean, real-tree 9/12
  (E/F STALE_DIST correct; G pre-existing product drift). R5 review `e28c12e6` running.

## Wire R2 REJECT (agent `f1cd9891`, commit `3dae474`)

- P1b nullable round-trip (planner enums, spec blockedBare, helper vacuity) → FIXED in `a59eaf0`:
  null in wire enums, helper enum-membership check, Zod alignment via
  `.nullable().optional()` + `z.preprocess(null→undefined)` (infer types unchanged),
  5 round-trip regression tests, non-vacuity proven read-only. 52/52 focused.
- P1a root-anyOf vs strict-root rule → INVESTIGATED, rule confirmed real (OpenAI docs +
  `openai-agents-python _ensure_strict_root`), restructure preserving exact payload shapes
  proven IMPOSSIBLE (cross-field implications need root composition; envelope/discriminator
  = shape break; schema-splitting breaks single-schema shipping).

## DIRECTOR DECISION — P1a documented deviation (Owner-visible, reversible, NOT silent)

Adopt explicit deviation: root-`anyOf` on exactly the 6 gate contracts (explorer,
spec-authoring, implementer, repair-result, reviewer, supervisor) is the SOLE documented
deviation from OpenAI strict-root. FAM-WIRE invariant (wire carries every deterministic
gate) holds; Zod is the authoritative second layer; strict channels serve base
`type:object` without the gate branch. Implemented purely additively in `6aff0d1`
(+104/−0: STRICT_DEVIATION record comment + deviation-surface pin test asserting anyOf
ONLY at root of the 6, branches otherwise strict-legal; nested semantic-assessment anyOf
carved out as strict-legal). No shape/Zod/gate changed. R3 review `2bb15830` explicitly
judges the decision (ACCEPT the deviation or REJECT with a feasible shape-preserving
alternative). If Luna rejects the deviation itself, the decision returns to the Owner
with both positions recorded — no silent downgrade either way.

## Standing notes

- CI on #173/#174: 12 SUCCESS + Pact in-progress at last check, 0 failed.
- `paseo run --cwd` is IGNORED (agent cwd = caller checkout); workers cd themselves.
  Permission flow unchanged: full-ID allows, assigned-worktree scopes only.
