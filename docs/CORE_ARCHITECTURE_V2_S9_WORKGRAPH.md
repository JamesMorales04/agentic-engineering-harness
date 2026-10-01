# S9 Tactical WorkGraph — Runtime Supervision & Control Center

## Fresh S9 SDK contract remediation — confirmed, 2026-09-25

**Scope:** Same-slice S9 only; S10 remains locked. This remediation is on the supported packed public `aeh start <project> --no-open --no-setup --new` entry path. Luna changed only the SDK adapter and affected SDK expectations after the bounded regression was reviewed red; no runtime ownership, service lifecycle, authority, or UI change was made for this remediation. No commits or pushes are authorized.

### Director evidence and corrected prior hypothesis

- The earlier one-shot sandbox daemon-lifetime theory and stale runtime-owner retry theory are **false leads**. The Director reproduced the actual packed flow in a persistent elevated shell: Paseo daemon startup and reachability succeeded.
- The real failure is the Paseo SDK adapter contract mismatch. Packed `aeh start` throws `Error: Expected config.provider in "provider/model" format` from installed `@getpaseo/client` 0.9.1 `toDaemonAgentCreateOptions`.
- Director source inspection established that the installed client parses `agent options.config.provider` as one combined provider/model string. `src/paseo/sdk.ts:buildCreateOptions()` currently calls `normalizeProviderModel()` and sends split `config.provider` plus `config.model`; this is rejected by that client. The authoritative failure is provider/model shape, not daemon persistence.
- After the SDK parse exception, the disposable root's runtime snapshot still reported the Paseo daemon service as READY with owner PID `3771458`; `ps -p 3771458` confirmed that PID was gone. No provider leases had been created. READY describes the reachable Paseo daemon, while Lead creation failed before provider-session creation. The dead process owner is eligible for normal service takeover under the existing supervisor rule; it did not block the retry. Do not add stale-owner recovery or change service ownership semantics for this finding.
- Package evidence is `/tmp/s9-director-pack/agentic-engineering-harness-0.8.4.tgz`, SHA-256 `6727f2f0f9bf22339ce28d67aa89a22232c78906d7510ff53e95cc08524adeb3`, extracted at `/tmp/s9-director-packed-fixture/package`, `dist/current=release-1790335491733-35-b0f6a84b`.
- Preserve this correction in the work history: the earlier provisional retry hypothesis was not reproduced in a persistent shell; do not make or report a runtime ownership change for it. No separate service-failure cleanup change or test is in scope because the daemon itself was READY and no provider session/lease had been created.

### Frozen SDK adapter contract

1. Keep the AEH-side `PaseoSdkAgentOptions` provider and model inputs as the caller-facing identity. At the Paseo client boundary, encode them in installed SDK 0.9.1's required `config.provider` combined `<provider>/<model>` representation. Do not emit the rejected split `config.provider` and `config.model` pair.
2. Preserve all other launch semantics and config fields (title, cwd, initial prompt, system prompt, mode/thinking where supported, MCP servers/tool policy, env, workspace, labels, output schema, parentage, and session/ExecutionBinding identity). Do not alter Paseo daemon service status/ownership semantics: READY reports daemon health and is independent of Lead materialization. No caller, runtime selection, lease, authority, lifecycle, or public CLI behavior changes are authorized by this fix.
3. If the current SDK boundary cannot unambiguously produce its required provider/model string from supported input, fail explicitly before calling the client; do not add a test-only route or silently guess/fallback to an alternate execution path.
4. The regression must exercise the existing exported SDK adapter seam used by public `aeh start`, capture the exact `agents.create` options, and fail on current code because `config.provider` is not combined and `config.model` is emitted. It must pass only when the production adapter sends the accepted combined shape while preserving unrelated launch fields.
5. The actual product validation must reuse the same disposable project root that failed with the SDK contract error and successfully retry through the fixed packed public `aeh start`, returning its actual product/pairing URL. Record package/build identity and a credential-free runtime snapshot digest/status. The Director's failed attempt showed Paseo READY with owner PID 3771458 already gone and no provider leases; do not add a service-cleanup assertion for that SDK parse failure because the daemon had been reachable and no provider session/lease was created.
6. In the mandatory real Playwright journey, the decision presented to the human must expose enough current binding data to review its scope: operation identity, candidate identity/digest, policy digest, `operationExecutionRevision`, and controller epoch. `DecisionRequest` may already carry the bindings even if the current App does not render them. Director source review reports that the current card lacks candidate/policy/revision/epoch; this remains static evidence only. Keep R10 conditional until the actual browser surface confirms the omission. Before any UI edit, compare the rendered result with normative target sections 3.3 and 13 and this S9 contract; if confirmed, activate same-slice UI work and add focused UI regression coverage.
7. Durable browser evidence must not persist pairing/auth tokens or nonces. Capture only sanitized URLs/requests and redact credentials from logs, screenshots, traces, and receipts before storing them.
8. Unit, API, fixture, or package adapter tests do not establish browser acceptance. The actual Chromium/Playwright journey remains a separate Campaign Director gate.

**Classification:** provider/model shape transformation is `DETERMINISTIC`; validating the adapter against the installed SDK contract and the actual public start path is `HYBRID` (deterministic shape plus independent provider observation). No architecture target change is needed or allowed.

### Fresh remediation WorkUnits

#### S9-R7 — Freeze the SDK contract and affected call surface

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** Director's persistent-shell error and SDK 0.9.1 source inspection; accepted S3 authority, S5 session/context identity, and S8 effect boundary.
- **Files/areas:** read-only audit of `src/paseo/sdk.ts` and its callers/tests; this WorkGraph is the only current write scope. `docs/CORE_ARCHITECTURE_V2.md` remains excluded.
- **Call path:** public `aeh start` -> `startPaseoHarness` -> `launchManagedPaseoAgent` -> the legacy idle-lead launch in `runtimeCore.ts` -> `createPaseoSdkAgent` -> `createPaseoSdkAgentWithClient` -> `buildCreateOptions`. Operation-owned create/materialize calls also converge on the same SDK builder, with lifecycle leases remaining outside the option-shape correction.
- **Affected current assertions:** `tests/paseoSdk.test.ts`, `tests/paseoOperationParenting.test.ts`, and `tests/opencodeManagedPaseoModeRegression.test.ts` assert the split provider/model shape and should be updated only after reviewing the bounded regression. Other adapter call sites include `tests/paseoAtomicSdkTurn.test.ts` and `tests/paseoPendingExecutionIdentity.test.ts`; Luna will check their assertions after integration.
- **Acceptance:** freeze the required outgoing create-option shape and list source callers plus existing tests that encode the superseded split shape before any production edit. Keep the false-lead lifecycle diagnosis explicitly closed.

#### S9-R8 — SDK provider/model contract regression

- **Ownership label:** `FLASH_DELEGATABLE`
- **Mechanism:** `DETERMINISTIC`
- **State:** authorized after R7 and the Director confirmation; tests-only unit, one worker, no nested agents/children.
- **Dependencies:** R7 contract freeze; isolated Paseo worktree based on current committed source; freshly call `list_profiles` immediately before launch and materialize the selected DeepSeek profile's provider/model/mode/thinking/features exactly.
- **Files:** new `tests/paseoSdkProviderModelContract.test.ts` only. The worker may inspect `src/paseo/sdk.ts` and current SDK tests, but may not edit production source, existing tests, docs, UI, packed fixtures, or other files.
- **Acceptance/tests:** call the current exported `createPaseoSdkAgentWithClient` with explicit provider and model; capture the actual `agents.create` argument; assert `config.provider` uses the exact combined form (including a model ID containing `/` if supported), the split `config.model` is absent, and unrelated launch options survive. Run only the assigned focused test. It must fail against committed/current source before any production change, with the precise mismatch reported. Do not add service cleanup coverage for the false-lead retry theory.
- **Explicit exclusions:** no production edits, no additional tests/files, no packed/browser/live-provider claims, no commits/pushes, no S10, and no delegation.

#### S9-R9 — Luna integration and public-path repair

- **Ownership label:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`
- **Mechanism:** `HYBRID` (deterministic adapter/test changes with Luna review and Director's independent product-path check).
- **Dependencies:** R8's reviewed red regression; Luna's current-callers audit; frozen SDK contract above.
- **Production scope:** `src/paseo/sdk.ts` only unless call-site/type inspection demonstrates another directly required S9 file. Preserve S1/S3/S5/S8 contracts and existing public start behavior.
- **Test scope:** selectively integrate the worker's new regression after inspecting its complete diff and independently confirming the expected failure on old source; update only affected existing SDK tests that assert the rejected shape; rerun all adapter callers affected by the new shape.
- **Acceptance:** focused SDK/Paseo start tests, affected S9 suites, typecheck/build and `git diff --check` pass. Build a fresh package and drive the supported public packed `aeh start` path against the persistent Paseo daemon using the same disposable project root from the failing SDK attempt; capture its real returned product/pairing URL and exact package/build identity. No source or test-only alternate route may stand in for that command.
- **Handoff:** return the URL, package digest, start transcript, and exact changed paths to the Campaign Director for the mandatory actual Chromium/Playwright UI journey. The journey must verify the decision card exposes operation identity, candidate identity/digest, policy digest, `operationExecutionRevision`, and controller epoch; static code inspection currently suggests some bindings may not render, but no UI edit is authorized until the real surface is checked against target sections 3.3/13 and this frozen contract. Store sanitized evidence only; no auth token or nonce may enter durable artifacts. Browser PASS is only recorded from Director's independent end-to-end run.
- **Explicit exclusions:** no S10, no normative target edit, no commits/pushes, and no S9 acceptance claim.

#### S9-R10 — Decision-scope visibility, conditional on browser confirmation

- **Ownership label:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`
- **Mechanism:** `HYBRID` (deterministic projection/rendering of authoritative bindings, with the human reviewing semantic scope).
- **Dependencies:** the R4 actual browser journey and confirmation against normative sections 3.3/13 plus the frozen scope-visibility clause above.
- **Current read-only observation:** `DecisionRequest` and the API parser carry operation ID, candidate digest, policy digest, `operationExecutionRevision`, and controller epoch. Luna and Director source review find that the current product-choice card visibly shows operation ID/kind/phase and expiry, but does not render candidate/policy/revision/epoch fields in that card. This is static source evidence only; the actual product surface must be reviewed before changing UI.
- **Files if confirmed:** `ui/control-center/src/App.tsx`, minimal relevant styles, and focused UI/Control Center regression tests. No API contract change is presumed because the typed request already carries the bindings.
- **Acceptance if activated:** actual browser displays enough of each current binding to let the paired human review operation/candidate/policy scope before submitting; UI still submits only offered choice identity; current actor/scope checks stay server/controller-owned. Persisted screenshots/traces/network/controller receipts contain no auth token or nonce (sanitize URLs and headers before durable storage). Re-run the real browser journey after any UI change.
- **State:** conditional; not activated by source review alone. No UI file was changed for the SDK adapter remediation. Director must confirm the rendered surface in the real browser; if confirmed, activate bounded same-S9 UI work and keep the fix within the frozen decision contract.

### Fresh delegation assessment

The one-file deterministic SDK regression is safely separable from production integration. The Director explicitly authorized that bounded Flash unit. Fresh `list_profiles` immediately before launch returned profile `DeepSeek V4.1 Flash Implementer`; settings were materialized exactly as provider/model `opencode/opencode-go/deepseek-v4.1-flash`, mode `build`, thinking option `max`, features `{ "auto_accept": true }`. Agent `89c0cac2-2413-47ec-a3e2-4843acff1666` was created in Paseo workspace `wks_87eaa11acfffb2eb` at `/tmp/aeh-s9-sdk-provider-model-contract`, a detached Git worktree at `c03647107bc8b8e4464afd4d8a189ac80e7a01aa`. Its sole writable path is `tests/paseoSdkProviderModelContract.test.ts`; it was explicitly told not to create children. The primary dirty checkout is not the worker's writable tree.

### Current disposition

This paragraph records the disposition at the time of the first SDK remediation and is superseded by the later R11 freeze below. The SDK shape mismatch was repaired and packed `aeh start` succeeded. The stale-owner hypothesis remains closed as a false lead. The actual paired browser then exposed the separate LeadGateway defect documented below. S9 remains open; do not start S10.

## Updated same-slice remediation graph — 2026-09-25

**Remediation scope:** S9 only. The accepted S8 base remains `c03647107bc8b8e4464afd4d8a189ac80e7a01aa`; the current checkout contains the attributable first-attempt S9 changes listed in the initial status audit. This graph supersedes the initial execution plan below for remaining work. It does not authorize S10.

### Retained first-attempt work

- Retain the root-locked, reload/validate/atomic-persist runtime snapshot and deterministic `RuntimeSupervisorV1` / `ManagedRuntimeSupervisorV1` acquire, renew, release, expiry, service, drain, and cleanup implementation in `src/runtime/supervisorV2.ts` and `src/runtime/managed.ts`, plus its tests. S9-R2 now connects these methods to operation-owned Paseo materialization and participant/Lead turns through `runWithOperationProviderLease`; deterministic adapter tests and the packed restart campaign cover this path. No live-provider claim is made.
- Retain the pure durable-record projector in `src/control-center/operationProjection.ts` and `tests/controlCenterOperationProjection.test.ts`, including exact current-binding checks before projecting a waiting choice.
- Retain the typed stage/blocker, participant-error, service, and provider-lease projection changes in `src/control-center/contracts.ts`, `src/entry.ts`, and `ui/control-center/`; retain the existing server-side current-binding, paired-actor, expiry, replay, CSRF, cancellation, and S8 effect-boundary checks.
- Retain Control Center service heartbeat and shutdown drain/release, UI cancellation, and the first fixture-backed browser journey as their existing deterministic/BROWSER_FIXTURE evidence only.
- Retain all first-attempt test and documentation changes as reviewable S9 work. Repair any same-slice defects found during this remediation. Close each approved gap only after its required evidence is recorded; the durable-operation browser journey remains open. `docs/CORE_ARCHITECTURE_V2.md` remains excluded.

### Frozen remediation contract

1. The production Paseo managed-session adapter is the provider boundary to wire. Each operation-owned provider session lifecycle must acquire and durably expose a managed provider lease, renew it while a provider call is active, and release it only after the adapter observes a settled/idle or terminal provider state. A timeout, stop failure, provider error, process restart, or unavailable status must not be treated as proof of quiescence.
2. Every acquire, renewal, release, takeover, and cleanup must be checked against the current durable operation, candidate, operation execution revision, frozen policy digest, controller token/epoch, and applicable participant/generation. A stale owner fails closed. Session ID and ExecutionBinding remain the S1/S5 identity; lease ID is resource-ownership evidence only and grants no capability.
3. An expired lease does not by itself prove that its external provider session stopped. Before takeover, inspect and, where current controller authority permits, stop and re-observe the previous provider session. If its lifecycle remains uncertain, retain/fence ownership and keep the operation out of terminal success/cancellation until cleanup or reconciliation is proven.
4. Cancellation retains S3's current scoped HumanDecision and epoch-claim checks. It stops/fences operation writers, proves provider sessions settled, releases their managed leases, reconciles uncertain effects, and only then permits `CANCELLED`. Resume reloads and revalidates the current S1/S5 identity before provider work restarts.
5. The browser lane must submit a current scoped choice through the paired UI/server route, persist and consume its exact one-time decision through the controller, resume/revalidate the durable continuation, and show the refreshed projection. Cancellation must traverse the same paired server/controller boundary. A fixture may replace model/provider behavior but may not return unconditional success or write accepted state directly.

The production seam frozen for R2/R3 is `runWithOperationProviderLease` in `src/runtime/providerLifecycle.ts`. The Paseo adapter calls it around SDK session materialization and every operation-bound participant or bound Lead turn. Each lifecycle call gets a unique lease owner ID, so overlapping writes from the same operation and epoch conflict under the same provider/workspace scope. Its input binds control root, configured model provider, provider workspace, operation ID, the current participant or exact bound Lead generation, actual session ID when known, and the S1 `ExecutionBindingV2` when already compiled; inspection, stop, and discovery use the Paseo runtime boundary. The lease's `provider` value records the configured model backend; its `sessionId` is still inspected and stopped as a Paseo-managed session, independent of that backend string. The action returns `{ value, sessionId? }`, so the adapter persists the actual provider session before release. Durable `ProviderLeaseV1.lifecycle` records operation/candidate/execution revision/policy/token digest/epoch, participant or Lead-generation identity, binding/session identity, and `ACTIVE` or `UNCERTAIN`; lease expiry fences renewal but never erases evidence or permits takeover. Takeover consumes only a newer current epoch and explicit observed quiescence of that exact prior session. R3 tested the participant branch; Luna added bound-Lead generation, stale-owner cleanup, and same-controller writer-serialization regressions after integration. The production call shape stayed frozen.

### Remediation WorkUnits

#### S9-R1 — Freeze the production adapter and evidence interfaces

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** accepted S3 authority and accepted S5 execution/session/context identity; current S9 first-attempt source audit; unchanged normative target.
- **Files/areas:** `src/paseo/runtimeCore.ts`, `src/paseo/launchSpec.ts`, `src/runtime/supervisorV2.ts`, `src/runtime/managed.ts`, `src/operations/controller.ts`, and their focused tests.
- **Invariants:** apply the frozen remediation contract above; keep operation state/controller token authoritative, lease authority disjoint from capability leases, and actual session identity bound by S1/S5; no compatibility branch or normative edit.
- **Acceptance criteria:** identify the exact production create/materialize/continue/wait/stop calls to wrap; freeze the injected lifecycle/probe seam and durable binding fields that R2/R3 use. If the target cannot support safe takeover or reconciliation without a normative change, stop with `ARCHITECTURE_DECISION_REQUIRED`.
- **Tests:** source and contract review only before the interface is frozen; after freeze, use the named adapter/lifecycle regression suites.

#### S9-R2 — Wire managed leases into production Paseo lifecycle

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-R1; current S3 controller ownership; S5 actual-session and ExecutionBinding checks.
- **Files/areas:** `src/paseo/runtimeCore.ts`, `src/paseo/launchSpec.ts`, `src/runtime/supervisorV2.ts`, `src/runtime/managed.ts`, `src/operations/controller.ts`, and new focused provider-lifecycle tests.
- **Invariants:** validate current operation/candidate/policy/execution revision/epoch before acquire and each renewal; renew only for the current owner; lease identity never grants capability or substitutes for a session ID; do not release or take over uncertain sessions; operation-owned SDK-unavailable materialization must fail closed instead of entering the unleased CLI lifecycle; preserve cancellation's stop/reconciliation gate and S8 acceptance boundary.
- **Acceptance criteria:** real production Paseo managed-session calls consume the existing managed lease API; acquire/renew/release and provider session identity appear in durable runtime snapshots; active calls renew; stale epoch/owner, unsupported unleased fallback, and uncertain provider state fail closed; cancellation cleanup releases only after the current fenced controller proves writer/session shutdown.
- **Tests:** focused tests in `tests/runtimeSupervisorV2.test.ts`, `tests/processCleanup.test.ts`, `tests/security/controllerFencing.test.ts`, `tests/operations.test.ts`, `tests/operationLifecycleRegression.test.ts`, `tests/operationStateDurability.test.ts`, `tests/paseoInitialTurnBarrier.test.ts`, plus new injected Paseo runtime lifecycle tests.

#### S9-R3 — Provider lifecycle fault-injection regressions

- **Ownership label:** `FLASH_DELEGATABLE`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-R1 and a frozen S9-R2 lifecycle interface; run only after Luna has made that interface available in the isolated worker checkout.
- **Files/areas:** one new focused test file, `tests/paseoProviderLeaseLifecycle.test.ts`, only. The worker may read the assigned runtime adapter and lease contracts but may not edit source, operation/control-center contracts, UI, docs, or any other tests.
- **Invariants:** test through the production adapter seam; do not mock away managed lease persistence, current-binding checks, provider quiescence, or cancellation fencing; do not claim REAL_PROVIDER or PACKED_E2E; do not create agents or delegate.
- **Acceptance criteria:** deterministic fault injection proves renewal during a long call; renewal failure prevents stale continuation; provider timeout/stop uncertainty retains fencing; prior-session takeover requires observed quiescence; stale epoch cannot renew/release or stop a session; overlapping same-controller writes conflict; current settled lifecycle releases exactly once. Tests cannot mutate accepted fixtures or relax frozen checks.
- **Tests:** the assigned new test file only, run in the separate Paseo worktree; Luna independently reviews and reruns it after transplant.
- **Explicit exclusions:** no source changes, production provider call, packed campaign, browser flow, normative/status/conformance edits, commits, pushes, or nested delegation.

#### S9-R4 — Durable-operation Control Center browser journey

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `HYBRID` (real browser/server/controller boundaries plus deterministic disposable operation/provider fixtures).
- **Dependencies:** existing current-binding Control Center route and controller continuation contracts; S9-R2 cancellation lease cleanup where applicable.
- **Files/areas:** `src/control-center/`, `src/entry.ts`, UI Control Center, and one isolated browser journey harness under tests/scripts; disposable packed consumer and operation data must live outside the development checkout.
- **Invariants:** preserve paired human actor, current candidate/policy/revision/epoch, expiry and replay checks; server derives identity; UI remains a projection; controller consumes/revalidates the persisted continuation; cancellation goes through the real scoped route; no direct accepted-state write.
- **Acceptance criteria:** a durable current `HUMAN_REQUIRED` operation is projected; browser submits one offered choice; the real ledger persists and the controller consumes it once; continuation identity is revalidated and resumed; browser observes the refreshed durable projection; replay/stale submission is rejected; a separate scoped cancellation reaches the controller fence and cleanup path.
- **Tests:** executable Playwright/agent-browser journey against the packed UI/server from a freshly packed temporary consumer, with fixture-only model/provider behavior; retain screenshot/network/controller receipts and exact HTTP/controller outcomes. The Paseo bridge was checked directly and returned `No browser automation host is connected.`; this browser-only acceptance criterion remains open. Existing paired-route/controller deterministic tests were rerun, but are not browser evidence.
- **Explicit exclusions:** no source-checkout AEH operation, no unconditional HTTP 200 fixture, no fake accepted operation state, no REAL_PROVIDER claim.

#### S9-R5 — Packed cancellation/takeover and restart-cleanup certification

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-R2 lifecycle integration; a current packed candidate extracted into an isolated disposable directory.
- **Files/areas:** `tests/packed/s9ProviderLifecycleCampaign.mjs`, packed `dist/` consumer artifacts, and test receipts only; the script is run against an extracted package under `/tmp`, and no test may import source while claiming packed evidence.
- **Invariants:** exact packed boundary is recorded; provider faults and process restart occur only in the disposable fixture; current-epoch fencing, writer stop proof, lease revoke/release, unresolved-effect reconciliation, and cleanup are asserted; no source-checkout AEH run.
- **Acceptance criteria:** provider wait/renew/stop faults exercise cancellation and controller takeover; restart loads durable snapshots, discovers previous owner/session, proves stopped or stays blocked, and cleans all fixture children, workspaces, locks, and runtime leases. Cancellation is terminal only after required proof.
- **Tests:** `node tests/packed/s9ProviderLifecycleCampaign.mjs /tmp/s9-packed-fixture-final4/package` runs packed takeover, injected stop failure, restart cleanup, and terminal-fence assertions; relevant source-importing system concurrency suite is reported as a separate lane. Final run passed against the freshly packed `agentic-engineering-harness@0.8.4` artifact at `/tmp/s9-packed-final4/agentic-engineering-harness-0.8.4.tgz`; the campaign proved epoch 1-to-2 takeover after exact-session idle observation, stop-fault lease retention/nonterminal state, then scoped restart cancellation with idle proof, release, and `CANCELLED`. It used deterministic provider stubs and makes no `REAL_PROVIDER` claim. The final tarball digest is included in the S9 handoff report.

#### S9-R6 — Integration, evidence, and independent-review handoff

- **Ownership label:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`
- **Mechanism:** `HYBRID` (deterministic gates and lane-accurate evidence, with Luna semantic diff acceptance).
- **Dependencies:** S9-R2 through S9-R5 integrated; worker output reviewed; all relevant deterministic, type, build, browser, and packed lanes complete or exact blockers recorded.
- **Files/areas:** relevant S9 source/tests; `docs/CORE_ARCHITECTURE_V2_STATUS.md`, `docs/CORE_ARCHITECTURE_V2_CONFORMANCE.md`, `docs/ENGINEERING_LEDGER.md`, and this workgraph. `docs/CORE_ARCHITECTURE_V2.md` is excluded.
- **Invariants:** do not weaken tests; preserve accepted S3/S5 semantics and S8 public-effect gate; separate CONTRACT/UNIT/SYSTEM_DETERMINISTIC/BROWSER/PACKED_E2E/REAL_PROVIDER claims; no S10+ work; no commit or push.
- **Acceptance criteria:** complete diff reviewed; every one of the five S9 Gate claims has explicit evidence or remains an open blocker; approved gaps are closed only by lane-correct receipts; status/conformance/ledger agree and point to exact evidence.
- **Tests:** final focused S9 command passed 13 files / 137 tests; `npm run typecheck`, `npm run ui:build`, and `npm run build` exited 0, with direct build release `release-1790334556192-3490030-97632a32`; final `npm pack` and R5 packed campaign passed. Source-importing `tests/system/aehConcurrencyCampaign.test.ts` passed 1 file / 9 tests; `git diff --check` and final status are recorded after documentation update. The browser host check returned `No browser automation host is connected.`, so durable-operation browser resume/revalidation remains open.

### Updated delegation assessment

One meaningful bounded unit was delegated after Luna froze the production adapter seam: S9-R3 added deterministic fault-injection regressions in one new test file and did not widen authority or mutate implementation contracts. Agent `61faf06b-f587-4f86-8333-5e48a449f0a8` used profile provider `opencode`, model `opencode-go/deepseek-v4.1-flash`, mode `build`, thinking option `max`, and features `{ "auto_accept": true }`; its separate Paseo worktree was `/home/james/.paseo/worktrees/0jx5pvzi/s9-provider-lease-fault-tests`. The worker ran its assigned 12-test file four consecutive times successfully. Luna independently reviewed and reran the integrated suite, then added bound-Lead generation, stale-owner cleanup, and same-controller writer-serialization regressions. The integrated lifecycle file passes 15 tests. Luna owned provider/lease semantics, the frozen contract and production integration, authority/lifecycle/cancellation behavior, Control Center/browser and packed experiments, conflict repair, and final review. The required profile lookup was made immediately before delegation; the prompt included exact objective, file scope, dependencies, invariants, acceptance, tests, explicit exclusions, and `NO NESTED DELEGATION`.

### Status of prior work versus acceptance

The S9-W1 through S9-W5 plan below records the first attempt. Its implementation is retained as described above. S9-R2 production-adapter wiring, R3 fault injection, and R5 packed provider-fault/restart evidence now pass their deterministic lanes. R4 durable-operation browser resume/revalidation remains open because the Paseo bridge has no connected host; live-provider certification also remains distinct and unclaimed. No accepted gap was closed without lane-specific evidence, and S9 is not reported accepted.

---

**Slice:** S9 only
**Baseline:** `core-architecture-v2` at `c03647107bc8b8e4464afd4d8a189ac80e7a01aa` (accepted S8)
**Normative source:** `docs/CORE_ARCHITECTURE_V2.md`; S9 scope and dependencies are from `docs/CORE_ARCHITECTURE_V2_STATUS.md`; evidence lanes are from `docs/CORE_ARCHITECTURE_V2_CONFORMANCE.md`.

## Slice gate

Evidence must establish single-writer ownership, current-epoch fencing, safe cancellation/resume, accurate semantic operation and participant projections, and scoped Control Center decisions and controls. The implementation preserves accepted S3 authority/HumanDecision and S5 session/context semantics, keeps capability leases separate from ExecutionBinding identity, and leaves the S8 AcceptanceOracle-before-public-effect boundary unchanged. Deterministic, system, browser, packed, and real-provider evidence are reported independently.

## Work units

### S9-W1 — Freeze runtime and projection contracts

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** accepted S3 authority/HumanDecision and accepted S5 execution/session/context identity; verified S8 baseline.
- **Files/areas:** `src/operations/state.ts`, `src/operations/controller.ts`, `src/runtime/`, `src/control-center/contracts.ts`, `src/control-center/server.ts`, `src/entry.ts`, `ui/control-center/`.
- **Invariants:** controller token and epoch remain authoritative; provider leases do not become ExecutionBinding authority; candidate/policy/revision/actor checks remain current; product choice, action authorization, and operation control stay disjoint; no edit to the normative target.
- **Acceptance criteria:** define the smallest deterministic runtime lease lifecycle and Control Center read-model/control contracts that meet the existing target; reject ambiguous lifecycle behavior or stop with `ARCHITECTURE_DECISION_REQUIRED` if the target would need amendment.
- **Tests:** contract and focused source/test review before contract freeze; no new behavior is accepted by this planning unit.

### S9-W2 — Controller-owned provider/process lifecycle

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-W1; current S3 controller ownership and S5 session identity.
- **Files/areas:** `src/runtime/supervisorV2.ts`, `src/runtime/managed.ts`, `src/operations/controller.ts`, `src/operations/state.ts`, Paseo process lifecycle adapters, and focused runtime/operation tests.
- **Invariants:** one current owner per exclusive lease; expired/stale owners cannot renew or release a successor's lease; takeover/cleanup is fenced at each mutation by current operation/candidate/policy/execution revision/epoch where applicable; lease identity never substitutes for capability authority or session identity; uncertain process/provider effects remain active or reconciling until observed settled.
- **Acceptance criteria:** acquire, renew, release, expiry, takeover, persistence/reload, drain, and cleanup are owner-checked and reproducible; concurrent owners cannot both hold conflicting provider leases; terminal cancellation waits for writers and uncertain effects to settle; stale epochs fail closed.
- **Tests:** `tests/runtimeSupervisorV2.test.ts`, `tests/processCleanup.test.ts`, `tests/security/controllerFencing.test.ts`, `tests/operations.test.ts`, `tests/operationLifecycleRegression.test.ts`, `tests/operationStateDurability.test.ts`, and focused deterministic system concurrency/fault cases.

### S9-W3 — Pure semantic operation/participant projection

- **Ownership label:** `FLASH_DELEGATABLE`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-W1 frozen projection boundary and existing `OperationRecordV2`/Control Center contracts. This unit does not depend on W2 and may run in a separate Paseo worktree.
- **Files/areas:** new `src/control-center/operationProjection.ts` and new `tests/controlCenterOperationProjection.test.ts` only.
- **Invariants:** the durable controller record is the only source of operation/participant truth; preserve current operation status, phase, revision, candidate identity, and typed waiting decision as stored; do not infer state from logs/provider snapshots, fabricate participant skills/tools, mutate state, or edit contracts, controller/runtime code, UI, normative architecture, or unrelated files.
- **Frozen contract:** export `projectOperationRecordV1(record: OperationRecordV2): ControlCenterOperationDetailProjectionV1` from the new module. Populate operation `status`, `phase`, `revision`, timestamps, candidate ID/digest/project ID, error, and operation ID/kind directly from the record. Derive the existing participant counters from `record.participants` (failed count includes `FAILED` and `CANCELLED`, matching durable progress semantics). Project each durable participant's ID, operation ID, logical agent, role, phase, status, timestamps, and result artifact; `specializations`, `skills`, and `tools` are empty because those facts are not stored in `OperationParticipantRecord`. Use a bounded `payloadSummary` containing only operation kind and ID. Include `decisionRequest` only when the operation is RUNNING in `HUMAN_REQUIRED`, the persisted continuation is WAITING, and the request and continuation match the current operation/candidate/execution revision/policy/epoch; convert only the candidate field to the existing digest string form. Keep `expiresAt` for UI display/disable behavior; the server validates expiry at submission. No new fields or contract versions are part of this unit.
- **Acceptance criteria:** a pure projector produces the typed operation detail and participant list from `OperationRecordV2`; counts agree with the actual participant records; operation/participant error and blocked states remain visible through existing typed fields; unsupported or absent source facts stay absent/empty; terminal, stale, or non-waiting decision data is not projected as actionable.
- **Tests:** focused projection tests for empty/non-empty participants, mixed statuses, candidate identity, current waiting decision, stale/non-waiting decision omission, and error/blocker visibility; run only the assigned focused test.

### S9-W4 — Wire projections and scoped controls into Control Center

- **Ownership label:** `LUNA_OWNED`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-W1 and S9-W3; S9-W2 for the runtime service/provider lease projection.
- **Files/areas:** `src/entry.ts`, `src/control-center/contracts.ts`, `src/control-center/server.ts`, `src/control-center/decision.ts`, `src/control-center/index.ts`, `ui/control-center/src/api.ts`, `ui/control-center/src/App.tsx`, and existing Control Center tests.
- **Invariants:** Control Center remains a read projection; every mutation routes through current controller/identity checks; only the paired Human actor is supplied by the server; product choice and operation control use their distinct exact HumanDecision purposes; current S8 delivery gates do not move.
- **Acceptance criteria:** actual operations, participants, stages/blockers, runtime services, and provider leases are visible from authoritative durable state; decision and control inputs are typed, scoped, expiry/replay safe, and refreshed after acceptance; users can see the current state and available safe controls without being able to transition state client-side.
- **Tests:** `tests/controlCenter.test.ts`, `tests/controlCenterApiContracts.test.ts`, `tests/humanDecision.test.ts`, `tests/operations.test.ts`, UI typecheck/build, and a browser journey when a usable local browser lane is available.

### S9-W5 — End-to-end lifecycle assurance and evidence records

- **Ownership label:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`
- **Mechanism:** `DETERMINISTIC`
- **Dependencies:** S9-W2 and S9-W4 integrated; all assigned tests and deterministic repairs complete.
- **Files/areas:** focused/system tests; `docs/CORE_ARCHITECTURE_V2_STATUS.md`, `docs/CORE_ARCHITECTURE_V2_CONFORMANCE.md`, and `docs/ENGINEERING_LEDGER.md` as applicable. `docs/CORE_ARCHITECTURE_V2.md` is excluded.
- **Invariants:** do not weaken tests; preserve S3/S5 accepted semantics and S8 effect boundary; report source/direct tests separately from packed journeys and fixtures separately from REAL_PROVIDER evidence; no S10+ work.
- **Acceptance criteria:** focused deterministic gates pass; system cancellation/takeover evidence is reported separately; browser or packed/real-provider evidence is claimed only when actually run against the required lane; affected status/conformance/ledger entries describe current state, gaps, next gate, exact evidence, lane, and verification date.
- **Tests:** all focused commands named above, relevant `tests/system/aehConcurrencyCampaign.test.ts`, typecheck/build/diff checks, and available browser/packed/provider lanes. An unavailable required lane is recorded with its exact dependency and is not reported as passed.

## Delegation assessment

One bounded deterministic read-model unit (S9-W3) can be isolated after the lead freezes the projection boundary. It is pure, consumes an existing durable record, and writes only a new module plus its focused tests. Runtime ownership, lease authority, operation control semantics, contract changes, integration, and final review remain Luna-owned because they cross S3/S5 identity, lifecycle, and UI boundaries.

The configured `DeepSeek V4.1 Flash Implementer` profile was freshly read before delegation. Required launch values are copied exactly from that profile: provider `opencode`, model `opencode-go/deepseek-v4.1-flash`, mode `build`, thinking option `max`, features `{ "auto_accept": true }`. The worker must use a separate Paseo worktree and must not create agents or delegate further.

## Lead-owned integration delta

After the isolated W3 result was reviewed, W4 added required typed fields to the current internal Control Center projection for blocked stage counts, stage detail, participant errors, and blocked participant counts. The durable operation record remains the only source; absent fields remain absent. W4 also wired runtime service/provider lease rows into the Control Center, added the paired cancellation button against the existing server route, added Control Center service heartbeat and drain/release on shutdown, and made runtime snapshot arbitration/validation use the root-scoped lock. These contract and lifecycle changes remained Luna-owned; the Flash worktree boundary was not widened.

W5 evidence distinguishes the focused source tests and fixture-backed BROWSER journey from packed cancellation/takeover/provider-fault certification and REAL_PROVIDER lifecycle evidence, which remain open.

## R11 WorkUnit freeze — current managed Lead binding (2026-09-25)

**Finding:** On the successful packed public start path, the actual paired Control Center Lead Conversation returned `Paseo lead conversation is not configured.` The Director traced the production path: `runStart()` receives `result.agentId`, but `launchDetachedControlCenter(root, entry, noOpen)` does not forward it; child `runControlCenter()` sets `PaseoGatewayV1`'s `leadId` only from `initialPortfolio?.leadAgentId`, which is absent before the first operation. The same-root `.harness/paseo/lead-session.json` contains the current managed lead. This is a confirmed same-slice S9 product defect, not an infrastructure blocker. No R11 source or test edits have been made before this freeze.

### S9-R11 — Bind Control Center to the current managed lead

- **Classification:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE` (Luna-owned; no nested delegation).
- **Mechanism:** `DETERMINISTIC` for managed-session identity resolution and equality checks. Product acceptance is `HYBRID`: deterministic identity binding plus the actual paired UI/Paseo route and browser observation.
- **Dependencies:** accepted S5 durable managed-session identity; fixed R9 public packed start path; the Director's actual paired-browser failure receipt; no S10 dependency.
- **Frozen contract:**
  1. Normal public `aeh start <root>` must bind its Control Center `PaseoGatewayV1` to the exact `result.agentId` returned by that same `startPaseoHarness` invocation. `launchDetachedControlCenter` must carry this expected identity to its child.
  2. Before configuring the gateway, the Control Center child must resolve the authoritative current managed lead from the durable `lead-session.json` under the configured interactive state directory (default `.harness/paseo/lead-session.json`) using the existing S5 validation rules: state version 2, current bootstrap version, current AEH version, exact resolved project root, matching project name, and a nonempty `agentId`. When launched by `aeh start`, the persisted current `agentId` must equal the start result passed by the parent; missing, invalid, or mismatched state fails closed and must not produce a usable Lead Conversation binding.
  3. Direct `aeh control-center <root>` resolves the lead from that same validated durable current-session record. It ignores `initialPortfolio.leadAgentId`, operation history, and ambient `PASEO_AGENT_ID` as identity sources. A missing or incompatible current-session record leaves the Control Center available with its Lead Conversation unconfigured/degraded; it must not select a historical operation lead.
  4. Binding resolution is mechanical. It does not create an operation, grant authority, change S3 actor checks, alter S5 session identity, rebind operation state, or expose a pairing/auth token or nonce in durable evidence. The browser continues to submit to the existing authenticated Paseo Lead route.
- **Owned production files:** `src/entry.ts` and new `src/control-center/leadBinding.ts`. The latter reuses `resolveContextAgentIdentity(root, undefined, {})` from `src/operations/mcp.ts` so resolution uses the existing durable S5 validation without allowing ambient process identity to override it. `docs/CORE_ARCHITECTURE_V2.md` is excluded.
- **Owned test file:** new `tests/controlCenterLeadBinding.test.ts` only. No worker/delegation and no nested agents.
- **Regression expectations:** with no operations/portfolio lead, a valid current durable lead plus the matching `aeh start` expected ID resolves exactly that lead; the supported paired `/api/v1/paseo/lead/messages` boundary dispatches to that resolved ID. A mismatched start ID fails closed. Direct Control Center binds a valid current session, ignores portfolio and ambient-environment alternatives, and remains unconfigured/degraded when current durable identity is missing or incompatible. Invalid project/version/bootstrap bindings cannot be used. Tests must not create a test-only route or write JSON operation state directly.
- **Acceptance criteria:** focused regression passes; affected Control Center/Paseo identity tests, typecheck, and build pass; a fresh packed public `aeh start` on `/tmp/aeh-s9-browser-live.2m8tga` emits the actual pairing URL and its Lead Conversation reaches the current managed lead through the real paired route; the full mandatory browser journey continues on that product URL. Durable browser receipts remain free of pairing/auth tokens and nonce. R11 alone does not establish S9 acceptance; the choice/consume/resume/replay/cancel/refreshed-projection browser chain remains required.
- **Explicit exclusions:** no historical/stale operation lead fallback; no alternate test-only route; no direct JSON writes or synthetic accepted decisions; no edit to normative target; no S1-S8 changes, S10, commits, pushes, or delegation.

### R11 browser receipt and current disposition

The Director's actual paired browser run in the fresh-start root had no operation and no pending decision. Sending a normal Lead Conversation message returned exactly `Paseo lead conversation is not configured.`; no operation file or HumanDecision ledger entry was created. This is an actual product-path failure, not a successful operation/decision journey. Sanitized failure evidence is persisted at `docs/evidence/s9/lead-gateway-failure.json` and `.png`. The separate `lead-gateway-passing-journey.json` records paired startup/home and a later Lead-message timeout; it is not evidence of an operation or decision journey. A safe key/string scan of the S9 JSON artifacts found no credential-like strings. The raw pairing URL remains private and is not part of this WorkGraph. The real browser gate remains pending after the R11 repair; S9 is not accepted and S10 remains locked.

## R12 WorkUnit freeze — detached controller bootstrap failure finalization (2026-09-25)

**Finding:** The paired, root-scoped Control Center projects the actual durable operation, so project registration is not required for this journey. Operation `CHANGE-20260925T171424Z-648c3147` remained `RUNNING/preparing`, revision 6, with only the `queued` stage `RUNNING`, no participants, no DecisionRequest, and zero provider leases. Its recorded execute PID was absent. The project root is not a Git repository. The durable Lead identity's `aehCommand` selects `/tmp/aeh-s9-r11-pack/package/dist/main.js`; package version is `0.8.4`, and `dist/current` contains `release-1790355907478-3853360-f5e934b6`. The selected immutable controller file is `/tmp/aeh-s9-r11-pack/package/dist/releases/release-1790355907478-3853360-f5e934b6/operations/controller.js`, SHA-256 `2291c8345296f7697b205ec1eba32870f9e7b8e3423a50044d994439048cc23d`. The package entry reads that release marker and imports that release's `main.js`. This exact selected release was invoked once for the same operation after confirming no execute process was active. It safely claimed controller epoch 2 because the prior PID was absent, then exited 1 with `Error: No resolvable Git base ref found; configured baseRef=main.` at `core/git.js:23`, called from `operations/controller.js:199`.

**Baseline/repair comparison:** `git show HEAD:src/operations/controller.ts` confirms that at HEAD the operation is patched to `RUNNING`, then project config is loaded, base ref is resolved, and portfolio is synchronized before the catch begins (HEAD lines 270–292). The exact selected packed release matches this ordering: `operations/controller.js` lines 188–209, with `resolveBaseRef` at line 199 and the catch boundary starting at line 209. The current uncommitted worktree change in `src/operations/controller.ts` moves the `try` to begin before the RUNNING patch and these bootstrap steps (worktree lines 277–296), so those exceptions reach the existing fenced `FAILED` terminalization path. The detached worker from the old packed release exited before that catch and left the operation nonterminal; after the authorized takeover it advanced only to revision 8, still nonterminal with the new execute PID absent. The later `operation.lead.acknowledged` liveness event did not advance operation revision/status/phase. This is a same-slice S9 controller lifecycle defect, not a Lead composition wait or browser infrastructure failure.

**Fresh R12 package identity:** the Campaign Director supplied and independently inspected `/tmp/aeh-s9-r12-pack/agentic-engineering-harness-0.8.4.tgz`, SHA-256 `77a0c39f580053b67abe2ee444e6b4c2995ecdc417a66613eb56d5dc20a1782d`, extracted at `/tmp/aeh-s9-r12-pack/package/package`. Its `dist/current` selects `release-1790359422074-34-41c17389`; selected controller SHA-256 is `4dc6bbaf16cade14e01472fd43b4a093712b4684b98d8df6484f92508450b1ef`. Independent read-only inspection confirms the catch begins at line 192 and encloses the RUNNING transition (193–199), config load (201), base-ref resolution (204), and portfolio sync (210). The user/Director owns the same-operation runtime recovery; Luna will not launch a competing execution or mutate that project root.

### S9-R12-A — Finalize detached controller bootstrap failures

- **Classification:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE` (`LUNA_OWNED`; no delegation or nested agents).
- **Mechanism:** `DETERMINISTIC` for controller ownership, bootstrap failure, terminal state, and projection; the browser remains the independent product acceptance boundary.
- **Dependencies:** accepted S3 current-epoch fencing and S5 session/context identity; R11 current managed Lead binding; current S9 provider-lease lifecycle; unchanged normative target.
- **Frozen contract:**
  1. Once a detached operation has been claimed and marked `RUNNING`, every subsequent bootstrap step through the first completed/blocked work stage must be covered by one fenced failure-finalization boundary. An exception in config loading, base-ref resolution, portfolio synchronization, or pre-route semantic preparation must not exit with a nonterminal operation and dead controller PID.
  2. A missing/unresolvable Git base ref remains an explicit failure; the controller does not synthesize a branch/base or silently bypass workspace provenance. It terminalizes the operation as `FAILED` with a durable diagnostic, then best-effort refreshes the Control Center projection when project config is available.
  3. Recovery/takeover of a nonterminal operation is permitted only through the production controller/state lifecycle APIs after the prior controller PID is proven absent. Takeover increments the controller epoch and rotates its token. Any provider lease or external session with uncertain quiescence remains fenced and reconcilable; no live owner or uncertain session is stolen. A failure before provider/session acquisition leaves no provider lease.
  4. The root-scoped Control Center refreshes from the same durable operation record and exposes the resulting failure or recovered `HUMAN_REQUIRED` state. No direct HTTP, JSON state writes, test-only route, synthetic decision, or project registration is part of this root-scoped journey.
- **Owned production file:** `src/operations/controller.ts` only. Luna owns implementation and review.
- **Operational recovery acceptance:** after ordinary Git initialization of the disposable project, prove the old recorded execute PID is absent and provider/session state is quiescent, then recover this same operation with the supported production controller takeover path. It must advance to a durable scoped `HUMAN_REQUIRED` request and be visible in the already paired root-scoped Control Center. Stop before choice submission or cancellation for independent Director control.
- **Validation:** focused startup/lifecycle tests, affected S9 tests, typecheck, fresh build/package, and `git diff --check`. The independent actual-URL Playwright choice/consume/resume/replay/cancel/refreshed-projection journey remains mandatory and is not replaced by this regression.
- **Explicit exclusions:** no normative-target edit, no weakening of fencing, no automatic Git creation by the controller, no direct operation/ledger JSON mutation, no source edit to S1-S8 behavior, no S10, commit, push, or nested delegation.

### S9-R12-T — Non-Git startup failure regression

- **Classification:** `FLASH_DELEGATABLE`, strictly after the frozen R12 contract; bounded tests-only unit in a separate Paseo worktree. No nested agents.
- **Mechanism:** `DETERMINISTIC`.
- **Dependencies:** frozen S9-R12-A contract above; current controller/state contracts; no changes to the production controller source.
- **Owned file:** new `tests/operationStartupFailure.test.ts` only.
- **Regression expectations:** exercise `executeOperation` through production state/controller APIs with an initialized non-Git project and current controller owner. Assert an unresolvable configured base ref becomes durable terminal `FAILED` with the exact diagnostic, a terminal event and matching operation portfolio projection, with no participant/provider lease. The test must demonstrate RED against the frozen pre-fix source and return its exact command/result. It may not edit production source, other tests, docs, UI, fixtures outside its temporary root, or package files.
- **Acceptance criteria:** met. The worker returned one isolated worktree diff containing only this test file; Luna reviewed and selectively integrated it. Against baseline commit `c036471`, `npx vitest run tests/operationStartupFailure.test.ts` exited 1 with 1 test failed at `resolveBaseRef` (`src/operations/controller.ts:282`) before the try at line 292; the unterminalized operation had no terminal event or portfolio entry. The exact diagnostic was `No resolvable Git base ref found; configured baseRef=refs/heads/aeh-startup-failure-missing.` Against the repaired current source, `./node_modules/.bin/vitest run tests/operationStartupFailure.test.ts --reporter=dot` passed 1 file / 1 test; `npm run typecheck` exited 0.
- **Worker limitations:** the deterministic case fails at base-ref resolution, the earliest old pre-try bootstrap point, so portfolio-sync and pre-route exceptions are not separately tested. The no-config branch cannot assert a portfolio row. A real `git` binary is required for the expected diagnostic, and `GIT_CEILING_DIRECTORIES` prevents discovery of an ancestor repository.
- **Independent current-fix evidence:** the Campaign Director independently ran the earlier local draft of `tests/operationStartupFailure.test.ts` — 1 file / 1 test passed; `npm run typecheck` — exit 0; and `npm run build` — exit 0, producing `release-1790359341925-17-d65e1b0f`. The integrated worker version was then rerun by Luna as recorded above. The fresh package identity and packed catch-boundary inspection are recorded in R12-A.
- **Agent settings:** fresh `list_profiles` result selected `DeepSeek V4.1 Flash Implementer`: `provider=opencode`, `model=opencode-go/deepseek-v4.1-flash`, `modeId=build`, `thinkingOptionId=max`, `featureValues={"auto_accept":true}`. Materialize as `create_agent.provider="opencode/opencode-go/deepseek-v4.1-flash"` and `settings={"modeId":"build","thinkingOptionId":"max","features":{"auto_accept":true}}`. No `profile` shorthand and no nested agents.
- **Delegation record:** profile listing was freshly queried on 2026-09-25. Agent `0034e4bc-7c62-482e-864a-0c294d525dfd` was created in isolated worktree `/home/james/.paseo/worktrees/0jx5pvzi/s9-r12-startup-failure-regression` (`workspaceId=wks_e75cbff45b32c5f3`, branch `s9-r12-startup-failure-regression`) from `core-architecture-v2` HEAD. Assignment is limited to this test path; no nested agents.
- **Explicit exclusions:** no operation execution against the disposable browser root; no direct operation/ledger JSON writes; no controller/source edits; no commits/pushes; no S10.

## R13 WorkUnit freeze — public start must not mutate active operation Lead bindings (2026-09-25)

**Finding:** The fresh packed public `aeh start --resume` reached `rebindActiveOperationsToLead()` from `src/paseo/start.ts`. That helper calls `bindOperationLead()`, whose `operation.lead.bound` mutation requires the current controller epoch and token. The public CLI is not the operation controller, so the real path fails closed with `V2_CONTROLLER_FENCED` before the Control Center URL is emitted. This also contradicts the frozen R11 binding boundary, which states that current Control Center Lead identity resolution does not rebind operation state. `src/operations/mcp.ts` has two additional non-controller callers of the same helper; one suppresses the fencing error and the other can block a new operation.

### S9-R13-A — remove non-controller active-operation rebinding

- **Classification:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE` (`LUNA_OWNED`).
- **Mechanism:** `DETERMINISTIC` for caller identity, current controller epoch/token, and operation record invariance.
- **Dependencies:** accepted S3 owner fencing; R11 current managed Lead binding contract; R12 fixed packed startup; unchanged normative target.
- **Frozen contract:**
  1. Public `aeh start` may create/reuse the managed Lead and launch the paired Control Center, but it does not mutate any existing operation record, Lead binding, completion target, controller epoch, or portfolio as a side effect of Lead startup.
  2. `operation.lead.bound` remains controller-owned and requires the current durable controller epoch and token. Startup and ordinary Lead MCP calls may not bypass or impersonate that owner.
  3. Remove the non-controller active-operation rebinding path and its superseded helper/test. Newly created operations continue to bind their Lead from the current controller-owned `startDetachedOperation` path. Existing active operations keep their durable binding until an authorized controller lifecycle transition changes it.
  4. The fix does not weaken fencing, synthesize controller identity, change S3 authority, alter R11's paired identity resolution, add a special browser route, or change the normative target.
- **Owned production files:** `src/paseo/start.ts`, `src/operations/mcp.ts`, `src/operations/leadBinding.ts`, `src/operations/controller.ts` only if required by review. `src/operations/state.ts` owner checks are explicitly not to be weakened.
- **Test ownership:** one isolated Flash regression is limited to `tests/paseoStart.test.ts`; no worker production edits, other tests, docs, fixtures outside its temp root, package changes, or nested delegation.
- **Acceptance criteria:** the regression fails against the frozen source because public start attempts an unfenced `operation.lead.bound`; after removal, the same public resume path returns normally and the durable active operation, its Lead binding, and completion target remain byte-for-byte/semantically unchanged. A fresh packed candidate must emit the actual product pairing URL on `/tmp/aeh-s9-browser-live.2m8tga`; the actual Playwright journey then exercises the existing paired Control Center UI and full durable decision/resume/replay/cancel/refreshed-projection chain. Run affected tests, typecheck, UI build, package build, and `git diff --check`. This remediation does not establish S9 acceptance without the browser gate.
- **Explicit exclusions:** no direct durable operation JSON writes; no current-owner bypass or token/epoch changes; no production testing route; no edits to `docs/CORE_ARCHITECTURE_V2.md`; no S1–S8 changes; no commits, pushes, or S10.

### S9-R13-D — frozen delegation assessment

The public-start defect has a deterministic test-only seam in `tests/paseoStart.test.ts`; a meaningful Flash-delegatable WorkUnit is therefore available. After the contract freeze, delegate only that regression to a freshly selected DeepSeek V4.1 Flash Implementer in a separate Paseo worktree, with no nested delegation. Luna retains the architecture boundary, all production edits, integration, review, validation, and final slice acceptance. If current profiles cannot provide that worker, record the exact provider limitation and obtain an approved bounded alternative before source modification.

## R14 WorkUnit freeze — display validated current decision scope (2026-09-25)

**Finding:** The mandatory user-facing decision journey requires users to see the current operation/candidate/policy/execution-revision/controller-epoch scope before choosing. The validated `DecisionRequest` projection already carries these exact identity fields, but `DecisionRequestCard` currently renders only a shortened operation ID and phase. This is a UI disclosure gap; no server or authority contract expansion is required.

### S9-R14-A — render the exact current decision binding

- **Classification:** `LUNA_OWNED` for the product-facing labels, accessibility, and UI implementation; `DETERMINISTIC` for which values are rendered.
- **Mechanism:** `DETERMINISTIC`; render only the already validated identity fields supplied by the active `DecisionRequest`.
- **Dependencies:** accepted S3 decision binding and replay checks; S9 current `DecisionRequest` projection; R11 actual paired Control Center path; unchanged normative target.
- **Frozen contract:**
  1. When a current pending `DecisionRequest` is shown, the actual UI must visibly expose the full operation ID, candidate identity/digest, policy digest, `operationExecutionRevision`, and current `controllerEpoch` before decision submission.
  2. Render the binding from the projected `DecisionRequest` itself, which the server already emits only after matching request, continuation, candidate, frozen policy, execution revision, and epoch. Do not reconstruct identity from user text, URL, ambient state, or stale operation history.
  3. Preserve the existing paired UI submit path and server current-binding validation; do not add an alternate API, token/nonce display, or authority field.
  4. Screenshots and durable browser evidence must show the current scope without storing pairing fragments, auth material, cookies, CSRF values, headers, or nonces.
- **Owned production scope:** `ui/control-center/src/App.tsx` and its existing stylesheet only if needed for readable responsive presentation. No projection/server contract change is expected.
- **Existing regression evidence:** `tests/controlCenterOperationProjection.test.ts` already asserts the exact current `DecisionRequest` contains operation ID, candidate digest, policy digest, operation execution revision, and controller epoch; reuse that deterministic contract evidence. The missing property is actual UI rendering, whose mandatory gate is the real Playwright journey.
- **Acceptance criteria:** existing projection regression passes; UI typecheck/build pass; the actual Playwright browser at the product URL visibly asserts all five binding fields on the pending decision, submits through the existing UI, and persists sanitized screenshot/assertion/network evidence. No S9 acceptance without the full S9 journey including consumption, revalidation, replay rejection, scoped cancellation/fencing, and refreshed authoritative state.
- **Explicit exclusions:** no change to `docs/CORE_ARCHITECTURE_V2.md`, server authority/identity semantics, API endpoints, decision contract, external-effect boundary, or prior accepted S1–S8 work; no commits, pushes, or S10.

## R15 WorkUnit freeze — reuse the current Control Center service on public start (2026-09-25)

**Finding:** A second packed public `aeh start --resume` on the authorized disposable project root returned a new Lead but no Control Center URL. Its detached child failed because the shared runtime snapshot already had a `READY` Control Center owned by a live PID; `launchDetachedControlCenter()` waited 15 seconds and silently returned `undefined`. The existing server was reachable on loopback, but its old process had a startup-fixed Lead binding, so reusing only its URL would risk sending user actions to a stale Lead. The required user entry path must reuse a compatible current service and must fail explicitly when it cannot safely do so.

### S9-R15-A — current-session service reuse and explicit launch outcome

- **Classification:** `LUNA_OWNED` for process/service lifecycle and current Lead binding semantics; `DETERMINISTIC` for service identity and health checks. UI product acceptance remains `HYBRID` through the actual browser journey.
- **Mechanism:** `DETERMINISTIC` for project root, service ID/status, binding-mode marker, loopback URL validation, health response and current durable Lead resolution.
- **Dependencies:** accepted S3 current identity and fencing; S9 R11/R13 public startup binding and non-rebind semantics; S9 R14 current decision projection; no S10 dependency.
- **Frozen contract:**
  1. `aeh start` must return or print the actual project Control Center URL. When a compatible Control Center for the same canonical project root already serves loopback, reuse its URL instead of launching a conflicting duplicate. Confirm it with the durable runtime service record and its `/health` response; reject mismatched root, service identity, unsupported status, untrusted/non-loopback URL, and unresponsive listeners.
  2. A reused service is compatible only when its runtime record declares validated-current-session Lead routing. On startup, a newly launched child still verifies its durable current managed Lead matches the exact `agentId` returned by that `aeh start` invocation. For later browser actions and Lead projections, resolve the validated current durable Lead identity at request time so a subsequent supported start/restart cannot route through a stale in-memory Lead binding.
  3. Pairing material remains ephemeral: emit `controlCenterPairing` only for the process that minted that one-time pairing URL. Never persist, recover, log, or synthesize a prior pairing nonce/token. Reuse may print the verified base URL and identify the session as reused; it does not claim to have minted a new pairing link.
  4. If no compatible server is reusable, start the supported detached child and consume its actual ready file. If no valid ready record or reusable server appears, fail the `aeh start` invocation with an actionable error; do not report a successful URL-less Control Center startup.
  5. No API-only/browser shortcut or test-only URL is added. The real Playwright journey continues to use the URL the public packed `aeh start` produced.
- **Owned source scope:** `src/entry.ts`, `src/control-center/server.ts`, and a small `src/control-center/reuse.ts` pure service-record selector. Runtime service arbitration and S3 checks remain unchanged.
- **Flash-delegatable unit:** a tests-only `tests/controlCenterReuse.test.ts` matrix for exact service ID/root/status/binding-mode and loopback URL selection, isolated in a Paseo worktree. The test contract is frozen below; no production edits are delegated.
- **Luna-owned integration regression:** extend the existing `tests/controlCenterLeadBinding.test.ts` only to prove an already running Control Center resolves and dispatches to the currently validated Lead after a supported durable Lead identity changes; the start-time expected-identity check remains mandatory.
- **Test contract:** export `reusableControlCenterFromSnapshot(root, snapshot)` from `src/control-center/reuse.ts`; it returns `{ url }` only for the exact root-derived `control-center:${runtimeProjectId(root)}` record, kind `control-center`, status `READY`, matching canonical root, metadata `leadBindingMode: "validated-current-session-v1"`, and a root loopback HTTP URL. Return `undefined` for every missing, duplicate, mismatched, stale, non-ready, or unsafe record. Probe listener health in the lead-owned launcher, not this pure selector.
- **Acceptance criteria:** worker tests are red against the baseline contract and pass after integration; focused Control Center/Paseo tests, typecheck and builds pass; same-root `aeh start --resume` reuses only the compatible healthy server and prints the actual base URL; a genuine packed startup produces the real pairing URL; Playwright opens the actual product-produced URL and completes the full mandatory S9 choice/consume/replay/revalidate/continue/cancel/fence/refresh journey. Browser receipts never store the pairing fragment or auth material. S9 remains open until deterministic and real browser gates independently pass.
- **Explicit exclusions:** do not weaken service/process/operation ownership; do not expose or persist pairing/auth secrets; do not create an alternate test route; do not mutate durable operation identity from `aeh start`; do not change `docs/CORE_ARCHITECTURE_V2.md`; no S1–S8 reclassification, S10, checkpoint commit, or push.

## S9-R16 WorkUnit freeze — truthful Paseo daemon ownership on repeated public start (2026-09-25)

**Finding:** The packed public entry path was run twice against the same approved disposable root, `/tmp/aeh-s9-browser-live.2m8tga`, with the current R15 package and an isolated temporary Paseo home. Both invocations exited before Lead creation or browser navigation with `RuntimeOwnershipError: service paseo:project:48e85ff23ab8a7f6ec84d694 is owned by paseo-start:18:project:48e85ff23ab8a7f6ec84d694.` The durable runtime record is `READY` for that exact project root, but its PID/owner describe the short-lived `aeh start` caller, not the Paseo daemon. `src/paseo/start.ts` registers `pid: process.pid` and the `paseo-start:<pid>` owner before querying the daemon. The supported Paseo status path with `PASEO_DAEMON_URL=ws://127.0.0.1:6770/ws` reports the temporary daemon reachable with a current server ID; the public start still fails before it observes that status. This is a product lifecycle defect, not evidence that the browser gate is optional or that service ownership may be weakened.

**Frozen contract:**

1. The `paseo:${projectId}` runtime service represents the observed Paseo daemon for the exact canonical project root. A short-lived `aeh start` process PID must not be persisted as the daemon PID or treated as the long-lived daemon owner.
2. Public start must obtain current Paseo daemon status before it claims, replaces, or marks the persistent Paseo service `READY`. A current matching healthy daemon may be reused only after supported status observation. A confirmed stopped daemon may be started and then recorded from the resulting daemon identity. An unknown, timed-out, mismatched-root, or otherwise ambiguous service observation fails closed with an actionable error and preserves the prior runtime record.
3. Any replacement of an existing service record must be scoped to the exact Paseo service ID/project/root and justified by current Paseo lifecycle evidence. Generic runtime service arbitration remains fail-closed for other service kinds; process PID alone is not evidence that a different daemon instance owns this Paseo service.
4. Preserve controller/S3 authority, provider leases, Lead identity, Control Center current-session routing, and the S8 external-effect boundary. Paseo execution infrastructure remains internal runtime setup. Do not mutate an OperationRecord as a side effect of starting/reusing the Lead.
5. Continue the mandatory real Playwright journey only from the product URL and one-time pairing material returned by the supported packed `aeh start`; keep all pairing/auth/CSRF material in memory and persist only sanitized evidence.

### S9-R16-A — service identity and status contract

- **Classification:** `LUNA_OWNED`; **mechanism:** `HYBRID` (authoritative supported Paseo lifecycle status plus deterministic runtime-record identity checks).
- **Scope:** inspect daemon status shape, current runtime service registration/replacement APIs, and the R15 public start contract; preserve the exact root, service ID, owner, and status invariants above.
- **Acceptance:** explicit typed handling for healthy, stopped, and unresolved daemon state; no bare caller PID is represented as persistent Paseo daemon identity; no unrelated or ambiguous service record can be taken over.

### S9-R16-T — repeated-start lifecycle regression

- **Classification:** `FLASH_DELEGATABLE`; **mechanism:** `DETERMINISTIC`.
- **Scope:** one tests-only addition to `tests/paseoStart.test.ts` in an isolated Paseo workspace seeded from the current S9 candidate. The regression seeds an exact-root `READY` Paseo runtime record owned by a prior `paseo-start` invocation, supplies current supported daemon-status evidence, and exercises the existing public `startPaseoHarness` seam. It must fail against the frozen current source at service registration and pass only when current daemon identity/status, not the transient CLI PID, governs reuse. Also assert that an unresolved/mismatched observation cannot rewrite the prior service record.
- **Exclusions:** no production edits, no changes to other tests/docs/UI, no direct state-file mutation in product behavior, no browser or provider claims, no commits/pushes, and no nested delegation.

### S9-R16-I — same-slice implementation and integration

- **Classification:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`; **mechanism:** `HYBRID`.
- **Dependencies:** R16-A freeze and R16-T reviewed red result.
- **Scope:** Luna integrates the tests-only regression, audits the existing Paseo status parser and runtime service callers, and changes only the source needed to make repeated supported start accurately observe/reuse/reconcile the Paseo daemon. Keep generic ownership arbitration unchanged unless the frozen status-evidence contract requires a narrowly scoped Paseo-specific reconciliation method.
- **Acceptance:** no transient caller PID is left as `READY` Paseo daemon identity; the same-root packed `aeh start --resume` succeeds with the reachable daemon and returns its actual product URL; stopped/ambiguous cases fail closed or restart only through supported Paseo status/start behavior; no Lead or operation is created before those checks succeed.

### S9-R16-V — packed entry path and browser continuation

- **Classification:** `LUNA_OWNED`; **mechanism:** `HYBRID`.
- **Dependencies:** R16-I and current R15/R14 UI and decision contracts.
- **Scope:** rebuild/repack the same candidate after the source change, use the approved root and temporary Paseo home, and capture the URL from actual public `aeh start` output in memory. Open that exact URL in installed Playwright Chromium. Continue the unchanged S9 browser gate: current visible operation/candidate/policy/execution-revision/controller-epoch scope; paired UI submission; durable one-time decision consumption; replay rejection; correct continuation and current identity revalidation; refreshed authoritative projection; scoped cancellation; stale-control rejection; writer/process drain; final projection agreement.
- **Evidence:** sanitized screenshots, assertion/observed-state summary, and method/path/status network log; no pairing fragments, auth material, cookies, CSRF values, headers, tokens, or nonces.

### S9-R16-E — affected deterministic validation and documentation

- **Classification:** `LUNA_OWNED`; **mechanism:** `DETERMINISTIC`.
- **Dependencies:** R16-I and R16-V results.
- **Scope:** rerun affected Paseo/runtime/Control Center tests, typecheck, UI/build as affected, and `git diff --check`; update STATUS/CONFORMANCE/LEDGER with actual results only. Preserve earlier S9 evidence and invalidate only package/build identities made stale by this source change.
- **Gate:** R16 closes only when its affected deterministic checks and the complete mandatory real browser journey both pass. S9 remains open; no S10, commit, or push is authorized by this WorkUnit freeze.

### R16 Delegation Assessment

- **Fresh profile discovery:** `mcp__paseo__list_profiles` returned both configured profiles and their notes immediately before assignment. Selected **DeepSeek V4.1 Flash Implementer**: `opencode/opencode-go/deepseek-v4.1-flash`, `modeId=build`, `thinkingOptionId=max`, `features={"auto_accept":true}`.
- **Delegated boundary:** R16-T is a meaningful tests-only unit behind the frozen public-start seam. Luna retains service lifecycle contract interpretation, source changes, authority, integration, and final review.
- **Isolation:** create a separate local Paseo workspace under `/tmp` from a copy of the current S9 candidate; do not give the worker the campaign checkout. Only `tests/paseoStart.test.ts` may change. No nested delegation, commits, or pushes.
- **State at freeze:** assignment not yet launched; no R16 source or test edits have been made in the campaign checkout. The two failed packed start attempts are pre-fix evidence only and are not browser evidence.

## S9-R17 WorkUnit freeze — semantic preflight before operation-bound provider leases (2026-09-25)

**Finding:** the real paired Control Center path reached the packed S9 candidate and produced a durable operation failure before any DecisionRequest. The packed trace identifies `PASEO_PROVIDER_LEASE_CONTEXT_MISMATCH` from `SemanticAssessmentServiceV1.assess`. Source order confirms the cause is broader than missing labels: `executeOperationWithEnvironment` calls `prepareChangeOperation` after setting the current operation context, but before binding the frozen ResolvedOperationPolicy and initial workspace CandidateRevision. The Paseo provider lease requires a current participant or bound Lead generation and also requires the current candidate, execution revision, policy, token, and epoch. Adding only Lead labels would therefore advance the failure to `PASEO_PROVIDER_LEASE_IDENTITY_INCOMPLETE`; it would not satisfy the frozen lease contract.

**Frozen lifecycle interpretation:** for a new CHANGE, semantic route/assurance assessment is pre-operation request resolution, before the durable managed operation and its operation-bound provider lease begin. The start boundary must obtain the typed, validated triage result with an unscoped repository binding, then persist its route, assurance, and bounded route evidence into the new durable operation before dispatch. The detached controller verifies repository/request identity and recomputes triage from the canonical persisted SemanticAssessment cache; a missing/stale cache fails closed rather than relaunching an unleased provider call under the operation. It then deterministically validates the result before compiling ResolvedOperationPolicy. The Semantic Assessor remains a read-only capability, never a WorkGraph Participant or authority. Once an operation exists, all subsequent operation-bound Paseo sessions continue to require the full current lease identity. This follows the target ordering of route/assurance resolution before ResolvedOperationPolicy and does not amend `docs/CORE_ARCHITECTURE_V2.md`.

### S9-R17-A — Freeze preflight and persistence boundary

- **Classification:** `LUNA_OWNED`; **mechanism:** `DETERMINISTIC` for identity, typed-result validation, durable persistence, and route constraints; semantic route/assurance remains `HYBRID`.
- **Dependencies:** accepted S3 authority and S5 execution identity; frozen S9-R2 provider lease contract; R16 public start lifecycle.
- **Invariants:** do not weaken `runWithOperationProviderLease`; do not synthesize participant/Lead ownership or candidate/policy identity; no operation record is created until preflight succeeds; the stored result is typed and evidence-bound; no free-form model output is authority; no normative-target edit.

### S9-R17-T — Pre-operation semantic triage regression

- **Classification:** `FLASH_DELEGATABLE`; **mechanism:** `DETERMINISTIC`.
- **Scope:** one new test file only, isolated from the campaign checkout. Prove the public CHANGE start path resolves triage before durable operation creation, persists route/assurance/evidence for the detached controller, and does not label the preflight assessor with an `aeh.operation` lease identity. Also prove preflight failure creates no durable operation.
- **Exclusions:** no source, contract, documentation, UI, or other test changes; no operation against the development checkout; no direct durable-state mutation; no network/public effects; no nested delegation, commit, or push.

### S9-R17-I — Integrate preflight and consume frozen triage

- **Classification:** `SEQUENTIAL_AFTER_CONTRACT_FREEZE`; **mechanism:** `HYBRID`.
- **Dependencies:** R17-A and reviewed R17-T red result.
- **Scope:** move new CHANGE route/assurance triage to the supported start boundary before operation creation; persist the typed bounded result in the durable intent; make controller execution validate and consume that saved result rather than launching an operation-bound pre-policy assessment. Keep the rest of the operation-bound semantic service available for later candidate/policy-bound work.
- **Acceptance:** the normal packed start path no longer fails with provider lease context/identity errors; stale or malformed preflight data fails closed; provider leases remain mandatory and unchanged for all later operation-bound Paseo work.

### S9-R17-V — Actual-URL Playwright continuation

- **Classification:** `LUNA_OWNED`; **mechanism:** `HYBRID`.
- **Dependencies:** R17-I and current R16 service/URL handling.
- **Scope:** rebuild and repack the same candidate, restart/reuse Paseo through supported `aeh start`, and use only the product-emitted URL in real Playwright Chromium. Continue the existing full S9 journey through the paired UI/server/controller path: visible current decision scope, durable one-time choice consumption, replay/stale rejection, continuation identity revalidation and resume, refreshed authoritative projection, scoped cancellation, stale-control rejection, and writer/process drain.
- **Evidence:** sanitized screenshots/assertion/state/network summaries; no pairing fragment, auth material, cookies, CSRF, tokens, or nonces.

### S9-R17-E — Affected verification and evidence reconciliation

- **Classification:** `LUNA_OWNED`; **mechanism:** `DETERMINISTIC`.
- **Dependencies:** R17-I and R17-V.
- **Scope:** run the new and affected semantic/operation/controller tests, typecheck/build/package gates made stale by source changes, and diff checks; update Status, Conformance, Ledger, and this WorkGraph with exact evidence. `docs/CORE_ARCHITECTURE_V2.md` remains excluded.
- **Gate:** S9 remains blocked/open unless all deterministic requirements and the real user-facing browser journey pass. No S10, commit, or push before independent Campaign Director acceptance.

### R17 Delegation Assessment

- **Delegated boundary:** R17-T is a bounded tests-only regression behind the frozen preflight persistence seam. Luna retains semantic authority interpretation, source changes, integration, browser journey, and final review.
- **Isolation:** use a separate Paseo worktree based on the frozen source baseline; only the new assigned test file may change. No nested delegation, commits, or pushes.
- **State at freeze:** no R17 implementation or test edits have been made in the campaign checkout. The real-browser failure is preserved as product evidence; it is not browser-gate success.

## S9 completion remediation graph — 2026-09-26

**Disposition:** S9 implementation complete; pending independent slice review. The mandatory browser journey passed 46/46.

### R18 — PAUSE / RESUME lifecycle (frozen from target sections 1.1, 10.2, 13)

- PAUSED is a durable suspension: `OperationRecordV2.pause` (`OperationPauseRecordV1`) carries the complete current binding (operation, candidate, execution revision, policy digest, controller epoch), the saved `resumePhase`, reason, requester, drain receipt, and required revalidation set. `status` stays `RUNNING`; `phase` becomes `PAUSED`.
- Control requests are typed, scoped `HumanDecision` entries (`kind` PAUSE/RESUME, purpose `OPERATION_CONTROL` command PAUSE/RESUME) recorded by the paired Control Center server against the current binding. The controller consumes each exactly once.
- The controller applies pause only at controller-owned checkpoints after `drainOperationWriters` proves no participant is RUNNING and no provider lease is ACTIVE/UNCERTAIN. A non-quiescent drain leaves the request pending. Resume revalidates the complete binding, consumes exactly once, clears the pause, and restores `resumePhase`.
- Restart recovery rebinds a PAUSED record to the current controller identity after bootstrap policy binding, then waits for a current-scope RESUME.
- Control Center derives `controls { pause, resume, cancel }` server-side; the UI renders only legal controls and never owns lifecycle state.

### R19 — File-scripted deterministic Paseo runtime boundary

- `AEH_DETERMINISTIC_PASEO_RUNTIME=1` selects a scripted implementation of the existing `PaseoRuntimeDeps` boundary (`src/paseo/deterministicRuntime.ts`). It replaces only the external model conversation; controller state, execution bindings, provider leases, context authorization, and structured-result provenance run unchanged. Script: `.harness/fixtures/deterministic-paseo-runtime.json` with a durable per-key cursor. Missing or exhausted scripts fail closed. This is fixture evidence, never REAL_PROVIDER.

### Repairs found by the completion journey

- Supervisor provider sessions had no lease or execution-binding identity because supervisors are excluded from the participant map: extended `ProviderLeaseLifecycleIdentityV1`, `runWithOperationProviderLease`, `bindOperationParticipantExecution`, context authorization, and result provenance with a `supervisorAgentId` actor stored on `OperationAgentRecord.executionBinding`.
- `dispatchMaterializedAgentPrompt` used the provider session id as the authority participant, omitted `preparedPrompt`, and omitted actor/output labels; corrected to the materialized participant identity, the projected prompt, and complete bound labels.
- The default agent preset granted shell/network/write/delegate beyond the frozen RoleProfile ceilings for lead, explorer, librarian, planner, spec-manager, and reviewer, and referenced repository skills absent from the seed catalog; aligned to the compiled ceilings and seed.
- `suspendOperationForProductChoice` rejected a second product choice in the same Spec Manager loop; it now allows replacing a consumed (`RESUMING`) choice.
- Cancellation stopped authority participant identities and deterministic fixture sessions through the Paseo CLI; it now skips authority ids and releases deterministic provider leases without an external stop.
- The operation coordination lock self-deadlocked on nested context authorization; it is now re-entrant for the holding async context.
- `saveOperation` bound a change candidate task id of the operation id even when the payload declared an explicit task id; corrected.
- `managedLeadAcceptance` provider-label inspection was not reflected in its test mock; corrected.

### Evidence

- Focused S9 set (25 files / 221 tests) passed after repairs.
- `tests/changeControllerOwnedDecision.test.ts`: the real controller reaches HUMAN_REQUIRED, the UI-path decision is consumed exactly once, a second suspension follows, pause reaches durable PAUSED through drain, resume returns to HUMAN_REQUIRED, and cancellation terminalizes.
- Real browser journey (`npm run test:browser-e2e`): 1 Playwright test, 46/46 assertions PASS against release `release-1790386441389-339964-cb4c88d0`; sanitized evidence in `docs/evidence/s9/s9-playwright-*`.
- Full non-system Vitest: 1,107 passed / 3 failed (7 skipped); the three failures are pre-existing environment-sensitive `tests/paseoSdkResolve.test.ts` cases where the real mise store is discovered in this host, and neither the test nor `src/paseo/sdkResolve.ts` is part of the S9 diff.
- Source-importing `tests/system/aehConcurrencyCampaign.test.ts`: 1 file / 9 tests passed.
- Packed lifecycle campaign against a fresh package (`/tmp/s9-packed-final5/agentic-engineering-harness-0.8.4.tgz`, SHA-256 `77822ad649c722712b40c24d9e871068c48dcc6558bf3df17941040f0fec22f3`, release `release-1790386951268-374975-e4a08e67`): PACKED_TAKEOVER_PASS, PACKED_PROVIDER_FAULT_PASS, PACKED_RESTART_CLEANUP_PASS. Provider calls are deterministic stubs; no REAL_PROVIDER claim.
- `npm run typecheck` and `npm run build` exited 0; `git diff --check` clean; `docs/CORE_ARCHITECTURE_V2.md` unchanged.
