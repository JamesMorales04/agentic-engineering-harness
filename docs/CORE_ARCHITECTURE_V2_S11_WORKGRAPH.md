# S11 — Contract / Integration / Browser / Visual Validation WorkGraph

**Slice:** S11 — Contract / Integration / Browser / Visual Validation
**Branch:** `core-architecture-v2`
**Base:** `9b74c04167e79748312160b6476cc5050050b4e3` (S9 and S10 independently accepted and committed; clean tree)
**Normative target:** `docs/CORE_ARCHITECTURE_V2.md` (unchanged by this slice)
**Mechanism classification:** `DETERMINISTIC` provider resolution, command construction, candidate/evidence binding, lifecycle checks, and fail-closed policy. `MODEL` is not used anywhere in this slice. No heuristic or model output is promoted to a blocking gate.

## Prerequisite verification (before implementation)

- S6 acceptance/evidence contracts present: `src/architecture/acceptanceOracle.ts`, `src/architecture/objectiveCompletion.ts`, `src/architecture/candidateAssurance.ts`; S6 accepted by the Campaign Director on 2026-09-24.
- S9 Control Center/runtime present: `src/control-center/`, `src/runtime/`, `ui/control-center/`, `tests/browser/` and `skills/aeh-browser-e2e/SKILL.md`; browser journey PASS recorded 2026-09-26.
- S10 isolation/sandbox and candidate-bound SAST present: `src/security/isolation.ts`, `src/security/sastEvidence.ts`, `src/validators/external.ts`; accepted tree at `9b74c04`.
- Scope boundary: S11 adds provider lanes and candidate-bound lane evidence for contract/integration/browser/visual validation. It does not change candidate truth, policy semantics, acceptance, controller fencing, isolation, or SAST semantics.

## Environment facts (exact, 2026-09-26, this checkout)

| Fact | Observed |
| --- | --- |
| `@playwright/test` | `1.62.1` pinned in this candidate (`node_modules/.bin/playwright --version` → `Version 1.62.1`) |
| Playwright browser cache | `chromium-1223`, `chromium-1228`, `chromium-1234`, headless shells; no `firefox`/`webkit` |
| `pact` / `pact_verifier_cli` | **missing**; a required Pact verifier must fail closed, not SKIP |
| `bwrap` | available `0.13.0` (S10) |
| `trivy` | not on `PATH`; S10 local OSS binary at `/tmp/opencode/s10-tools/trivy/0.70.0/trivy` |
| `podman` | **missing** |
| `docker` | client `29.4.1` present at `/usr/local/bin/docker`, but the daemon is unreachable (`docker info` fails); the provider probe treats this as unavailable and fails closed |
| `node` / `python3` | `v22.23.2` / `3.13.15` (real BDD/test runners are executable) |

## WorkGraph

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S11-W0 | Prerequisite verification, environment capture, and this tactical WorkGraph | verification | LEAD_OWNED | accepted S6/S9/S10 tree | prerequisites present; facts recorded |
| S11-W1 | Candidate-bound provider lane evidence module for CONTRACT/INTEGRATION/BROWSER/VISUAL (persist/load/verify/require, stale/tamper/required/missing-provider blockers) | implementation | LEAD_OWNED (contract freeze) | W0 | deterministic contract tests pass; no lane can claim PASS from another lane's artifact |
| S11-W2 | Fail-closed provider and capability resolution: declared `browser-test`/`visual-test`/contract/integration capabilities must resolve to matching providers, and missing tools/providers return explicit blocking failures instead of silent SKIP or generic unit-test fallback | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1 | required specialized lanes never fall through to `test-execution`; explicit `*_UNAVAILABLE` blockers |
| S11-W3 | Isolated-service integration lifecycle hardening: real provision/readiness/test/cleanup steps, readiness required for a PASS, cleanup always attempted, explicit lifecycle blockers, candidate-bound INTEGRATION lane evidence | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1, W2 | unready/uncleaned environments FAIL; missing OCI runtime FAILs closed |
| S11-W4 | Contract lane (OpenAPI/Pact/BDD): real OpenAPI comparison and real BDD execution through the validator path with candidate-bound CONTRACT evidence; absent Pact verifier yields an explicit blocker never a SKIP | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1, W2 | required contract assertions resolve to approved providers and current-candidate evidence |
| S11-W5 | Browser/visual lane: pinned Playwright provider resolution, real-browser journey assertions reused from the S9 harness, candidate-bound BROWSER and VISUAL evidence with digest-bound screenshot artifacts, missing browser/provider fails closed | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1, W2 | required UI/visual assertions resolve to the approved provider and current-candidate evidence |
| S11-W6 | Real integration/contract/browser/visual campaigns against the real workspace and real browser (system lanes) | verification | LEAD_OWNED | W3, W4, W5 | SYSTEM_DETERMINISTIC + BROWSER + VISUAL evidence from real execution, not fixtures alone |
| S11-W7 | Fail-closed adversarial audit: required missing Pact/OCI/Playwright/visual providers produce explicit FAIL blockers, never SKIP or fabricated PASS; lane evidence stale/tamper/required rejection | adversarial verification | LEAD_OWNED | W1–W5 | explicit blockers asserted by tests |
| S11-W8 | Documentation and evidence boundaries: STATUS/CONFORMANCE/LEDGER updates, lane separation, this WorkGraph | documentation | LEAD_OWNED | all | truthful evidence; no REAL_PROVIDER/browser over-claim from fixtures |

### Frozen contract (W1)

`src/validation/laneEvidence.ts`:

- `ProviderLaneEvidenceV1` — `lane` (`CONTRACT` | `INTEGRATION` | `BROWSER` | `VISUAL`), `checkId`, candidate binding, workspace source-digest match evidence, provider identity/version/runtime, command digest, status, findings, artifact list with per-file digests, raw-artifact digest, timestamps, blockers, canonical digest.
- `persistProviderLaneEvidenceV1`, `loadProviderLaneEvidenceV1`, `verifyProviderLaneEvidenceV1`, `requireProviderLaneEvidenceV1` — candidate-scoped artifact path under the evidence output directory; digest recomputation; wrong-candidate/tamper/missing rejection with explicit blockers (`PROVIDER_LANE_EVIDENCE_REQUIRED|STALE|TAMPERED`).
- Provider-absence blocker names are lane-specific: `CONTRACT_PROVIDER_UNAVAILABLE`, `INTEGRATION_PROVIDER_UNAVAILABLE`, `BROWSER_PROVIDER_UNAVAILABLE`, `VISUAL_PROVIDER_UNAVAILABLE`, plus `*_CANDIDATE_BINDING_REQUIRED`.

## Delegation Assessment

Profiles listed with `list_profiles`: `DeepSeek V4.1 Flash Implementer` (`opencode/opencode-go/deepseek-v4.1-flash`, build, max thinking) and `Luna Lead` (`codex/gpt-6-luna`, full access, xhigh).

- **Delegated (background, isolated Paseo worktree `wks_b82fd032afd95af3`):** the baseline-gap reproduction unit `S11-BASE` to the Flash Implementer profile. Scope: read-only source/test inspection and real command probes against the committed baseline `9b74c04`, writing exactly one artifact (`docs/evidence/s11/baseline-gaps.md`) in its own worktree; no commits/pushes, no nested delegation, no AEH operation against this checkout, no writes to the primary checkout (read-only symlinks to `node_modules`/`dist` only). Purpose: independently reproduce which S11 gate items are unmet before implementation.
- **Delegation rejected for writer units in this slice:** the campaign forbids commits and an isolated worktree cannot receive the lead's uncommitted implementation; parallel writer integration would require either commits or shared-tree writes. Verification is delegated instead.
- **Duplicate-writer protection:** no concurrent writer mutates the primary checkout; the delegated worker writes only inside its own worktree. Any delegated artifact is selectively integrated and reviewed by the lead. Workers never delegate further.

## Evidence lane plan

- CONTRACT/UNIT: lane evidence persist/verify/tamper, fail-closed capability/provider resolution, lifecycle normalization, visual adapter parsing.
- INTEGRATION/SYSTEM_DETERMINISTIC: real local service lifecycle (provision → readiness → test → cleanup) and real OpenAPI/BDD executions in this workspace.
- BROWSER/VISUAL: real Playwright Chromium run of the maintained S9-harness Control Center journey through the pinned candidate provider, with digest-bound screenshot artifacts and candidate-bound BROWSER/VISUAL evidence.
- ADVERSARIAL: required-missing-provider checks for Pact, OCI, Playwright and visual; lane evidence stale/tamper/required rejection.
- REAL_PROVIDER: not claimed. The browser journey uses the file-scripted deterministic Paseo boundary (as S9 recorded) and local OSS Playwright Chromium; it is BROWSER/VISUAL evidence, not hosted-provider or S13 certification.
- PACKED_E2E: not claimed by S11 beyond the existing S8/S9/S10 packed records.

> **Superseded record:** the first S11 submission was independently reviewed and rejected. The execution record below is retained as pre-repair history; the round-1 repaired state is in [Repair WorkGraph S11-R](#repair-workgraph-s11-r-2026-09-26), and the current round-2 repaired state (BDD/gherkin provider route, candidate-scoped lane output) with the exact final digests is in [Repair WorkGraph S11-R2](#repair-workgraph-s11-r2-2026-09-26). The rejected browser/visual machine summary is preserved at `docs/evidence/s11/browser-visual-campaign.rejected-pre-repair.json`.

## Execution record (2026-09-26)

| WorkUnit | Disposition | Evidence |
| --- | --- | --- |
| S11-W0 | DONE | Prerequisites present at `9b74c04`; environment facts above; delegated baseline reproduction `docs/evidence/s11/baseline-gaps.md`. |
| S11-W1 | DONE | `src/validation/laneEvidence.ts`; `tests/validation/laneEvidence.test.ts` 5 tests passed (persist/load/verify/require, lane separation, stale, tamper, workspace drift). |
| S11-W2 | DONE | `src/providers/validation/registry.ts`, `src/validators/registry.ts`, `src/providers/validation/integrationEnvironment.ts`, `src/validators/external.ts`; `tests/validation/failClosedProviders.test.ts` 7 tests passed (`BROWSER_PROVIDER_UNAVAILABLE`, `VISUAL_PROVIDER_UNAVAILABLE`, `CONTRACT_PROVIDER_UNAVAILABLE`, `INTEGRATION_PROVIDER_UNAVAILABLE`, `UNSUPPORTED_VALIDATION_CAPABILITY`, readiness-required lifecycle, optional SKIP). |
| S11-W3 | DONE | Real local service lifecycle in `tests/system/aehContractIntegrationCampaign.test.ts`: provision → readiness → test → cleanup, candidate-bound INTEGRATION evidence verified, killed service pid asserted gone, pid file removed. |
| S11-W4 | DONE | Real OpenAPI comparison and real BDD runner through the validator path with candidate-bound CONTRACT evidence; required Pact verifier absence blocks with `CONTRACT_PROVIDER_UNAVAILABLE`. |
| S11-W5 | DONE | `tests/browser/s11-control-center-browser-visual.e2e.ts` reuses `tests/browser/fixture/`; `visual-test` kind/`visual` adapter/`UI/visual` impact mapping; `runExternalToolValidator` persists candidate-bound BROWSER/VISUAL evidence with digest-bound screenshot artifacts; missing pinned Playwright or browser blocks. |
| S11-W6 | DONE | `npm run test:browser-visual` (build `release-1790392483278-608471-43c5a8c4`) → BROWSER and VISUAL PASS with verified candidate-bound evidence; `docs/evidence/s11/browser-visual-campaign.json`. System lanes 4 files / 23 tests passed. |
| S11-W7 | DONE | Fail-closed and tamper tests above; adversarial suite 26 passed with the two long-recorded S6 fixture failures unchanged. |
| S11-W8 | DONE | This document plus STATUS/CONFORMANCE/LEDGER updates; lanes kept separate; no REAL_PROVIDER claim. |

### Focused and regression commands (exact results)

| Command | Result |
| --- | --- |
| `./node_modules/.bin/vitest run tests/validation/laneEvidence.test.ts tests/validation/failClosedProviders.test.ts tests/system/aehContractIntegrationCampaign.test.ts tests/validationProviders.test.ts tests/openapi.test.ts tests/candidateAssurance.test.ts tests/architectureWorkGraph.test.ts tests/acceptanceOracle.test.ts tests/security/providerFailClosed.test.ts tests/security/sastEvidence.test.ts tests/security/validatorIsolationFailClosed.test.ts` | 11 files / 70 tests passed |
| `npm run typecheck` | exit 0 |
| `./node_modules/.bin/vitest run --exclude 'tests/system/**'` | 174 files passed, 1 skipped, 4 failed; 1,143 passed, 7 skipped, 6 failed. The 4 failures were resource-contention flakes in that run; a JSON-reporter rerun produced only the known `tests/paseoSdkResolve.test.ts` 3 failures reproduced at baseline in S10 (mise-installed Paseo CLI environment drift), not an S11 regression. |
| `./node_modules/.bin/vitest run tests/system/aehScenarioMatrix.test.ts tests/system/aehConcurrencyCampaign.test.ts tests/system/aehIsolationCampaign.test.ts tests/system/aehContractIntegrationCampaign.test.ts` | 4 files / 23 tests passed |
| `./node_modules/.bin/vitest run tests/system/aehAdversarialE2E.test.ts` | 26 passed / 2 failed; both are the long-recorded S6 `OBJECTIVE_COMPLETION_REQUIRED` fixtures, unchanged from S10 |
| `npm run test:browser-visual` | exit 0; built `release-1790392483278-608471-43c5a8c4`; BROWSER and VISUAL PASS; evidence digests verified |
| `node_modules/.bin/playwright test --config tests/browser/playwright.config.ts --grep "S11" --reporter=list` | 2 passed (browser + visual), baseline screenshot comparison reproducible across runs |
| `node_modules/.bin/playwright test --config tests/browser/playwright.config.ts --grep "S9 browser E2E" --reporter=list` | 1 passed (33.4s); the S9 46-assertion journey still passes with the narrow child-environment repair, so no S9 browser regression |

### Browser/visual evidence details (REJECTED PRE-REPAIR — digests below are historical and superseded)

- Candidate: `CAND-S11-BROWSER-VISUAL` r1, identity digest `3f5d878c468abe91bf6f73d3630ea8a3d5cb5d6c9cd212c0fbd624c33c31e2bc`, workspace source digest `986de6ecf64368789ab687b9d00661715e6602c51895098ff0bfda6b17bed27d`.
- Build identity: package `0.8.4`, gitSha `9b74c04167e79748312160b6476cc5050050b4e3`, dirty `true` (uncommitted S11 worktree), release `release-1790392483278-608471-43c5a8c4`; pinned provider `node_modules/.bin/playwright` 1.62.1.
- BROWSER evidence: `.harness/evidence/browser/CAND-S11-BROWSER-VISUAL-r1-3f5d878c468a/s11-browser-journey.json` digest `7b6c3a26aaad78e11788e2da8471415dd3222b3847fcf6a5998549c44712733e`; raw report plus one digest-bound full-page screenshot.
- VISUAL evidence: `.harness/evidence/visual/CAND-S11-BROWSER-VISUAL-r1-3f5d878c468a/s11-visual-journey.json` digest `22e7d45f016700a011974adb13fc3d84b7b9c0f8b7a212ea83b340590cd55d03`; raw report plus three digest-bound screenshots (heading, decision card, footer) under `.harness/evidence/playwright-s11-output/`.
- Journey assertions: pairing/session hardening, rendered operation card and current decision scope equal to durable operation/candidate/policy/execution-revision/epoch/request identity, rendered choice control, footer build identity; visual geometry, two-capture render stability, and a committed Playwright screenshot baseline (`tests/browser/s11-control-center-browser-visual.e2e.ts-snapshots/s11-control-center-heading-chromium-linux.png`, `maxDiffPixelRatio: 0.05`).
- Boundary: the model conversation is the file-scripted deterministic Paseo boundary used by S9; this is BROWSER/VISUAL evidence against the real built candidate and real Chromium, not REAL_PROVIDER certification.

### Narrow harness repair

`tests/browser/fixture/controlCenterJourney.ts` now removes `PASEO_AGENT_ID` and `PASEO_PARENT_AGENT_ID` from child environments. Without this, the disposable fixture's detached operation attached its terminal events to the interactive Paseo session running the test. No journey semantics, assertions, or evidence fields changed; the S9 journey was rerun after the change and passed (33.4s).

## Delegation outcome

The bounded Flash worker reproduced the pre-S11 baseline in its isolated worktree and produced `docs/evidence/s11/baseline-gaps.md` (selectively integrated, unchanged): required Pact/OCI checks were coerced from SKIP to FAIL with no provider blocker; the integration lifecycle treated an absent readiness command as ready; a declared `browser-test` capability silently ran generic unit tests and could PASS without any browser; no `visual` capability existed; and no candidate-bound contract/integration/browser/visual evidence artifact existed (SAST was the only candidate-scoped evidence module). No writer delegation was used, per the assessment above.

## Remaining lanes (not claimed)

- REAL_PROVIDER: the browser journey uses the scripted deterministic Paseo boundary; hosted-provider, live-model, rootless Podman/OCI, and S13 provider certification remain open.
- PACKED_E2E: the browser campaign runs against the built release via the supported start path but is not a freshly packed `npm pack` product journey.
- OPA_PROVIDER: unchanged from S10; `opa` is unavailable.

## Repair WorkGraph (S11-R, 2026-09-26)

**Trigger:** the independent review of the first S11 submission rejected it on five findings: F1 (HIGH) browser/visual Playwright output collision and no artifact verification in the campaign; F2 (HIGH) required specialized lane requirements satisfiable by a non-provider project script/raw command through `ensureProviderLaneEvidenceFromCheckV1` synthesis; F3 (MEDIUM) VISUAL evidence without reference-baseline or comparison-config binding; F4 (MEDIUM) candidate/evidence digest not reproducible because the campaign rewrote an untracked source-tree summary after binding the candidate, plus unreconciled docs citations; F5 (LOW) `INTEGRATION_CLEANUP_REQUIRED` emitted when provisioning failed and created no resources.

**Mechanism classification:** all repairs are `DETERMINISTIC`; no `MODEL` or heuristic decision was added.

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S11R-W0 | Reproduce F1–F5 on the rejected tree; capture the rejected summary as history | verification | LEAD_OWNED | rejected S11 tree | findings reproduced; pre-repair summary preserved |
| S11R-W1 | Lane-evidence contract repair: delete synthesis, typed `requireProviderLaneEvidenceForActionV1`, OpenAPI self-persistence, VISUAL `baseline` artifact + `comparison` binding, integration `cleanupRequired` semantics | implementation | LEAD_OWNED (contract freeze) | W0 | specialized lane PASS impossible without matching provider execution; VISUAL without baseline/comparison fails closed |
| S11R-W2 | External validator + campaign repair: per-lane durable Playwright output directories, campaign-side verification of both lanes, digest-stable machine summary under the ignored evidence directory | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1 | campaign fails if either lane is not `ok`; campaign never mutates the candidate source inventory |
| S11R-W3 | Focused, adversarial, system, and full non-system verification | verification | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1, W2 | all listed suites and typecheck pass; only the known `paseoSdkResolve` mise drift fails |
| S11R-W4 | `npm run test:browser-visual` end-to-end with independent post-campaign verification of both lanes | verification | LEAD_OWNED | W3 | exit 0; both lanes `ok=true`; artifacts present; workspace digest recomputation MATCH |
| S11R-W5 | Documentation reconciliation to the repaired state and exact final digests | documentation | SEQUENTIAL_AFTER_W4 | W4 | STATUS/CONFORMANCE/LEDGER/WorkGraph truthful; rejected summary preserved |

**Delegation:** none. The uncommitted tree makes isolated writer worktrees impractical and the campaign forbids commits; every repair unit is `LEAD_OWNED`, as required. No nested delegation, no commits, no AEH product run against this checkout.

### Repair execution record (2026-09-26)

| ID | Disposition | Evidence |
| --- | --- | --- |
| S11R-W0 | DONE | Reproduced F1 (BROWSER evidence failed `verifyProviderLaneEvidenceV1` after `npm run test:browser-visual` exited 0 because the VISUAL run deleted its screenshot), F2 (project-script `npm run e2e` → synthesized BROWSER evidence → `require` OK), F3 (no reference/comparison binding), F4 (candidate identity changed per run; recorded digest did not match the tree), F5 (cleanup blocker on failed provision). Rejected summary preserved as `docs/evidence/s11/browser-visual-campaign.rejected-pre-repair.json`. |
| S11R-W1 | DONE | `src/validation/laneEvidence.ts` (synthesis helper deleted; `requireProviderLaneEvidenceForActionV1`; `baseline` artifact kind; `comparison`; VISUAL verification; `PROVIDER_LANE_REFERENCE_REQUIRED`, `VISUAL_REFERENCE_BASELINE_REQUIRED`, `VISUAL_COMPARISON_CONFIG_REQUIRED`), `src/validators/openapi.ts` (self-persisted candidate-bound CONTRACT evidence), `src/core/run.ts` (provider-execution enforcement + typed blocker), `src/architecture/validationRequirements.ts` (`openapi → contract-test`), `src/providers/validation/integrationEnvironment.ts` + `types.ts` + `schemas/validation-result.schema.json` (`cleanupRequired`, conditional cleanup blockers). |
| S11R-W2 | DONE | `src/validators/external.ts` (VISUAL binding resolution, baseline artifact, comparison persistence, `visual` lane), `scripts/s11BrowserVisualCampaign.ts` (per-lane output dirs, post-campaign `verifyProviderLaneEvidenceV1` for both lanes, summary under `.harness/evidence/s11/`, pre/post summary worktree-digest checks). |
| S11R-W3 | DONE | `npm run typecheck` exit 0; focused S11 set 8 files / 49 tests passed (including new `tests/validation/requiredLaneEvidence.test.ts` 8 adversarial tests); related security/candidate suites 8 files / 43 tests passed; four deterministic system suites 4 files / 23 tests passed; full non-system 178 files passed / 1 skipped / 1 failed (`tests/paseoSdkResolve.test.ts` known mise drift, 3 tests); `git diff --check` clean. |
| S11R-W4 | DONE | `npm run test:browser-visual` exit 0; build `release-1790455687992-64113-eb8d526a`; both lanes verified `ok=true` after the full campaign; independent fresh-process re-verification reproduced `recomputedWorktreeDigest == candidate.sourceDigest` and `assertWorkspaceMatchesCandidate` `status: MATCH`. |
| S11R-W5 | DONE | This repair section plus STATUS/CONFORMANCE/LEDGER updates cite the exact repaired digests; `docs/evidence/s11/baseline-gaps.md` is unchanged. |

### Repaired browser/visual evidence (2026-09-26)

- Candidate `CAND-S11-BROWSER-VISUAL` r1; identity digest `986c1daadb6ed8fe030badc5e9cd8215d2a182cc63f45fdad0760b3269528d73`; workspace source digest `73c33007e15d4fdc5516d49a02dfc6cf3a9cd0d5a995778e5e3460aaa6cf465a`.
- Build identity: package `0.8.4`, gitSha `9b74c04167e79748312160b6476cc5050050b4e3`, dirty `true`, release `release-1790455687992-64113-eb8d526a`, build digest `4272132837b689635cefd2ddeab40edc8488ab9e3f5a208f8d75bcbbc366a8dd`.
- BROWSER evidence `.harness/evidence/browser/CAND-S11-BROWSER-VISUAL-r1-986c1daadb6e/s11-browser-journey.json` digest `9c166b826992119a44cf61f064c57e34a464e059bf251aecf3275e2ffea63ac2`; provider `playwright` 1.62.1; command digest `1e890036aa8ab6ddf5f06bdffa47379d4a556c82ae79cec79d8ab63f2d7cbed1`; raw artifact plus one digest-bound full-page screenshot in `.harness/evidence/playwright-s11-output/browser/`.
- VISUAL evidence `.harness/evidence/visual/CAND-S11-BROWSER-VISUAL-r1-986c1daadb6e/s11-visual-journey.json` digest `b9c187ddd52092a4c23816289f7616e6e41ee63f00ebb140c7811e3405193355`; provider `playwright-visual` 1.62.1; command digest `d189b52187d83c82ff1e1ab6bcdda5e92327d3aee078366228a999076e232c38`; comparison `playwright-toHaveScreenshot` `{ animations: disabled, maxDiffPixelRatio: 0.05 }`; baseline artifact `tests/browser/s11-control-center-browser-visual.e2e.ts-snapshots/s11-control-center-heading-chromium-linux.png` digest `21ec4e27bdb2aca29a3ed672c310e35533289f4636ddfe26f93badd8772565ee`; three digest-bound element screenshots in `.harness/evidence/playwright-s11-output/visual/`.
- Sanitized machine summary `.harness/evidence/s11/browser-visual-campaign.json` records `stableBeforeSummary: true` and `stableAfterSummary: true` with the candidate source digest; the summary lives outside the candidate source inventory, so the campaign no longer invalidates its own candidate binding. The documented `docs/evidence/s11/browser-visual-campaign.json` machine copy was intentionally not recreated; the rejected pre-repair JSON is preserved for history.
- Independent verification (fresh process, after the campaign): BROWSER `ok=true`, VISUAL `ok=true`, no blockers, `assertWorkspaceMatchesCandidate` `status: MATCH`.
- The mandated post-evidence documentation write (this WorkGraph and the STATUS/CONFORMANCE/LEDGER remediation records) changes the tracked worktree after evidence production, so a later full-tree digest recomputation is a new candidate by design; the recorded campaign-time source digest `73c33007…` is the digest the evidence was bound to. The fresh re-review gate re-runs `npm run test:browser-visual` on the final tree, which produces a self-consistent candidate and verifies both lanes again.
- Boundary unchanged: real built candidate, real Control Center UI/server/controller, real Playwright Chromium through the candidate-bound validator path, scripted deterministic Paseo provider conversation; BROWSER/VISUAL and SYSTEM_DETERMINISTIC evidence only, not REAL_PROVIDER, live-model, OPA, adversarial, or packed certification.

## Repair WorkGraph (S11-R2, 2026-09-26)

**Trigger:** the fresh independent re-review (R2) verified all F1–F5 round-1 repairs (real Chromium, separate per-lane output, no-synthesis requirement enforcement, VISUAL baseline/comparison binding, digest stability, cleanup semantics) but rejected the slice on one blocking gate item and raised one LOW durability issue.

1. **BLOCKING — declared `bdd`/`gherkin` route bypassed the capability provider (S11 gate 2; CONTRACT-lane BDD facet of gates 1/4):** `src/validators/registry.ts` routed `gherkin`/`bdd` to `runGherkinValidator`, which built a provider context without `providerSpec`/`candidate` and returned the generic `resultCheck`; a required declared `bdd` with no runner produced `FAIL` with the bare message `bdd-runner acceptance was skipped.` and no typed blocker, a configured `bdd` provider was ignored in favor of the package.json `bdd` script, and no candidate-bound CONTRACT evidence could be persisted on that route.
2. **LOW — lane output was not candidate-scoped:** `scripts/s11BrowserVisualCampaign.ts` reused `.harness/evidence/playwright-s11-output/<lane>` for every candidate, so a later run deleted the prior candidate's screenshots and broke its evidence verification.

**Mechanism classification:** both repairs are `DETERMINISTIC`; no `MODEL` or heuristic decision was added.

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S11R2-W1 | Route declared `gherkin`/`bdd` through the capability provider (honor `providerSpec`, typed `CONTRACT_PROVIDER_UNAVAILABLE` on missing runner, persist candidate-bound CONTRACT evidence on PASS); delete the superseded `runGherkinValidator` and migrate the maturity inventory | implementation | LEAD_OWNED (contract freeze) | R2 findings | missing runner never silently coerces to FAIL; configured provider executes; PASS evidence verifies |
| S11R2-W2 | Candidate-scope the per-lane Playwright output directory so later candidates cannot delete prior candidate artifacts | implementation | SEQUENTIAL_AFTER_W1 | R2 findings | prior-candidate evidence still verifies after a newer run |
| S11R2-W3 | Focused BDD regressions + full focused set + typecheck + system suites | verification | SEQUENTIAL_AFTER_W2 | W1, W2 | all pass; only the known `paseoSdkResolve` mise drift fails |
| S11R2-W4 | `npm run test:browser-visual` end-to-end + independent both-lane and prior-candidate verification | verification | LEAD_OWNED | W3 | exit 0; both lanes `ok=true`; workspace MATCH; prior candidate `a20fd933b163` still `ok=true` |
| S11R2-W5 | Documentation reconciliation with exact round-2 digests | documentation | SEQUENTIAL_AFTER_W4 | W4 | STATUS/CONFORMANCE/LEDGER/WorkGraph truthful; round-1 history retained |

**Delegation:** none; all units `LEAD_OWNED` under the same constraints (no commits/pushes, no AEH product run against this checkout, no nested delegation).

### Round-2 execution record (2026-09-26)

| ID | Disposition | Evidence |
| --- | --- | --- |
| S11R2-W1 | DONE | `src/validators/registry.ts` routes `gherkin`/`bdd` through `runCapabilityValidator`; `src/validators/gherkin.ts` deleted; `maturity/components.yaml` and `docs/component-maturity.json` cite `src/validators/registry.ts`. New `tests/validation/failClosedProviders.test.ts` regressions: declared `bdd` no runner → FAIL + `CONTRACT_PROVIDER_UNAVAILABLE` (never `bdd-runner acceptance was skipped.`); configured passing runner → configured runner executes (`.harness/configured-bdd/ran.txt`, no package-`bdd` marker) and `requireProviderLaneEvidenceV1(... "CONTRACT" ... "capability.bdd")` returns verifiable PASS evidence; configured failing runner → FAIL. |
| S11R2-W2 | DONE | `scripts/s11BrowserVisualCampaign.ts` writes `.harness/evidence/playwright-s11-output/<lane>/<candidateId>-r<revision>-<identity12>` and removes only that candidate-scoped directory. Independent verification: prior candidate `a20fd933b163` evidence `ok=true` after the newer `7ad7d70b2ef1` run; candidate `986c1daadb6e` (produced under the old flat layout before this fix) remains broken and is retained as observed pre-fix history. |
| S11R2-W3 | DONE | `npm run typecheck` exit 0; focused S11 set 9 files / 57 tests passed; full non-system 177 files passed / 1 skipped (1161 passed / 7 skipped, only the known `tests/paseoSdkResolve.test.ts` mise drift, 3 tests); four deterministic system suites 4 files / 23 tests passed; `git diff --check` clean. |
| S11R2-W4 | DONE | `npm run test:browser-visual` exit 0; build `release-1790457526805-146084-3114256d`; BROWSER and VISUAL `ok=true`; `assertWorkspaceMatchesCandidate` `MATCH`; `stableBeforeSummary`/`stableAfterSummary` true. |
| S11R2-W5 | DONE | This section plus STATUS/CONFORMANCE/LEDGER updates cite the exact round-2 digests; round-1 repair history and the rejected pre-repair summary are retained. |

### Round-2 browser/visual evidence (2026-09-26)

- Candidate `CAND-S11-BROWSER-VISUAL` r1; identity digest `7ad7d70b2ef1ac17c407b344d2c2811f3d58533699730380564bf1701d28cc44`; workspace source digest `7e791da17e1951ae96bf1c8c26438de4510c01cae1703370e2e4b3b0fdafcd42`.
- Build identity: package `0.8.4`, gitSha `9b74c04167e79748312160b6476cc5050050b4e3`, dirty `true`, release `release-1790457526805-146084-3114256d`, build digest `6d38f2b54f3e927f31362744326e97b234be715f403bf94c2ee47aef882c5911`.
- BROWSER evidence `.harness/evidence/browser/CAND-S11-BROWSER-VISUAL-r1-7ad7d70b2ef1/s11-browser-journey.json` digest `d98c455a87ddcff72214d4100fb0938628496e1407300ef3a783e3d800aef932`; provider `playwright` 1.62.1; command digest `69fd954a1be2a2b6ea3810f3ee388af0fc8310868c530bf6913a64eb5b9a361c`; candidate-scoped output `.harness/evidence/playwright-s11-output/browser/CAND-S11-BROWSER-VISUAL-r1-7ad7d70b2ef1/`.
- VISUAL evidence `.harness/evidence/visual/CAND-S11-BROWSER-VISUAL-r1-7ad7d70b2ef1/s11-visual-journey.json` digest `409aca8d6deb4758f55b437ae4a92c18a6943b4b9fca66d7d164099c2b9b6515`; provider `playwright-visual` 1.62.1; command digest `452a32a8b149e1797cabe39a1d57d394acd84d28766e3309275d2499bbf8f9f3`; comparison `playwright-toHaveScreenshot` `{ animations: disabled, maxDiffPixelRatio: 0.05 }`; baseline artifact `tests/browser/s11-control-center-browser-visual.e2e.ts-snapshots/s11-control-center-heading-chromium-linux.png` digest `21ec4e27bdb2aca29a3ed672c310e35533289f4636ddfe26f93badd8772565ee`; candidate-scoped output `.harness/evidence/playwright-s11-output/visual/CAND-S11-BROWSER-VISUAL-r1-7ad7d70b2ef1/`.
- Sanitized machine summary `.harness/evidence/s11/browser-visual-campaign.json` records `stableBeforeSummary: true`, `stableAfterSummary: true`, and the candidate source digest.
- Independent fresh-process verification after the campaign: BROWSER `ok=true`, VISUAL `ok=true`, workspace `MATCH`, no blockers; prior candidate `a20fd933b163` BROWSER evidence also `ok=true` (retention proof).
- The mandated post-evidence documentation write changes the tracked worktree after evidence production, so a later full-tree digest recomputation is a new candidate by design; the recorded campaign-time source digest is the binding of record, and the fresh re-review gate re-runs the campaign on the final tree.
- Boundary unchanged: real built candidate, real Control Center UI/server/controller, real Playwright Chromium through the candidate-bound validator path, scripted deterministic Paseo provider conversation; BROWSER/VISUAL and SYSTEM_DETERMINISTIC evidence only, not REAL_PROVIDER, live-model, OPA, adversarial, or packed certification.
