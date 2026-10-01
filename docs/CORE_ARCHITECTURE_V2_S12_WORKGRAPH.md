# S12 — Observability and Engineering Evals WorkGraph

**Slice:** S12 — Observability and Engineering Evals
**Branch:** `core-architecture-v2`
**Base:** `9cdbbfe` (S1–S11 independently accepted and committed; clean tree)
**Normative target:** `docs/CORE_ARCHITECTURE_V2.md` (unchanged by this slice)
**Mechanism classification:** `DETERMINISTIC` throughout. Correlation derivation, identity verification, metric aggregation, export serialization, corpus loading, corpus digests, scoring, and the advisory-invariant guard are deterministic. No model output participates in any S12 decision or gate.

## Prerequisite verification (before implementation)

- S1 execution identity present and accepted: `src/architecture/executionIdentity.ts`, `src/operations/state.ts` (`CandidateRevisionV1`, `operationExecutionRevision`, `resolvedOperationPolicy.digest`, `controller.epoch`); S1 accepted earlier in the campaign.
- Existing telemetry surfaces: `src/telemetry/events.ts` (local NDJSON events), `src/telemetry/tracing.ts` (OTel spans/phases), `src/telemetry/otlp.ts` (optional OTLP/HTTP trace export), `src/paseo/trace.ts` (always-local Paseo NDJSON).
- Existing eval surfaces: `src/evals/runner.ts`, `scoring.ts`, `statistics.ts`, `fullStack.ts`, `types.ts`; eval CLI at `src/cli.ts` (`aeh eval run|compare|full-stack`), `src/entry.ts` (`aeh eval repeat|dashboard`); config/template `evals.corpusDir = evals/corpus`.
- Current gap reconstructed from the repository (not from the campaign prompt): (1) event/span payloads carry `taskId`/`operationId` but no candidate/revision/identity digest/execution revision/policy/epoch/participant/runtime-session correlation and no stale-attribution detector; (2) no metric instruments or local metric export exist; (3) `evals/corpus/` does not exist, the runner records no corpus identity, and no reproducibility check exists; (4) no local export verification lane; (5) no S12 machine evidence artifact; (6) no adversarial proof that eval/telemetry observations cannot influence policy, authority, acceptance, permissions, or routing.

## WorkGraph

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S12-W0 | Prerequisite verification, exact environment capture, this tactical WorkGraph | verification | LEAD_OWNED | accepted S1–S11 tree | prerequisites present; gap reconstructed from source |
| S12-W1 | Telemetry correlation identity contract: canonical operation/candidate/execution/policy/controller/participant/runtime/session keys, correlation digest, derive/verify/stale detection | implementation | LEAD_OWNED (contract freeze) | W0 | schema tests pass; wrong/stale candidate identity is detectable and rejected |
| S12-W2 | Candidate/execution-bound events and spans: central identity resolution in `recordEvent`, correlation in NDJSON envelopes and OTel spans, explicit mismatch marking | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1 | every emitted event/span of a bound operation carries current identity; supplied stale identity is marked and cannot be silently re-attributed |
| S12-W3 | Metric instruments and deterministic local export: counters/histograms for operation/participant/runtime/validation signals through the official OTel metrics SDK with a canonical local snapshot exporter; production call sites wired | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1 | real instruments exist; fixed scenario values are reproducible; export needs no credential |
| S12-W4 | Export verification lane: in-process loopback OTLP/HTTP receiver exercising the real `OTLPTraceExporter` payload with identity/correlation checks; deterministic file/NDJSON lane remains the credential-free default | verification | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W2 | payload identity/trace-id/parent correlation verified from the receiver; no hosted credential |
| S12-W5 | Versioned advisory eval corpus: committed manifest + cases + fixed fixtures + deterministic scenario harnesses over production deterministic subsystems; corpus identity digest recorded in results; runner reproducibility | implementation | LEAD_OWNED | W0 | corpus ships real cases; score/status reproducible; digest recorded |
| S12-W6 | Deterministic local campaign producing `docs/evidence/s12/` machine artifact binding candidate/build identity, the exercised scenario, trace/metric/export verification, correlation joins, eval reproducibility, and the advisory invariant | verification | LEAD_OWNED | W2, W3, W4, W5 | artifact is sanitized, machine-readable, reproducible, and lane-accurate |
| S12-W7 | Advisory-invariant adversarial proof: eval/telemetry outputs cannot mutate policy, authority, acceptance, permissions, or routing; no required acceptance gate consumes eval output | adversarial verification | LEAD_OWNED; independent read-only verification DELEGATED | W1, W3, W5 | static dependency proof plus behavioral invariance tests |
| S12-W8 | Documentation and evidence boundaries: STATUS / CONFORMANCE / LEDGER / OBSERVABILITY updates, lane separation, no REAL_PROVIDER or OTLP-hosted over-claim | documentation | LEAD_OWNED | W6, W7 | truthful evidence; `docs/CORE_ARCHITECTURE_V2.md` untouched |

### Frozen contract (W1)

`src/telemetry/identity.ts`:

- `TelemetryCorrelationV1` — version, operation id, candidate id/revision/source digest/identity digest, operation execution revision, policy digest, controller epoch, optional participant id/generation/role, optional runtime name/session id, optional build release/digest.
- `telemetryCorrelationAttributes()` — canonical `aeh.*` attribute keys.
- `telemetryCorrelationDigest()` — domain-separated SHA-256 over the defined canonical fields.
- `deriveTelemetryCorrelation(record, options?)` — deterministic projection from the durable `OperationRecordV2` (candidate revision, execution revision, frozen policy, controller epoch, participant execution binding).
- `verifyTelemetryCorrelation(actual, expected)` — exact key-by-key mismatch list; stale/wrong candidate, revision, execution revision, policy, epoch, participant, and session are explicitly named.
- `resolveTelemetryCorrelation(root, operationId?)` — resolves the current durable operation identity at emission time.

## Delegation Assessment

Profiles available: `list_profiles` (see below at execution time). Writer units are **LEAD_OWNED**: the campaign forbids commits, and an isolated worktree cannot receive the lead's uncommitted implementation, so concurrent writers cannot be integrated without commits or shared-tree writes. Verification is delegated where genuinely separable: the independent read-only adversarial-invariant verification (`S12-W7`). Delegated workers are read-only, never delegate further, never write the primary checkout except an explicitly assigned evidence artifact, and never touch `docs/CORE_ARCHITECTURE_V2.md`.

## Evidence lane plan

- CONTRACT/UNIT: identity contract, stale detection, metric instrument/export serialization, corpus manifest/digest, scoring reproducibility, advisory-invariant static and behavioral checks.
- INTEGRATION/SYSTEM_DETERMINISTIC: deterministic scenario emitting production telemetry into local NDJSON/OTLP/metrics lanes with a durable operation identity; loopback OTLP/HTTP receiver; local campaign.
- ADVERSARIAL: stale/wrong-candidate attribution; fabricated eval/telemetry artifacts attempting policy/authority/acceptance/permission/routing influence.
- REAL_PROVIDER: not claimed. The OTLP lane is a local loopback receiver, not a hosted collector or provider; the eval scenarios exercise deterministic production subsystems without a model.
- PACKED_E2E/BROWSER/VISUAL: not claimed by S12 beyond existing S9–S11 records.

## Execution record (2026-09-26)

| WorkUnit | Disposition | Evidence |
| --- | --- | --- |
| S12-W0 | DONE | Prerequisites present at `9cdbbfe`; gap reconstructed from source (no candidate/revision/identity/execution/policy/epoch/participant/session correlation, no metric instruments, no corpus, no export verification, no advisory proof). |
| S12-W1 | DONE | `src/telemetry/identity.ts`; `tests/telemetry/identity.test.ts` 5 tests (derive, fail-closed input, digest stability/separation, stale candidate/revision/policy/epoch/participant/session detection, participant/runtime projection). |
| S12-W2 | DONE | `src/telemetry/events.ts`, `src/telemetry/tracing.ts`; `tests/telemetry/events.test.ts` 4 tests (current identity binding, stable trace ID, stale-identity mismatch marking, unresolved identity, disabled telemetry). |
| S12-W3 | DONE | `src/telemetry/metrics.ts` (OTel SDK counters/histograms + canonical local snapshot exporter), wired in `src/core/run.ts`, `src/core/verify.ts`, `src/workers/agentPrompt.ts`, `src/paseo/sessionBinding.ts`; `tests/telemetry/metrics.test.ts` 3 tests (instrument coverage, correlation attributes, fixed-scenario digest reproducibility, no-op without identity). `@opentelemetry/sdk-metrics` declared and lockfile-updated offline. |
| S12-W4 | DONE | `tests/helpers/otlpReceiver.ts` in-process loopback receiver; `tests/telemetry/export.test.ts` verifies real OTLP/HTTP JSON export (`POST /v1/traces`, `application/json`, resource build/service identity, stable trace ID, parent span, correlation digest equal to the NDJSON identity digest). |
| S12-W5 | DONE (R1 repaired) | `evals/corpus/corpus.json`, five cases + fixtures + `evals/scenarios/`; `src/evals/runner.ts` records `EvalCorpusIdentityV1` plus the running build identity and templates `{aehRoot}`; the case/corpus digest binds each case's executable scenario harness closure (declared entry plus relative imports inside `evals/`), and a missing declared scenario fails closed; the digest rule is canonical (unique file set keyed by normalized repo-relative path, sorted, hashed as `relativePath\0fileSha256` lines); `src/evals/scoring.ts` comparable projection; `tests/evals/corpus.test.ts` 5 tests (shipped manifest, corpus digest equality, scenario-mutation digest change/restore, per-result build/corpus identity, all cases through the production runner, repeat reproducibility). |
| S12-W6 | DONE (R1 repaired) | `scripts/s12ObservabilityCampaign.ts` → `docs/evidence/s12/s12-observability-evals-campaign.json` (status PASS; built release `release-1790462333370-272879-9c0e6a52`; corpus digest `11e9b972994e316c853893e9744109e146ffad96563ff3924dd8632b0e5485a6`; fixed repo-relative scenario root so candidate/policy/correlation identity and canonical metric digest `838305e6fba955d5a55d64f6252909130cf7b8f005eff8eb22388d16cd522878` are identical across independent executions; OTLP payload verified; five eval case results; advisory checks). |
| S12-W7 | DONE | `src/evals/advisoryInvariant.ts`; `tests/evals/advisoryInvariant.test.ts` 5 tests (static import guard, validation-gate invariance, durable-truth invariance, acceptance not injectable, routing invariance). Independent read-only adversarial verification was not separately delegated because no isolated worktree can receive the lead's uncommitted implementation without commits; the fresh slice reviewer owns independent re-verification. |
| S12-W8 | DONE | STATUS observability row + S12 section; CONFORMANCE S12 section + deterministic evidence-map row; LEDGER AEH-V2-0061; OBSERVABILITY rewrite. `docs/CORE_ARCHITECTURE_V2.md` untouched. |

### Validation summary (2026-09-26, R1 repair applied)

- `npm run typecheck` — exit 0.
- `npm run build` — exit 0; the full-suite build-hygiene lane produced `release-1790462333370-272879-9c0e6a52`, which `dist/current` selects and the regenerated evidence artifact records.
- Focused S12 set (`tests/telemetry`, `tests/evals`, `tests/metrics.test.ts`, `tests/evals.test.ts`, `tests/paseoTrace.test.ts`) — 9 files / 28 tests passed.
- Affected wiring set (operations, validation providers, structured-result gateway, agent-prompt provenance, Paseo session binding) — 13 files / 126 tests passed.
- Full non-system Vitest — 186 files and 1,195 tests: 1,185 passed / 3 failed / 7 pending (file statuses 185 passed / 1 failed in this run; the 7 pending are the opt-in real-provider contracts in `tests/providerContracts.test.ts`, reported as skipped by some reporter views). The only failures are the 3 pre-existing `tests/paseoSdkResolve.test.ts` mise environment-drift tests already reproduced at baseline in S10/S11 and unchanged by S12.
- Relevant deterministic system lanes — scenario matrix + concurrency + contract/integration 3 files / 20 tests passed; isolation campaign 1 file / 3 tests passed; adversarial suite 26 passed with its two long-recorded S6 objective-completion fixture failures unchanged.
- Campaign cross-execution reproducibility — four independent executions in separate processes produced identical candidate `698e397a9d2f91bde5fa0a090a4c69062e1236bc33d1dc9c9f512d38d4128de3`, policy `b1c8f1dd4c74e952ded2a8537fce24ef1edefdb1b6a4f22bf828f9a20d0d2ecd`, participant correlation `20af5760d1f4b6c7a600a259e9cb0bdf9f3ab3bae84fe3be5d9f6ce6fed5d796`, base correlation `ad2d03c5d1d9427b70c21f686801de7d975fe842fb46129ab9e939ab654879f3`, corpus `11e9b972994e316c853893e9744109e146ffad96563ff3924dd8632b0e5485a6`, and canonical metric snapshot digest `838305e6fba955d5a55d64f6252909130cf7b8f005eff8eb22388d16cd522878`; regenerated artifact SHA-256 `285e78ff74ca9bfe64bd3ece8d4018387e4508ba2597fbad94a9871f867398af`.
- `git diff --check` — clean.

## Repair WorkGraph S12-R1 (2026-09-26)

The fresh independent reviewer (S12-REVIEW) verified gate A (identity) and gate C (advisory invariant) as PASS plus TARGET/lane/dependency/secrets invariants, and rejected the slice on gate B with two MEDIUM findings and one LOW docs finding.

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S12-R1-W1 | F1: bind each case's executable scenario harness closure into the case/corpus digest and record the running build identity per result; fail closed on a missing declared scenario | implementation | LEAD_OWNED | S12-W5 | scenario mutation changes the case/corpus digest; other cases unchanged; restore returns the digest; runner records identity |
| S12-R1-W2 | F2: make the campaign scenario root deterministic (fixed repo-relative ignored path recreated per execution) so candidate/policy/correlation identity and the canonical metric digest are identical across independent executions | implementation | LEAD_OWNED | S12-W6 | two independent process executions produce identical recorded identity and canonical digest |
| S12-R1-W3 | F3: correct the full non-system file-count statements in STATUS/CONFORMANCE/WorkGraph/LEDGER to the observed totals | documentation | LEAD_OWNED | fresh full-suite run | docs match the fresh run exactly |
| S12-R1-W4 | INFO hardening: metric recording verifies a caller-supplied correlation against current durable truth and records nothing on mismatch; detached unverified boundary documented | implementation | LEAD_OWNED | S12-W3 | stale correlation rejected, current recorded; OBSERVABILITY documents the boundary |
| S12-R1-W5 | Fresh evidence: focused/affected sets, full non-system suite, system lanes, two independent campaign executions, regenerated artifact, `git diff --check` | verification | LEAD_OWNED plus bounded read-only verification | W1–W4 | exact counts and cross-execution digests recorded |

**Dispositions:** W1 DONE (`src/evals/runner.ts` `scenarioHarnessClosure` + `EVAL_CORPUS_SCENARIO_MISSING`; `EvalBuildIdentityV1` on every result; `tests/evals/corpus.test.ts` 5 tests). W2 DONE (`scripts/s12ObservabilityCampaign.ts` uses `.harness/s12-campaign-scenario`; `reproducibility` block in the artifact). W3 DONE. W4 DONE (`correlationMatchesCurrent`; `tests/telemetry/metrics.test.ts` 4 tests; `docs/OBSERVABILITY.md`). W5 DONE (counts and digests above).

### Delegation assessment outcome

Writer units were LEAD_OWNED because the campaign forbids commits and an isolated worktree cannot receive uncommitted implementation; no concurrent writer touched the primary checkout. Verification halves were delegated to bounded read-only subagents (no file writes, no further delegation, no commits, no TARGET access).

**Round 1 (pre-repair):** the subagent re-ran `npx vitest run tests/telemetry tests/evals` (7 files / 22 tests passed), independently recomputed the corpus digest, confirmed the artifact booleans, confirmed no authority-module observation imports, confirmed `git status` unchanged by its run, and found no credential-like strings. It reported no discrepancies and did not declare acceptance.

**Round 2 (post-repair):** a second bounded read-only subagent re-ran `npx vitest run tests/telemetry tests/evals` (7 files / 25 tests passed), verified the repaired artifact fields (fixed repo-relative scenario root, candidate `698e397a…`, policy `b1c8f1dd…`, participant correlation `20af5760…`, base correlation `ad2d03c5…`, canonical metric digest `838305e6…`, corpus digest, advisory booleans, OTLP correlation), independently falsified F1 by appending to a copied `scopeGovernance.ts` and observing the case/corpus digest change while other cases stayed unchanged, confirmed the campaign scenario directory is cleaned up, confirmed `git status` unchanged by its run (34 entries before/after), and found no credential-like strings. It reported two precision discrepancies: the digest keying was ambiguous (duplicate entries retained, corpus-dir-relative keys) and the artifact listed `metrics.canonicalMetricSnapshotDigest` instead of `reproducibility.canonicalMetricSnapshotDigest`. Both were repaired: the digest rule is now a unique file set keyed by normalized repo-relative path, sorted, hashed as `relativePath\0fileSha256` lines (the subagent's independent literal implementation reproduces the final corpus digest `11e9b972994e316c853893e9744109e146ffad96563ff3924dd8632b0e5485a6` exactly), and the field path is corrected. Neither subagent declared slice acceptance; the fresh independent slice reviewer still owns actual acceptance.

## Independent acceptance (S12-R2, 2026-09-26)

A fresh independent re-reviewer (S12-REVIEW-R2) verified the round-1 repairs and returned **SLICE_ACCEPTED**: gate A (telemetry identity), gate B (local export reproducible), and gate C (evals advisory only) all PASS, with TARGET zero diff, lane honesty (LOCAL_OTLP loopback only), dependency/license, secrets/symlinks/staged-artifact, and docs-truthfulness invariants PASS. The reviewer independently reproduced the corpus digest `11e9b972…` with its own implementation, falsified F1 by mutating scenario harnesses on a throwaway copy (including the shared `_result.ts` closure), ran the campaign twice in independent processes and matched all canonical fields (candidate `698e397a…`, policy `b1c8f1dd…`, participant correlation `20af5760…`, base correlation `ad2d03c5…`, canonical metric digest `838305e6…`), verified the real loopback OTLP/HTTP trace export, re-ran the full non-system suite (186 files / 1,195 tests: 1,185 passed / 3 pre-existing `paseoSdkResolve` failures / 7 pending), and confirmed the advisory invariant adversarially. Non-blocking observations: the duplicated repair section formerly here was removed at checkpoint, and the pre-existing local NDJSON event append remains fail-hard (unchanged from baseline, no decision/durable-state effect).

**Checkpoint:** `core-v2: complete S12 observability and engineering evals` commit `ff1f420` on `core-architecture-v2`, pushed; primary checkout clean.
