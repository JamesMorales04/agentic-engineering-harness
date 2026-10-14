# AEH Deep Functional Audit & Stabilization Campaign — Campaign Record

Campaign ID: `2026-10-deep-audit` (new orchestration session; prior conversation lost, OS reinstalled).
Started: 2026-10-14 (UTC). Director: OpenCode `muse-spark-1.3` (xhigh).
Repo: `https://github.com/JamesMorales04/agentic-engineering-harness`
Checkout: `/home/james/Escritorio/Development/agentic-engineering-harness`
Record location: branch `campaign/2026-10-deep-audit` (tracked + pushed; see durability note §10).

## 1. Recovered revision (verified, not assumed)

- At campaign start: local HEAD = `origin/main` = `99141e4` = tag `v0.25.5`.
- `git ls-remote origin HEAD` matched. Last known reference (v0.25.5 thru PR #168) CONFIRMED current.
- Since: PR #169 (FAM-HERMETIC) MERGED → `origin/main` = `2e95baf`, then release automation cut
  v0.25.6 (`591f79c` chore(release), release-only). Current `origin/main` = `591f79c`.
- Working tree during campaign: clean except mise env noise (`.config/mise/mise.lock` regenerated
  post-reinstall; NOT part of any repair — excluded from commits).
- Durable history recovered: `docs/ENGINEERING_LEDGER.md` AEH-V2-0001…AEH-V2-0135 (+S10/CI sections),
  `docs/CORE_ARCHITECTURE_V2_*.md`, S13/S14 evidence, `.harness/evidence/raw/`.

## 2. Campaign model separation (verified, no silent substitution)

- Director/orchestration: OpenCode `opencode/muse-spark-1.3` (exists; OpenCode + OpenCode Go creds present).
- Implementation/repair: OpenCode-natiave Task subagents (bounded, file-scoped).
- External independent reviewer: **Codex CLI via Paseo agents** (Owner direction 2026-10-14):
  `paseo run --provider codex/gpt-6-luna --thinking xhigh` — verified Provider=codex, Model=gpt-6-luna,
  Thinking=xhigh via `paseo inspect`. NEVER via OpenCode model dispatch.
- AEH internal routing (`.harness/agents.source.jsonc`, `@brain`, worker defaults, provider policies)
  unchanged by campaign. Reviewer agents archived after verdict (no residue).

## 3. Toolchain matrix (verified 2026-10-14)

mise 2026.10.8 (all tools pinned) | node 22.23.2 | python 3.13.15 / uv 0.12.18 | opencode 1.18.32 |
codex 0.156.1 (update available — do NOT upgrade mid-campaign) | paseo 0.9.1 daemon running
127.0.0.1:6767 (providers codex+opencode available) | podman 6.1.4 | serena-agent 1.6.1 |
headroom 0.28.0 (binary `headroom`) | trivy 0.70.0 | opengrep 1.22.0 | playwright 1.62.1 +
chromium installed 2026-10-14 (`~/.cache/ms-playwright`: chromium-1234, headless-shell, ffmpeg) |
ui/control-center builds (`npm run ui:build` green) | gh authenticated 2026-10-14 as JamesMorales04
(scopes: gist, read:org, repo, workflow; NO delete_repo — matches campaign disposition) |
git identity configured repo-local (JamesMorales04, noreply email) | engram/graphify/opa/cosign absent
(fail-closed by design; not blocking L1–L2).

## 4. Reproducible baseline (v0.25.5 + post-#169, this host)

- `npm run typecheck` — PASS. `npm run build` — PASS. `npm run ui:build` — PASS.
- Canonical local test command (mise-only hosts; colon-joined per ci.yml:287):
  `export AEH_TOOLCHAIN_EXTRA_BIN_PATHS="$HOME/.local/bin:$(mise bin-paths | paste -sd: -)"`
- v0.25.5 unmarked: 16 files / 40 failed (ALL environment: hermetic PATH lacks mise node;
  CI unaffected via setup-node system node). Marked: 3 failed → FAM-HERMETIC.
- Post-FAM-HERMETIC (marked): **356 files passed / 2483 passed / 11 skipped / 0 failed**.
- Wave-3A branch (pre-#169 base, marked): same 3 known FAM-HERMETIC failures + 14 new passing tests;
  zero regressions (rebase + re-verify required after #169 before PR).

## 5. Known OPEN product defects carried in (from ledger)

AEH-V2-0128 route/execution-policy reconciliation; AEH-V2-0129 worktreeIsolation FS gap (lease-key
isolation now exists; FS isolation missing); AEH-V2-0132 no per-participant deadline; AEH-V2-0133
superseded repair identity; AEH-V2-0134 provenance observation; AEH-V2-0110 escalation trigger;
AEH-V2-0111/0115/0126 formal authoring (round-12 source repair; live re-exercise pending);
AEH-V2-0130/0135 resource reconciliation (closure claimed 2026-09-30 — RE-VERIFY);
AEH-V2-0116 approval-prompt stops (SLICE_BLOCKED_DRIVER).

## 6. Owner decisions obtained

1. gh auth: Owner set up `gh auth login` (keyring) 2026-10-14. PR/delivery lanes unblocked.
2. Luna review execution: Owner directed Paseo-agent execution (not Director bash, not external).
   Implemented: `paseo run -d --provider codex/gpt-6-luna --thinking xhigh` + labels + archive after.
3. Token scope note: no delete_repo (matches Round-10 USER_CLEANUP_NON_BLOCKING disposition).
4. Pending (future): self-hosting charter for Home-change experiment on live checkout (request via
   HUMAN_REQUIRED when L1–L4 pass; never forge).

## 7. Audit summary (execution graph → Failure Map, domains A–I; 4 bounded agents, read-only)

- A/B (intake/planning): no direct-edit fallback (all launches requireExecutionAuthority);
  families FAM-ROUTE (0128 residual floor), FAM-PROMPT (dual planner prompts change.ts:815 vs
  waveExecutor.ts:1179), FAM-REACH (contract validators absent from blueprint), plus minor
  preflight intentDigest excludes profile; NONE-assurance info.
- C/E/F (participants/validation/review): ceilings intact for core roles; result-channel binding
  strong; lane attribution fail-closed; lineage choke intact; reviewer freshness verified.
  Families FAM-CEIL (supervisor shell, cross-role skills, unknown specialization), FAM-SKILLREF
  (skillRoots vs seed IDs), FAM-WIRE (zod gates missing from JSON schemas), FAM-EVID
  (commandDigest unverified; architecture/policy/command adapter gap), unconfigured-MCP fail-open.
- D/G/H/I (isolation/security/delivery/Home): scope/symlink gates fail-closed; workspace.create is
  controller-owned; push-only delivery fixed; merge is HYBRID. Families FAM-WAVE (shared-FS parallel
  race), FAM-MERGE (merge outside human-effect ledger), FAM-LIVE (0132/0133), FAM-DELIV
  (testability — browsers + UI build now unblocked; gh auth now present).
- Full detail: FAMILY_REGISTER.md (this branch).

## 8. Repair and PR ledger

| Family | Invariant | Files | Tests | Reviewer | PR | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FAM-HERMETIC (F-A/F-B/F-C) | controller bins reach nested controllers; per-turn env never injects | src/utils/process.ts, src/evals/runner.ts, tests/managedChildEnvScrub.test.ts, tests/security/sastEvidence.test.ts | typecheck clean; full unit 356f/2483t green (marked) | Luna xhigh via Paseo — ACCEPT | #169 MERGED (13/13 CI, 2e95baf) | DONE |
| L1 static gate (Wave 2) | deterministic preflight detects config/contract drift | scripts/preflightL1.mjs, tests/preflightL1.test.ts (branch fix/l1-preflight-gate: 5584f5f + repair f3b2cd2) | self-tests 14/14; 11 checks; real tree: A3/D2 PASS, rest RED (legit) | Luna xhigh via Paseo — REJECT then REPAIR (3H+1M+1L addressed); round-2 reviewer STALLED (74min, scope superseded) → STOPPED+archived; round-3 REDESIGN committed 598fd39 (object-graph E, behavioral F, A3 nativeAgent/args, 24/24 tests); FULL re-review DISPATCHED | none | AWAITING VERDICT |
| Wave-3A preset/ceiling coherence (branch fix/preset-ceiling-coherence @60a8551, rebased onto 591f79c) | ceilings authoritative; least privilege | presets/agents/default.jsonc, src/participants/{roles,skills,index}.ts, src/agents/{compiler,permissions}.ts (+2 fixture migrations + Director-added review:deny flips for supervisor/planner + ceiling test) | typecheck clean; full unit 2498 passed/0 failed (marked); repaired-L1 delta: A1/A2/A3/B/D1/D2 PASS, C1/C2/E/F/G RED (out of scope) | Luna review DISPATCHED 2026-10-14 (Paseo) | none | AWAITING VERDICT |
| Wave-3B wire parity (branch fix/wire-schema-parity: b6d0f53 + strict reshape dba4ed8) | wire schema carries deterministic gates | src/agents/outputContracts.ts, tests/contractCrossfieldGates.test.ts (+ strict-shape sibling suite) | Luna REJECT (P1 partial-branch strict shapes; P2 positive gaps) → REPAIR: full-object strict-legal branches, strict-shape suite over ALL contracts (fails pre-repair, green after), all-7 explorer + PASS+SAFE positives. Full unit 2498/0. Bonus: pre-existing strict-invalidity (missing required for optionals) reported, NOT silently fixed — needs contract decision | Luna FINAL re-review DISPATCHED (Paseo) | none | AWAITING VERDICT |
| Wave-3A-P2 specialization preservation (commit d902655 on fix/preset-ceiling-coherence) | high-risk review cannot silently downgrade | compiler.ts (selector match), routing.ts (shared matcher + required-specs helper), run.ts (candidate specializations), candidateAssurance (attest/filter/record + BLOCKED), reviewLifecycle (turn gate), 11 new tests | full unit 2509/0 (marked); targeted 55/55 | Luna REJECT-round2 (multi-spec ANY-match gap — Director backstop ruling was wrong) → collective-coverage repair 8ce5c50 (covering-set selection + round-union gate, 17 tests, full unit 2515/0); Luna REJECT-round3 (greedy+diversity BLOCKS valid cover) → exact-search repair fc2d02d (lexicographic covering set, pool cap, under-minimum rule, full unit 2521/0); FINAL re-review DISPATCHED | none | AWAITING VERDICT |
| Wave-3C evidence binding (branch fix/lane-evidence-binding @7f3e1ac: 5db8000 + s11/system-caller migration) | evidence binds executed command; declared capabilities resolvable | laneEvidence.ts, run.ts, providers/validation/registry.ts, validators/registry.ts, validationRequirements.ts, 4 unit test files + s11 script + system campaign test | Luna REJECT (P1: 3 system-test callers unmigrated — unit excludes tests/system; tsconfig excludes tests+scripts) → REPAIR by Director: digests traced to test-owned inputs; system file 3/3 green. Full unit 2487/0 | Luna DELTA re-review: ACCEPT, no findings | **#170 OPEN** (CI running) | PUSHED, IN CI |
| Wave-4 planning coherence (branch fix/planning-coherence @761bf9f) | one prompt, reachable validators, single floor | change.ts, waveExecutor.ts (canonical builder, variant deleted, frozen-roots gate, multi-unit refusal), contract.ts (shared helpers + expectedWorkUnits), routingV2.ts (directRouteMultiUnitBlockedV1), participantPlan/run.ts wiring, 3 planningCoherence test files | Director-verified: full unit 359f/2498t ZERO failures in isolated worktree (agent's 40-fail claim refuted as missing-marking env error); enforcement placed BEFORE DIRECT short-circuit; runPlanning fallback lease+prompt constrained (acceptable residual). Residual: operation-branch vs sealed-contract reconciliation (0128 core) posed as review question | Luna review DISPATCHED (Paseo 2ac46162); Luna LOW (RUN mislabel) fixed by Director in 8c3c5ee + kind test (full unit 2499/0) | **#171 OPEN** (CI running) | PUSHED, IN CI |

## 9. Director verification notes (Wave-3A A1 safety proof)

Feared: supervisor `canExecute:false` breaks runtime supervisor turns. Disproven by mechanism:
`requestedCapabilities` (executionLease.ts:260-267) derives leases from the SELECTION's permissions;
profile only caps via `assertRoleCapabilityCeiling` (:269-291). Supervisor preset now selects read-only
→ read leases issue; supervisor.ts:373 `requireExecutionAuthority:true` still satisfied.
Provider-lease acquisition (AEH-V2-0047) and `paseo.workspace.create` (controller.ts:1836,
handoff.ts:102) are controller-owned, never gated on the supervisor profile. Prompts forbid supervisor
shell (supervisor.ts:562; livenessV2.ts:609; agentPrompt.ts:1025). A2 promotion verified: consumers are
control-plane harness-reviewer (.harness/agents.source.jsonc:23) + promptPolicy.ts:28-30; seed comment
documents scope. Fixture migrations (2 files) are migrate-don't-shim compliant.

## 10. Durability note (incident 2026-10-14)

`docs/campaigns/` was created UNTRACKED and later deleted by a subagent sharing the working tree
(suspected `git clean`). Lesson: campaign records must be TRACKED + PUSHED promptly. This branch
(`campaign/2026-10-deep-audit`) is the durable home; push after every update. Standing rule for all
subagents: NEVER run `git clean`, never delete files outside the assigned file list, never touch
`docs/campaigns/`.

## 11. Worktree discipline (adopted 2026-10-14 after shared-tree stash incident)

Parallel implementation agents MUST use private `git worktree` checkouts (one branch per worktree),
symlink node_modules (+dist) from the main checkout, export the marking for tests, commit on their
branch from the worktree, and remove the worktree when done. Validated by Wave-3A-P2 + wire repairs
(no cross-contamination; `git worktree list` clean). Paseo Luna reviewers use branch REFs
(`git diff <base>..<branch>`) + private worktrees for execution; never checkout/stash/clean.

## 11. Preflight certification matrix

- L1 static/config audit: gate built (9 RED on v0.25.5; repair round in flight). STATUS: RED→repair.
- L2 deterministic unit/contract: full unit green post-#169 (marked). STATUS: GREEN (marked).
- L3 integration/lifecycle: scenario/adversarial/concurrency/human suites. STATUS: pending (CI green on #169 implies hosted L3 green for that SHA).
- L4 controlled real-provider probes: structured-output probe, assessor completion, reviewer turn. STATUS: pending.
- L5 full governed Home experiment (isolated, chartered). STATUS: blocked until L1–L4.
