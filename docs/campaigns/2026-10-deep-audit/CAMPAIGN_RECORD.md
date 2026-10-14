# AEH Deep Functional Audit & Stabilization Campaign — Campaign Record

Campaign ID: `2026-10-deep-audit` (new orchestration session; prior conversation lost, OS reinstalled).
Started: 2026-10-14 (UTC). Director: OpenCode `muse-spark-1.3` (xhigh).
Repo: `https://github.com/JamesMorales04/agentic-engineering-harness`
Checkout: `/home/james/Escritorio/Development/agentic-engineering-harness`
Record location: branch `campaign/2026-10-deep-audit` (tracked + pushed; see durability note §10).

## 1. Recovered revision (verified, not assumed)

- At campaign start: local HEAD = `origin/main` = `99141e4` = tag `v0.25.5`.
- `git ls-remote origin HEAD` matched. Last known reference (v0.25.5 thru PR #168) CONFIRMED current.
- Since: PR #169 (FAM-HERMETIC) MERGED → `origin/main` = `2e95baf` (2026-10-14).
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
| L1 static gate (Wave 2) | deterministic preflight detects config/contract drift | scripts/preflightL1.mjs, tests/preflightL1.test.ts, package.json preflight:l1 (branch fix/l1-preflight-gate @75eeae8) | self-tests 10/10; 0.17s; real tree 9 RED (intentional) | Luna xhigh via Paseo — REJECT (3H: A1 misses review/validate ceilings; E token-matching; F equality unproven. 1M: assessor needs dedicated nonparticipant check. 1L: path typo) | none | IN REPAIR (round dispatched 2026-10-14) |
| Wave-3A preset/ceiling coherence (branch fix/preset-ceiling-coherence, uncommitted) | ceilings authoritative; least privilege | presets/agents/default.jsonc, src/participants/{roles,skills,index}.ts, src/agents/{compiler,permissions}.ts (+2 fixture migrations) | typecheck clean; 14 new tests; 0 regressions (rebase+reverify pending) | Luna PENDING | none | DIRECTOR-VERIFIED (see §9) |

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

## 11. Preflight certification matrix

- L1 static/config audit: gate built (9 RED on v0.25.5; repair round in flight). STATUS: RED→repair.
- L2 deterministic unit/contract: full unit green post-#169 (marked). STATUS: GREEN (marked).
- L3 integration/lifecycle: scenario/adversarial/concurrency/human suites. STATUS: pending (CI green on #169 implies hosted L3 green for that SHA).
- L4 controlled real-provider probes: structured-output probe, assessor completion, reviewer turn. STATUS: pending.
- L5 full governed Home experiment (isolated, chartered). STATUS: blocked until L1–L4.
