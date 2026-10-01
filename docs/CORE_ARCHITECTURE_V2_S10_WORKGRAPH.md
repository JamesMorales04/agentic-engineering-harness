# S10 — Security Isolation, Sandbox & SAST WorkGraph

**Slice:** S10 — Security Isolation, Sandbox & SAST
**Branch:** `core-architecture-v2`
**Base:** `0afebcdea9a387fc365bca08f78d6e1ed32a5778` (S9 independently accepted and committed; clean tree)
**Normative target:** `docs/CORE_ARCHITECTURE_V2.md` (unchanged by this slice)
**Mechanism classification:** `DETERMINISTIC` provider detection, argument construction, candidate binding, evidence verification, and fail-closed policy; `MODEL` is not used anywhere in this slice. No heuristic is promoted to a blocking gate.

## Prerequisite verification (before implementation)

- S1 execution identity present: `src/architecture/executionIdentity.ts`, `src/operations/v2Contracts.ts`, `src/candidates/identity.ts`; focused prerequisite run `tests/candidateIdentity.test.ts` passed.
- S3 role/action policy present: `src/security/actionPolicy.ts`, `src/security/toolActionGate.ts`, `src/security/actionReconciliation.ts`, `policies/core/trust-boundary.rego`; focused prerequisite runs `tests/security/toolActionGate.test.ts` and `tests/security/controllerFencing.test.ts` passed.
- Combined prerequisite command: `npx vitest run tests/candidateIdentity.test.ts tests/security/toolActionGate.test.ts tests/security/controllerFencing.test.ts` — 3 files / 23 tests passed.
- Scope boundary: S10 does not change S3 policy semantics, ToolActionGate authority, controller fencing, or candidate truth. S10 adds provider/isolation execution evidence and candidate-bound SAST evidence.

## Environment facts (exact, 2026-09-25, this checkout)

| Fact | Observed |
| --- | --- |
| kernel | `6.18.52-1-cachyos-lts` |
| user | `uid=1000` non-root, groups include `docker` |
| unprivileged user namespaces | `kernel.unprivileged_userns_clone = 1` |
| AppArmor unprivileged-userns restriction | sysctl absent (AppArmor not restricting userns here) |
| seccomp kernel interface | `/proc/sys/kernel/seccomp/actions_avail` available |
| `bwrap` (bubblewrap) | **available**, version `0.13.0` |
| `runc` | available at `/usr/bin/runc` |
| `unshare`, `newuidmap`, `newgidmap` | available |
| `podman` / `buildah` / `crun` / `slirp4netns` / `fuse-overlayfs` | **missing** |
| `opa` | **missing** |
| `opengrep` / `semgrep` / `trivy` | **missing before provisioning**; Trivy `v0.70.0` (Apache-2.0) provisioned locally to `/tmp/opencode/s10-tools/trivy/0.70.0` with published checksum verification for real SAST execution; recorded as REAL_PROVIDER lane, not as a committed dependency |
| Network | outbound HTTPS available; `sudo` unavailable (password required), so no system package installation |

Consequence: the rootless sandbox provider exercised by S10 is **bubblewrap user/mount/PID/network namespaces** (a real local OSS provider), not Podman. Podman absence is recorded as an explicit provider gap, not papered over. `opa` remains unavailable and OPA evidence stays source/adapter-level; S10 does not claim OPA_PROVIDER.

## WorkGraph

| ID | WorkUnit | Kind | Classification | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| S10-W0 | Prerequisite verification and environment capture | verification | LEAD_OWNED (done) | accepted S1/S3 tree | focused prerequisite tests pass; environment facts recorded |
| S10-W1 | Isolation provider core: deterministic capability detection, hardened bwrap argument construction, rootless execution wrapper, explicit `ISOLATION_PROVIDER_UNAVAILABLE` failure, isolation evidence struct, config/type/schema surface | implementation | LEAD_OWNED (contract freeze) | W0 | deterministic contract tests pass; no model input; unknown/unsupported provider fails explicitly |
| S10-W2 | Real rootless isolation campaign: actual bwrap execution proving user/PID/mount/net namespaces, network denial by real connect attempt, host-home masking, workspace-only writes, read-only `/etc`, env allowlist, and validator command isolation; provider absence is a hard fail, never a skip | verification | SEQUENTIAL_AFTER_CONTRACT_FREEZE / DELEGATABLE | W1 frozen interface | SYSTEM_DETERMINISTIC + ADVERSARIAL evidence from real kernel isolation, not argument assertions |
| S10-W3 | Validator-command isolation wiring: `runSpecCommand` and `runExternalToolValidator` (and configured validation commands) execute inside the isolation provider when policy requires; repo read-only, evidence dir writable, network denied by default; missing provider fails closed | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1 | required validator cannot run unsandboxed or silently skip when isolation is required |
| S10-W4 | Candidate-bound SAST evidence: versioned, candidate/workspace-bound artifact with tool identity, raw-output digest, isolation evidence, findings; persist, load, and verify with tamper/stale/replay rejection; managed S4 security impact path requires it | implementation | SEQUENTIAL_AFTER_CONTRACT_FREEZE | W1, W3 | SAST evidence traceable to the exact current CandidateRevision; stale/tampered/missing evidence blocks; no fabricated PASS |
| S10-W5 | Real SAST execution: pinned free OSS Trivy binary, checksum-verified, run against a real planted-secret candidate workspace through the candidate-bound path; record tool version and evidence digest | verification | LEAD_OWNED | W4 | REAL_PROVIDER lane evidence produced by a real scanner, candidate-bound and reproducible |
| S10-W6 | Fail-closed audit: verify required missing tools/providers produce explicit FAIL blockers (never silent SKIP or fabricated PASS) across security/SAST paths | adversarial verification | LEAD_OWNED | W3, W4 | explicit `*_UNAVAILABLE`/`*_REQUIRED` blockers asserted by tests |
| S10-W7 | Documentation and evidence boundaries: STATUS/CONFORMANCE/LEDGER updates, lane separation, this WorkGraph | documentation | LEAD_OWNED | all | truthful evidence, no provider/isolation over-claim from fixtures |

### Frozen contract (W1)

`src/security/isolation.ts`:

- `detectIsolationCapabilities(root): Promise<IsolationCapabilitiesV1>` — `DETERMINISTIC`; reports provider (`bwrap`), executable, version, rootless, user/network namespace support, seccomp kernel availability, AppArmor status, Podman/Buildah availability, and exact missing requirements.
- `buildBwrapArgs(request, capabilities): { args, evidence }` — pure; minimal read-only root (`/usr`, `/etc`, `/bin`, `/lib*`, `/sbin`), explicit toolchain binds derived from `PATH` and `process.execPath`, workspace read-only by default with explicit writable paths, `--unshare-*` namespaces, `--clearenv` plus allowlisted environment, `--die-with-parent --new-session`.
- `runIsolatedCommand(request): Promise<IsolatedCommandResultV1>` — real execution; throws `IsolationProviderUnavailableError` (`ISOLATION_PROVIDER_UNAVAILABLE`) rather than skipping when the provider is missing.
- `IsolationExecutionEvidenceV1` — provider/version, namespaces, network access, visible read-only roots, masked host paths, writable paths, environment allowlist, `noNewPrivileges`, `seccomp: "not-applied"`, command digest.

`src/security/sastEvidence.ts`:

- `SastEvidenceV1` — candidate `{candidateId, revision, identityDigest}`, workspace source-digest match evidence, tool identity/version, command digest, optional isolation evidence, status, normalized findings, raw-artifact digest, timestamps, blockers, canonical digest.
- `persistSastEvidenceV1`, `loadSastEvidenceV1`, `verifySastEvidenceV1` — candidate-scoped artifact path under the evidence output directory; digest recomputation; stale/wrong-candidate/tamper rejection with explicit blockers (`SAST_EVIDENCE_REQUIRED`, `SAST_EVIDENCE_STALE`, `SAST_EVIDENCE_TAMPERED`).

## Delegation Assessment

Profiles listed with `list_profiles`: `DeepSeek V4.1 Flash Implementer` (`opencode/opencode-go/deepseek-v4.1-flash`, build, max thinking) and `Luna Lead` (`codex/gpt-6-luna`, full access, xhigh).

- **Delegated (background, isolated worktree):** `S10-BASE` baseline-gap reproduction to the Flash Implementer profile in a Paseo `branch-off`/worktree workspace created from the committed baseline `0afebcd` (`wks_37ea8b7888fcc666`). Scope: read-only source/test inspection, real command probes, one evidence file `docs/evidence/s10/baseline-gaps.md`, no commits/pushes, no nested delegation, no AEH operation against this checkout. Purpose: independently reproduce which S10 gate items are unmet at the baseline before implementation.
- **Delegation rejected for writer units in this slice:** the campaign forbids commits; an isolated worktree cannot receive the lead's uncommitted implementation, so parallel writer integration would either require commits or shared-tree writes. Parallel writer delegation is therefore not used. Verification is delegated instead.
- **Duplicate-writer protection:** no concurrent writer mutates the primary checkout; the delegated worker only writes inside its own worktree. Integration of any delegated artifact is selective and reviewed by the lead; workers never delegate further.

## Evidence lane plan

- CONTRACT/UNIT: isolation argument/detection contracts, SAST evidence persist/verify/tamper, fail-closed adapters.
- INTEGRATION/SYSTEM_DETERMINISTIC: real bwrap execution campaign (kernel-level isolation).
- ADVERSARIAL: network egress attempt, writes outside workspace, host-home/credential visibility, PID visibility, env leakage, required-tool absence.
- REAL_PROVIDER: real Trivy `v0.70.0` scan bound to a real candidate workspace; explicitly local OSS, not a hosted/paid provider.
- OPA_PROVIDER: still unavailable; recorded, not claimed.
- PACKED_E2E/BROWSER: not claimed by S10.

## Execution record (2026-09-25)

| WorkUnit | Disposition | Evidence |
| --- | --- | --- |
| S10-W0 | DONE | Prerequisite `npx vitest run tests/candidateIdentity.test.ts tests/security/toolActionGate.test.ts tests/security/controllerFencing.test.ts` — 3 files / 23 tests passed; environment facts captured above. |
| S10-W1 | DONE | `src/security/isolation.ts`; config/type/schema surface; `tests/security/isolation.test.ts` 10 tests passed. |
| S10-W2 | DONE | `tests/system/aehIsolationCampaign.test.ts` 3 tests passed against real `bwrap 0.13.0`; real `ENETUNREACH` egress failure; host PID/home/env masking; workspace-only host writes. |
| S10-W3 | DONE | Isolation wiring in `src/validators/external.ts`, `toolCommand.ts`, `commands.ts`, `registry.ts`, `core/verify.ts`, `core/run.ts`; `tests/security/validatorIsolationFailClosed.test.ts` 5 tests passed. |
| S10-W4 | DONE | `src/security/sastEvidence.ts`; S4 security impact path requires candidate-bound evidence; `tests/security/sastEvidence.test.ts` 8 tests passed. |
| S10-W5 | DONE | `tests/packed/s10RealSastCampaign.mjs` against built release `release-1790389747122-486790-a8c37684`: r1 FAIL (github-pat finding), r2 PASS, stale check for r1→r2, all assertions true; `docs/evidence/s10/real-sast-campaign.json`. |
| S10-W6 | DONE | `tests/security/providerFailClosed.test.ts` 4 tests passed (OPA enabled+missing executable FAIL, disabled SKIP, no-command required adapter FAIL). |
| S10-W7 | DONE | This document plus STATUS/CONFORMANCE/LEDGER/SECURITY updates; lane boundaries kept separate. |

**Delegation outcome:** the bounded Flash worker reproduced the pre-S10 gaps in its isolated worktree and produced `docs/evidence/s10/baseline-gaps.md` (selectively integrated, unchanged). It confirmed: no rootless execution provider was wired; isolation was asserted only by argument arrays; validator commands ran as host children; SAST artifacts were not candidate-scoped; `opa`/SAST tools were absent; a missing required `opengrep` already produced a deterministic FAIL. The worktree had no `node_modules`, so its vitest rerun used a `/tmp` mirror of the same commit; this is recorded in the artifact. No writer delegation was used, per the assessment above.

**Focused suite totals:** 5 files / 30 tests passed (`tests/security/isolation.test.ts`, `tests/security/sastEvidence.test.ts`, `tests/security/validatorIsolationFailClosed.test.ts`, `tests/security/providerFailClosed.test.ts`, `tests/system/aehIsolationCampaign.test.ts`). `npm run typecheck` exit 0; `npm run build` exit 0 (`release-1790389747122-486790-a8c37684`); full non-system suite 175 passed / 1 skipped files (1,134 passed / 7 skipped tests) with the pre-existing `tests/paseoSdkResolve.test.ts` environment failure reproduced at baseline `0afebcd`; scenario+concurrency+isolation system lanes 3 files / 20 tests passed; adversarial 26 passed with the two long-recorded S6 fixture failures unchanged.

**Remaining provider lanes (not faked):** rootless Podman/OCI execution is unprovisioned (`podman`, `buildah`, `crun`, `slirp4netns`, `fuse-overlayfs` absent; no `sudo`); live OPA evaluation remains unavailable; hosted-provider, BROWSER, and complete PACKED_E2E certification are owned by later slices.

## Independent review remediation — 2026-09-26

**Finding (SLICE_REJECTED):** the isolation campaign's host-home probe tested `${os.homedir()}/Desarrollo`, which npm/npx turns into a bwrap bind-destination parent by prepending `<repo>/node_modules/.bin` to `PATH`. Under the canonical invocations `npm test -- tests/system/aehIsolationCampaign.test.ts` and `npx vitest run tests/system/aehIsolationCampaign.test.ts` the probe therefore reported `host_repo=visible` even though host repository contents remained masked. The campaign passed only with a direct `./node_modules/.bin/vitest` invocation, so the recorded evidence was not reproducible under the repository's canonical command. A secondary documentation inconsistency stated the repository was read-only without the configured-validator workspace exception.

**Repair:** the probe now creates a host-only sentinel directly under the home root (`.aeh-s10-host-sentinel-<pid>`), asserts `host_home_sentinel=masked`, and removes it in `finally`; it no longer depends on bind-destination parent directories. The STATUS security row now documents the workspace exception consistently with SECURITY.md.

**Re-verification:** `npm test -- tests/system/aehIsolationCampaign.test.ts` — 1 file / 3 tests passed; `npx vitest run tests/system/aehIsolationCampaign.test.ts` — 1 file / 3 tests passed; focused S10 set — 5 files / 30 tests passed; `npm run typecheck` exit 0; `git diff --check` clean. A fresh independent reviewer owns re-acceptance.

## Final re-acceptance and acceptance-gap closure — 2026-10-01

The historical rejection and repair above remain unchanged. A fresh independent S10 reviewer returned **`SLICE_ACCEPTED`** for reviewed head `87144f77a0c99088d385e848925643b5439422ea`. The canonical artifact is [review-s10-final.json](evidence/s10/review-s10-final.json), SHA-256 `f940aa6a72587bccf800ceade409de9b22c175af21fa83b2b99cd63e3362a9cc`. This closes the S10-specific acceptance-artifact gap; it is not a full historical S10 recertification and does not infer acceptance from S14 or closure.

### Source-impact classification

The reviewer compared S10 checkpoint `9b74c04167e79748312160b6476cc5050050b4e3` through the reviewed candidate and classified the relevant delta as follows:

- **UNCHANGED_CORE_CONTRACT:** `docs/CORE_ARCHITECTURE_V2.md`, this WorkGraph's historical record, `src/security/isolation.ts`, `src/security/sastEvidence.ts`, `src/validators/commands.ts`, `src/validators/toolCommand.ts`, `tests/security/providerFailClosed.test.ts`, `tests/security/sastEvidence.test.ts`, and `tests/security/validatorIsolationFailClosed.test.ts`.
- **TEST_FIXTURE_CHANGE:** the HOME/PATH/secret restoration and bind-overlap checks in `tests/system/aehIsolationCampaign.test.ts` and `tests/security/isolation.test.ts`; executable Trivy resolution/tamper evidence in `scripts/s10-trivy-resolver.mjs`, `tests/s10TrivyResolver.test.ts`, and `tests/packed/s10RealSastCampaign.mjs`; adjacent candidate/provider regressions remain fail-closed.
- **INTEGRATION_EXTENSION_COMPATIBLE:** candidate requirement traceability and provider-lane additions in `src/core/run.ts`, `src/core/verify.ts`, `src/validators/external.ts`, `src/validators/registry.ts`, `src/architecture/{candidateAssurance,validationRequirements}.ts`, `src/validation/laneEvidence.ts`, associated schemas/config, and current evidence docs. SAST candidate binding and security/dependency assurance floors are retained.
- **CI_ENVIRONMENT_CHANGE:** `.github/workflows/ci.yml`, `.harness/toolchain.yaml`, `package.json`/lock, `templates/provider-versions.json`, `templates/toolchain.yaml`, and provider setup scripts provision real rootless bwrap and pinned provider lanes. Existing required jobs remain; the rootless job has no skip or `continue-on-error` path.

The fresh review found **no material S10 product-contract change** and **zero unknown classifications**. The source changes preserve the fail-closed behavior; adjacent integration additions strengthen candidate-bound verification.

### Fresh deterministic, hosted rootless, and fail-closed evidence

- Focused local S10 command passed **5 files / 30 tests**, including the actual system isolation campaign **3/3**; the Trivy resolver regression also passed **2/2**. The campaign creates HOME beneath the actual host home outside `/tmp`, `/var/tmp`, fixture/workspace roots, and explicit toolchain binds; proves the sentinel and SSH directory exist before sandboxing and are masked inside; verifies visible toolchain paths; and restores HOME, PATH, and the prior secret value.
- Exact hosted rootless evidence is [CI run 36881830507](https://github.com/JamesMorales04/agentic-engineering-harness/actions/runs/36881830507), head `87144f77a0c99088d385e848925643b5439422ea`, job `110435254361` (`rootless-isolation`). Required bwrap `0.6.1` passed the non-root preflight (`CapEff=0`, `NoNewPrivs=1`) and all three real namespace, mutation, validator, and egress assertions. The job used `npm run test:rootless-isolation`; no skip/continue-on-error substituted for execution. The hosted merge tree equals the reviewed candidate tree (`13103c24b8bf0f7651baefc424d18dbf2bbf5af6`).
- The exact-SHA CI run completed **13/13 jobs**. Its generic test job retained only the existing provider-gated skip; the dedicated `provider-contracts` job passed **17 tests across 4 files** with pinned tools and real Engram startup.
- Current fail-closed regressions passed: `tests/security/validatorIsolationFailClosed.test.ts` (5), `tests/security/sastEvidence.test.ts` (8), `tests/security/providerFailClosed.test.ts` (4), `tests/security/isolation.test.ts` (10), and `tests/s10TrivyResolver.test.ts` (2). Required isolation or scanner absence fails explicitly; optionality is explicit and no missing provider is fabricated as PASS.

### Clean candidate-bound real SAST

The clean-build REAL_PROVIDER artifact is [real-sast-campaign-85877349558477e21386d6e076393d15e2a90e26-release-1790866583369-387000-cc8194fb.json](evidence/s10/real-sast-campaign-85877349558477e21386d6e076393d15e2a90e26-release-1790866583369-387000-cc8194fb.json), SHA-256 `36a871fd9c8fcafdbb4c116b1d2974fa385ab17e510ba74bdbbf6a430b8e3641`. `BuildIdentity` binds Git SHA `85877349558477e21386d6e076393d15e2a90e26`, release `release-1790866583369-387000-cc8194fb`, build digest `93fb2b413e748a3fdc9070a0cf6c0100facd37f15894dea7ce4904dacd258bbe`, and `dirty:false`. The pinned local OSS Trivy is v0.70.0, binary SHA-256 `379d59f24a4a828c55de5f0b91b6805cc35d13580180b658820e648611256166`; real bwrap 0.13.0 denied network and recorded namespace/isolation evidence.

Candidate `CAND-S10-REAL` r1 identity `8648ef7b56d0ecab99eef2cbe33028c6696f4bb26fe11d86270f40de9a850e9b` and source/workspace digest `219debfd791e9a5c71a393f0934bdf57627dca92f583d2a7af59737c40b40a32` produced a real FAIL with one `github-pat` finding. Revision 2 identity `154b31f503fcf1da67b1eedbc336ff815a390c28d4beb89fc425231397651ff7` and source/workspace digest `621e7c4125bbe9fde0f3c97c4baee0ac14dd0298a2c5218a985dea0540b8ef2b` produced a clean PASS. The campaign asserted exact candidate binding, tool/version and raw-output digests, stale-revision rejection, tampered-evidence rejection, and no fabricated PASS; all assertions returned true.

### S14 and closure staleness

No S14 composite regeneration was required. The new S10 SAST artifact is additive and is not a composite input; the historical pinned SAST file remains byte-identical at SHA-256 `3a106006801c7b03e79795b8beedc4af240facd16ee78675d8f8194fd7848779`. S14 manifest `docs/evidence/s14/certification-evidence-manifest.json` remains SHA-256 `d8c4a69da36f0b7c29788380aaa6802b3ff1a0bc1346e7f1bb2f3019c7207d3c`; closure manifest `docs/evidence/closure/certification-evidence-manifest.json` remains SHA-256 `ff1b5b113adeae34c88abdd6aaa5c2a4770f98a8d3b47cb8dd521def4ea54b9a`. The reviewer confirmed exact composite input bytes unchanged and `s14RerunRequired:false`.

The normative TARGET remains SHA-256 `4954b62bfb3a820fc6e5d0369b2d37bc35a94988d19e485f00d30675aafa555a`. S10 is **ACCEPTED** for its reviewed scope; OPA live evaluation and rootless Podman/OCI execution remain unclaimed provider lanes.
