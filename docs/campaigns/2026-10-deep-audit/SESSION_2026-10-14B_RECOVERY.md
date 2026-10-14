# Session checkpoint — 2026-10-14B (new Director: recovery + orchestration certification)

Continues campaign `2026-10-deep-audit`. Previous session record: `CAMPAIGN_RECORD.md`
(@a495a93) + `FAMILY_REGISTER.md`. This file is new-session provenance; it does not
rewrite history.

- Director: OpenCode `opencode-go/muse-spark-1.3-contributor`, thinking xhigh.
  Paseo session `4c707727-6087-4ead-ab91-8d2b2f8d233c` (running, cwd = repo checkout).
- Started: 2026-10-14 ~15:20 UTC. Owner directive: eliminate orchestration babysitting,
  recover durable state, continue backlog (no fresh generic audit, no immediate L5).

## 1. Verified repository state (all re-checked, not assumed)

| Ref | SHA | Note |
| --- | --- | --- |
| `origin/main` | `b9b7180` | v0.25.7 (includes merged #169 FAM-HERMETIC + #170 FAM-EVID) |
| local `main` | `99141e4` | STALE (v0.25.5); `origin/main` is authoritative. Do NOT use local main as base. |
| `campaign/2026-10-deep-audit` | `a495a93` | local == remote. Worktree: `/tmp/aeh-campaign` (this checkpoint). |
| `fix/planning-coherence` (#171) | `c8047a5` | local == `origin/...`. 2 commits on `b9b7180` (f59add4 + c8047a5 LOW fix). CI green, MERGEABLE/CLEAN. |
| `fix/preset-ceiling-coherence` (#172) | `ae61663` | local == `origin/...`. 5 commits. CI green, MERGEABLE/CLEAN. |
| `fix/l1-preflight-gate` | `598fd39` | Was LOCAL-ONLY → pushed to origin this session (backup). Base predates #170; needs rebase + Luna-round-4 repair. |
| `fix/wire-schema-parity` | `dba4ed8` | Was LOCAL-ONLY → pushed to origin this session (backup). Base `591f79c`; needs rebase + strict-compat decision. |
| main checkout | `7f3e1ac` on `fix/lane-evidence-binding` | Clean tree. Branch already merged via #170; checkout position harmless. No worktrees besides `/tmp/aeh-campaign`. |

- PR #170 is MERGED (prompt brief was stale in calling it open). #169 merged. No regressions to redo.
- `docs/campaigns/` exists ONLY on the campaign branch (absent on product branches — expected).
- Toolchain marker: `export AEH_TOOLCHAIN_EXTRA_BIN_PATHS="$HOME/.local/bin:$(mise bin-paths | paste -sd: -)"`
  (colon-joined, per ci.yml). Unmarked runs produce env-false failures; do not misread as regressions.

## 2. Old Luna reviewer verdicts recovered (all idle, identities verified codex/gpt-6-luna/xhigh)

| Agent | Scope | Verdict |
| --- | --- | --- |
| `baeb2257` L1 R3 (`598fd39`) | L1 redesign | REJECT: 2 HIGH (E vacuous PASS on 5 adversarial schemas; stale-`dist` trust gap), 3 MED (C1/C2 false REDs; A3 runtime-defaultArgs; F text fallback) |
| `4c7aad73` wire final (`dba4ed8`) | wire reshape | REJECT P1: branches still not OpenAI-strict (optional keys outside `required`: repair-result 0/5, implementer 7/9, reviewer 4/5, supervisor 7/8). Needs contract decision, not silent fix. |
| `aca4aac` W3A diversity (`fc2d02d`) | exact-search repair | ACCEPT scoped (boundary caveat: `runReviewLifecycle` relies on `core/run.ts` gate). Hardened by `ae61663`. |
| `41e76f0` W3A (`8ce5c50`) | greedy repair | REJECT P2 (diversity-vs-greedy) — SUPERSEDED by `fc2d02d`. Historical only. |
| `2ac46162` planning (`761bf9f`) | PR #171 | ACCEPT + 1 LOW (RUN mislabel) — fixed by Director in `c8047a5`. |

Freshness gaps requiring Luna DELTA re-review before merge:
- #171 head `c8047a5` = rebased `f59add4` (≈ reviewed `761bf9f` content, SHA changed by rebase) + unreviewed LOW fix.
  Verify `f59add4` ≡ `761bf9f` content + review `c8047a5` delta.
- #172 head `ae61663` = ACCEPTed `fc2d02d` + unreviewed hardening assert. Review `ae61663` delta.

## 3. Orchestration certification (Phase B — PASS)

- Worker route: `paseo run -d --provider "opencode/opencode-go/muse-spark-1.3-contributor" --thinking low`
  → agent `50aed69b`, running → idle, correct read-only output, archived. No permits needed.
- Reviewer route: `paseo run -d --provider "codex/gpt-6-luna" --thinking xhigh`
  → agent `8d29a53d`, running → idle, correct 3-bullet summary, archived. No permits needed.
- Failure modes mapped: mis-composed model ID → instant `error` (`Model not found`);
  direct `opencode/muse-spark-1.3` → 401 `Invalid credential` after retries (credential covers
  only the `opencode-go/*` route for this host).
- Auto-parenting verified (`ParentAgentId` = Director session). `wait --timeout`, `logs --tail`,
  `permit ls --json` (empty), exact-ID `permit allow` syntax, `archive` cleanup all exercised.
- Failed smoke agents (`35402707`, `0a538d3a`) archived after log preservation. Zero residue.
- Runbook: `RUNBOOK_PASEO.md` (this branch). Next Director must not re-ask the Owner.

## 4. Active agents / permits / blockers

- Active Paseo agents owned by this session: none (smoke agents archived).
- Pending permission requests: none (`permit ls` empty).
- Old campaign agents (`baeb2257`, `aca4aac`, `41e76f0`, `4c7aad7`, `2ac46162`): idle, verdicts
  extracted above. To archive after this checkpoint is pushed.
- Blockers: none for Phase C. Owner authority NOT needed until: PR merges (if delivery policy
  requires human approval — verify gate), self-hosting charter (L5), any policy weakening.

## 5. Next actions (in order)

1. Push this checkpoint + runbook (campaign branch).
2. Phase C: dispatch Luna DELTA reviews for #171 (`c8047a5` vs `761bf9f`) and #172 (`ae61663`
   vs `fc2d02d`); verify `f59add4` ≡ `761bf9f`; check delivery-policy merge requirements
   (IndependentPullRequestReview gate); merge if ACCEPT + green + authorized.
3. Phase D: rebase L1 + wire branches onto current `origin/main`; repair per REJECT findings
   (E adversarial-PROOF checks, dist-binding, C1/C2 consumer-aware roots, strict-compat contract
   decision); full Luna re-review; PRs.
4. Phase E: FAM-WAVE / FAM-LIVE / FAM-MERGE + SKILLREF checker parity; L1–L4 gates; then L5.
