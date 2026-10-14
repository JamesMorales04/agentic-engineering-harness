# Root-Cause Family Register — 2026-10 Deep Audit Campaign

Convention: each family states the violated invariant, proven members, scope (proven/likely/unverified),
the shared-primitive repair direction, and status. No speculative members without code evidence.

## FAM-HERMETIC — Hermetic toolchain propagation [DONE: PR #169 merged 2026-10-14]

- Invariant: controller-input bins reach every nested controller; per-turn (model-influenced) env never injects bins (src/utils/process.ts trust docs).
- Members (proven): F-A nested `aeh` loses marking (runChild scrubbed var, snapshot empty → grandchild 127; fixed by re-emitting EXPLICIT `options.toolchainExtraBinPaths` only, src/utils/process.ts:375-383 + runner.ts:54,59 threading `controllerStartupExtraBinPaths()`); F-B sastEvidence missing-tool test mutated ambient PATH (rewritten to explicit `[]`); F-C no-prefix test didn't neutralize ambient marking (explicit `[]` + save/restore + new re-emit/decoy regression).
- Environment precondition (local dev): export colon-joined `AEH_TOOLCHAIN_EXTRA_BIN_PATHS` (as ci.yml:287) OR rely on system-dir node. CI unaffected.
- Regression: managedChildEnvScrub (9), sastEvidence (9), evals/corpus (5). Full unit green. Luna ACCEPT, 13/13 CI.

## FAM-ROUTE — Delegation-floor divergence [OPEN]

- Invariant: one deterministic delegation floor (decision-mechanism invariant).
- Members (proven): `requiresDelegatedPlanningV1` (routingV2.ts:49-67) vs `triageChange` (triage.ts) vs `createRoutedContract` floor (contract.ts:21,55-69) disagree on 1<files≤5 + expectedWorkUnits>1; `expectedWorkUnits` threaded by NOBODY; DIRECT-sealed change that planner splits has no escalation (waveExecutor.ts:192-193 skips planning for DIRECT; specEscalationConstraintV1 only on DELEGATED). Ledger AEH-V2-0128 residual.
- Repair: single-source the floor; thread expectedWorkUnits; deterministic post-plan re-triage or fail-closed DIRECT-multi-unit escalation + refusal test.

## FAM-PROMPT — Dual planner prompt paths [OPEN]

- Invariant: one canonical participant prompt carrying frozen authority.
- Members (proven): canonical buildPlannerPrompt (change.ts:815-836) vs impoverished waveExecutor.ts:1179 used at waveExecutor.ts:201 in runTask path → plans without read-root lease and weakened declaration channel.
- Repair: delete/delegate the variant to the canonical builder; gate executePlannerWaves on frozen roots + parity test.

## FAM-REACH — Validator-requirement reachability [OPEN]

- Invariant: every downstream deterministic validator requirement reaches the upstream participant that must satisfy it.
- Members (proven): contractValidationRequirementsV1/merge (validationRequirements.ts:110,155) never imported in waveExecutor.ts:56; blueprint uses plan-only requirements (:259,586 → participantPlan.ts:177); downstream run.ts:1468-1480 merges contract+impact and the oracle rejects what the blueprint never contained (AEH-V2-0099 class). Advisory drops narrow silently (:267-273).
- Repair: compile contractDerived+merge+impact BEFORE compileWaveExecutionBlueprint; blueprint ⊇ oracle inputs; durable drop events + propagation test.

## FAM-CEIL — Preset↔ceiling drift [IN REPAIR: Wave-3A branch fix/preset-ceiling-coherence]

- Invariant: participant construction deterministic; ceilings authoritative.
- Members (proven): (a) supervisor `shell:allow` vs toolPack without command-execute with canExecute:true — triple incoherent, no supervisor-shell gate; (b) planner/reviewer presets granted Spec-Manager seed skill `acceptance-traceability` outside maxCapabilities; (c) `high-assurance` specialization not in Reviewer specs, failing open.
- Repair (Wave-3A, Director-verified): preset deny + profile canExecute:false + max minus execute + deterministic supervisor gate mirroring reviewer gate; cross-role grants removed except Reviewer promotion of acceptance-traceability (proven consumers: harness-reviewer, promptPolicy.ts:28-30); `high-assurance` registered + unknown-specialization fail-closed; shared `presetSkillCeilingIssue`/`isCanonicalSeedSkill` primitive consumed by compiler validateReferences. A1 safety proven (§9 of record). Pending: rebase onto post-#169 main, Luna review, PR.

## FAM-SKILLREF — Skill reference resolution split [IN REPAIR: Wave-3A core done; checker parity follow-up pending]

- Invariant: one skill identity authority.
- Members (proven): default skillRoots all absent in source (ships skills/); 8 preset refs unresolvable under filesystem-only validation (compiler.ts:54-60 vs seed IDs).
- Repair (Wave-3A): compiler accepts canonical seed IDs + filesystem SKILL.md; strictness kept (unknown-in-both fails); shipped default preset validates ok:true. Roots intentionally unchanged (assets.ts:35-38 consumer-materialized; config union semantics — C1 all-must-exist contradicts codebase). Follow-up: L1 gate needs consumer-aware root evaluation + seed parity (frozen checker still reports C1/C2 RED).

## FAM-WIRE — Wire-schema/validator-schema divergence [OPEN; Wave-3B next]

- Invariant: provider-constrained schema carries every deterministic coherence gate.
- Members (proven): zod superRefine gates with NO JSON-schema counterpart — reviewer (:208-223 vs :319), supervisor (:237-248 vs :323), planner/explorer non-vacuous (:63-71/:98-113 vs :298-299), spec READY (:146-158 vs :301). Late rejection via repair turns.
- Repair: mirror gates into provider-facing JSON schemas (strict-compatible); repair-turn stays schema-enforced. L1-E must check semantic equivalence, not tokens (Luna REJECT finding).

## FAM-EVID — Lane evidence binding gaps [OPEN]

- Invariant: evidence binds the exact executed command/provider/candidate.
- Members (proven): verifyProviderLaneEvidenceV1 (laneEvidence.ts:256-279) never compares commandDigest (run.ts:1729,:1865 pass no command); capabilityCatalog admits architecture/policy/command with no adapter mapping (registry.ts:51-76 → UNSUPPORTED_VALIDATION_CAPABILITY, fail-closed but possibly unsatisfiable).
- Repair: verify commandDigest+provider at consumption; publish normative adapter matrix or reject kinds at authoring. L1-F must trace parameter flow, not snippet proximity (Luna REJECT finding).

## FAM-WAVE — Wave workspace sharing [OPEN]

- Invariant: parallel writers isolated.
- Members (proven): `worktreeIsolation` partially consumed (lease keys, clamp) but wave Implementers share input.root FS; off-patch writes diff-observed only (assembler.ts:345-347); barrierValidation===false skips barrier invisibly.
- Repair: per-unit candidate worktree (DIRECT pattern + wave-base receipt) or specified single-writer serialization surfaced in plan.ready/Home assurance + hostile E2E.

## FAM-MERGE — Merge authority gap [OPEN]

- Invariant: model reasoning cannot grant authority.
- Members (proven): github.pull-request.merge absent from human-required enumeration (actionPolicy.ts:68-71); merge.ts:27-44 trusts caller identity/risk.
- Repair: enumerate merge or document independent-review sufficiency; derive identity/risk from frozen records.

## FAM-LIVE — Participant liveness [OPEN]

- Invariant: bounded turns; watchdog distinguishes progress from stall.
- Members (ledger-carried, confirmed present): AEH-V2-0132 no per-participant deadline; AEH-V2-0133 superseded repair identity; AEH-V2-0119 mitigations present but no reviewer-turn liveness.
- Repair: per-participant wall-clock bound via watchdog; attempt-chain-aware accounting.

## FAM-DELIV — Delivery testability [UNBLOCKING]

- gh auth present 2026-10-14; browsers + UI build provisioned. Remaining: token-gated delivery E2E; Home projection fidelity (empty skills/tools, generic summaries, no barrier/supply-chain status).

## L1 gate status (branch fix/l1-preflight-gate @75eeae8)

9 RED on v0.25.5 (A1,A2,B,C1,C2,D1,E,F,G). Luna REJECT → repair round: A1 review/validate ceilings; E semantic equivalence; F parameter-flow tracing; assessor dedicated nonparticipant check (per permissions.ts:55-61); path typo. C1/C2 checker parity with new compiler behavior follows Wave-3A merge.

## Priority for the Home experiment

Wave 3A (preset/ceiling — done, pending rebase+review+PR) → Wave 3B (wire parity product) + L1-repair (gate) → Wave 3C (lane binding/adapters) + FAM-PROMPT/REACH/ROUTE → Wave 4 (FAM-WAVE/LIVE/MERGE as Home-path requires) → L4 probes → L5 chartered experiment.
