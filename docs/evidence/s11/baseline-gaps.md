# S11 Baseline Gap Reproduction (pre-S11)

- Repository: `agentic-engineering-harness`, commit `9b74c04167e79748312160b6476cc5050050b4e3` (`core-v2: complete S10 security isolation and SAST`, 2026-09-25 21:45:55 -0500).
- Worktree: `/home/james/.paseo/worktrees/0jx5pvzi/s11-baseline` (isolated).
- Checkout branch observed: `s11-baseline`; `core-architecture-v2` also contains this same commit (`git branch --contains HEAD` lists both). The task described the branch as `core-architecture-v2`; the worktree is checked out on `s11-baseline` at the same commit.
- Scope: read-only verification. The only repository change is this file (plus the task-instructed read-only `node_modules`/`dist` symlinks; see environment caveat).
- Environment caveat (primary checkout): the primary checkout `/home/james/Desarrollo/agentic-engineering-harness` was being modified by another process during this session (`src/architecture/acceptanceOracle.ts` mtime 21:56:20, `src/core/run.ts` mtime 21:57:29, session end ~21:58). This worker did not write to it. Because `node_modules`/`dist` were symlinked from there, `dist` is not a reliable representation of commit `9b74c04`; all probes and tests below import this worktree's `src/` directly, so the findings are valid for the commit under test.

## Environment facts

```
$ command -v pact pact_verifier_cli bwrap trivy podman docker opa 2>&1
/usr/bin/bwrap
/usr/local/bin/docker
exit=0

pact               MISSING
pact_verifier_cli  MISSING
bwrap              present   (/usr/bin/bwrap)
trivy              MISSING
podman             MISSING
docker             present   (/usr/local/bin/docker)   # daemon unreachable
opa                MISSING

$ node_modules/.bin/playwright --version
Version 1.62.1

$ ls ~/.cache/ms-playwright
chromium-1223
chromium-1228
chromium-1234
chromium_headless_shell-1223
chromium_headless_shell-1228
chromium_headless_shell-1234
ffmpeg-1011

$ node --version   -> v22.23.2
$ python3 --version -> Python 3.13.15
$ npm --version    -> 10.9.8
$ npx --version    -> 10.9.8
$ uname -r         -> 6.18.52-1-cachyos-lts
$ id               -> uid=1000(james) ... 954(docker) ...
$ docker info      -> unavailable (exit 1), binary present but daemon down
```

- This worktree had no `node_modules`/`dist`; both were symlinked read-only to the primary checkout
  (`ln -s /home/james/Desarrollo/agentic-engineering-harness/node_modules node_modules`,
  `ln -s /home/james/Desarrollo/agentic-engineering-harness/dist dist`). `git status` shows only `?? node_modules`, `?? dist` and this file as worktree changes.

## Findings

### 1. Contract validation (Pact / OpenAPI) — missing provider behavior

- `src/providers/validation/pact.ts:14-22` `detect()`: returns a command only when an explicit command is configured, or a local Pact file exists **and** `pact`/`pact_verifier_cli` is installed. With a `pactFile` but no verifier it returns `{ provider: "pact", command: undefined, runtime: "pact-ffi", reason: "local Pact file found but no official verifier executable is installed" }` (`pact.ts:21`). Without a `pactFile` it returns `undefined`.
- `pact.ts:52-56` `runPactVerification()`: when `detection.command` is missing it returns a `ContractVerificationResult` with `status: "SKIP"`, a failure entry `"An official Pact verifier command is required."`, and `rawArtifact: ""` (`pact.ts:54`). `pact.ts:26` `doctor()` reports `available:false` for the same case.
- `src/providers/validation/protocol.ts:18-29` `resultCheck()`: the only thing preventing a silent skip is line 24, `status: failed ? "FAIL" : skipped ? (required ? "FAIL" : "SKIP") : "PASS"`. The embedded `details.result` still carries `status:"SKIP"` (line 27).
- `src/validators/registry.ts:24-31` declared capabilities become `required: true`; `:38` configured-provider specs use `context.spec.required ?? true`.
- Observable: `providers/validation/registry.ts:50` passes `required` into `resultCheck`. Probe with `contract.verification.capabilities=["contract-test"]` and no verifier produced `{ id:"capability.contract-test", category:"contract", status:"FAIL", message:"pact contract was skipped.", resultStatus:"SKIP", provider:"pact" }`.

Verdict: a **required** contract requirement does **not** silently PASS — it is coerced to `FAIL` at the `ValidationCheck` boundary. But the blocking is a generic last-moment coercion: the normalized result and message remain `SKIP` / "was skipped", there is no contract-specific blocker code, `rawArtifact` is empty, and the coercion depends entirely on the `required` flag. A configured `pact` spec with `required:false` stays `SKIP` and does not block (`registry.ts:38`). OpenAPI (`src/validators/openapi.ts:10-12`, `:18-20`) returns `required ? FAIL : WARN` for missing `baseline`/`current` or parse failure — never SKIP — but is only reachable via an explicit `adapter:"openapi"` spec (`registry.ts:40`); a declared `contract-test` capability maps to Pact, never OpenAPI (`registry.ts:55`). Neither path produces candidate-bound contract evidence (`pact.ts:41` writes a non-candidate `persistRawArtifact` path).

### 2. Integration lifecycle

- **Absent readiness command is treated as ready.** `src/providers/validation/integrationEnvironment.ts:42`:
  `ready: !/readiness:FAIL/.test(execution.stdout)`. Probe: provision + test + cleanup, **no** `readinessCommand` → `lifecycle.ready = true`, status `PASS`, stdout `provision:PASS test:PASS cleanup:PASS` (no `readiness:` token emitted). Nothing is actually probed.
- **Cleanup is conditional, not guaranteed.** `integrationEnvironment.ts:34` reads `cleanup` only if `options.cleanupCommand` is a string; `:37` `finally { if (cleanup) await run("cleanup", cleanup); }`. Missing cleanup leaves `cleaned:false` and `:43` `failed = execution.exitCode !== 0 || !lifecycle.provisioned || !lifecycle.cleaned` → status `FAIL` (observed). Cleanup does run in `finally` after a readiness failure (observed `provision:PASS readiness:FAIL test:PASS cleanup:PASS`). It is not guaranteed if the process is killed or the runtime dies.
- **No candidate-bound integration evidence artifact.** The only outputs are `IntegrationEnvironmentResult` embedded in a `ValidationCheck` (`providers/validation/registry.ts:52`, `protocol.ts:27`) and a non-candidate raw file `.harness/evidence/raw/<specId>.raw` (`integrationEnvironment.ts:38` via `persistRawArtifact`). `ValidationProviderContext` (`providers/validation/types.ts:5-14`) has no `candidate` field, so integration evidence can never be bound to a `CandidateRevisionV1`.
- **Generic OCI path fails closed.** `integrationEnvironment.ts:16` `detect()` requires `options.image` **and** a present `podman`/`docker` binary. With the runtime absent, `detect()` is `undefined`, `doctor()` (`:22`) is unavailable without `securityFailures`, and `providers/validation/registry.ts:52` emits `status: SKIP`; `resultCheck` then coerces to `FAIL` for a required requirement. Observed with `PATH` stripped of `docker`/`podman`: `status:"FAIL"`, message `"integration-environment integration-environment was skipped."` With the `docker` binary present but its daemon down (`detect` succeeds, `doctorForCommand` only checks the executable), execution fails and the check is `FAIL` with provider `oci`. Both cases block at the check level; the result-status stays `SKIP` in the unavailable case.

### 3. Browser / visual

- **A declared `browser-test` capability silently falls through to generic unit-test execution.** `src/validators/registry.ts:55` `capabilityAdapter()` maps only `bdd` and `contract-test` explicitly and returns `"test-execution"` for **every** other capability, including `browser-test`. `:47-54` `capabilityForAdapter("test-execution")` returns `"unit-test"`. Probe: `contract.verification.capabilities=["browser-test"]`, no explicit validator → check id `capability.browser-test`, **category `unit-test`**, provider `node-project-test`, command `npm test`. With both an `e2e` script and a `test` script present it returned **`PASS` on `npm test`** and never invoked `npm run e2e`. A required browser assertion can therefore be satisfied by ordinary unit tests.
- The Playwright adapter is reachable only through an explicit `adapter:"playwright"` spec (`registry.ts:41` → `src/validators/external.ts:31`). `src/architecture/validationRequirements.ts:99` maps `playwright → browser-test` and `src/architecture/candidateAssurance.ts:14-18` maps `browser-test + provider "playwright" → "playwright"` for the impact-resolution path (`core/run.ts:744-757`), but the declarative `verification.capabilities` path never reaches it.
- **Missing Playwright binary/browser does not silently skip** on the explicit path. `external.ts:28-36` defaults `playwright` to tool `npx` / `npx playwright test --grep "{taskId}" --reporter=json`; `:39` only calls `missingTool` when `npx` itself is absent. Probes: default command, `required:true` → `FAIL` (exit 1); pinned missing binary + `required:true` → `FAIL` (exit 127, "malformed evidence"); `required:false` → `WARN`. No SKIP.
- **No candidate-bound browser evidence artifact.** `external.ts:84-111` persists `SastEvidenceV1` only for adapters in `SAST_ADAPTERS` (`src/security/sastEvidence.ts:19`). `playwright` writes only `.harness/evidence/<specId>.raw` (`external.ts:77-79`); no trace/screenshot artifact, digest, or candidate binding. A test-only fixture writes `.harness/evidence/browser/...` (`tests/browser/fixture/controlCenterJourney.ts:261`), but that is not a production validation lane.
- **`visual` does not exist as a validation capability, kind, or evidence lane anywhere in `src`.** `rg -i "visual" src` returns no matches. `src/architecture/validationRequirements.ts:9-20` `validationRequirementKindValues` has no `visual`; `schemas/validation-result.schema.json:13,30,46,60` capability enums contain no `browser`/`visual` type. Only design docs name visual as a target (`docs/CORE_ARCHITECTURE_V2.md:462,479`).

### 4. Evidence binding (S9/S10 candidate-bound patterns)

- `src/security/sastEvidence.ts` is the sole candidate-scoped evidence module: candidate directory `:147-150`, persist `:156-191`, load/verify `:193-242`. `src/core/run.ts:785-789` requires it only when `requiresCandidateBoundSastEvidence(...)` (`:811-818`) is true, which is limited to kinds `static-security` / `dependency-security`.
- There is no analog for `contract-test`, `integration-test`, `browser-test` or `visual`: no `contractEvidence.ts`, `integrationEvidence.ts`, `browserEvidence.ts` or `visualEvidence.ts` (`src/security/` contains only `sastEvidence.ts`; `src/evidence/` contains only `graph.ts`).
- `src/validators/types.ts:4-13` `ValidationContext` carries an optional `candidate`, but `src/providers/validation/types.ts:5-14` `ValidationProviderContext` (used by Pact, integration, BDD and test-execution) has none. Candidate binding exists only on the external-tool path and only for SAST adapters.

## Commands run and observed results

Focused tests (this worktree, symlinked `node_modules`):

```
$ node_modules/.bin/vitest run tests/validationProviders.test.ts tests/openapi.test.ts tests/providerContracts.test.ts
 Test Files  2 passed | 1 skipped (3)
      Tests  7 passed | 7 skipped (14)
   # providerContracts.test.ts gated behind AEH_RUN_REAL_PROVIDERS=1 (7 skipped)

$ node_modules/.bin/vitest run tests/candidateAssurance.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)

$ AEH_RUN_REAL_PROVIDERS=1 node_modules/.bin/vitest run tests/providerContracts.test.ts -t "Playwright"
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)   (~6.6s)
 # exercises runExternalToolValidator with an explicit pinned Playwright command only
```

Note: `tests/validationProviders.test.ts:51` self-returns when the Pact CLI is absent, so no baseline coverage exists for "required Pact verifier missing".

Deterministic probes (scratch files in `/tmp/opencode`, importing this worktree's `src` via `node_modules/.bin/tsx`):

```
$ node_modules/.bin/tsx /tmp/opencode/s11-capability-probe.ts
  contract.verification.capabilities=["browser-test"]
  -> [{ id:"capability.browser-test", category:"unit-test", status:"PASS",
        message:"node-project-test unit-test passed.",
        details.provider:"node-project-test", details.result.command:"npm test" }]

$ node_modules/.bin/tsx /tmp/opencode/s11-provider-probe.ts
  A contract-test capability, no config/pactFile
    -> status FAIL, message "pact contract was skipped." (provider pact)
  B contract-test capability with pactFile but no verifier
    -> status FAIL, message "pact contract was skipped." (provider pact)
  C integration-test capability, oci provider, no docker/podman on PATH
    -> status FAIL, message "integration-environment integration-environment was skipped."
  D openapi required with missing baseline/current
    -> status FAIL, message "OpenAPI validator requires options.baseline and options.current."
  E integration-environment adapter required, no provider configured
    -> status FAIL, message "integration-environment integration-environment was skipped."
  F integration-test capability with oci provider, docker present (daemon down)
    -> status FAIL, message "oci integration-environment failed."

$ node_modules/.bin/tsx /tmp/opencode/s11-integration-probe.ts
  no readiness command, cleanup present -> lifecycle {provisioned:true, ready:true, tested:true, cleaned:true}, status PASS
  no cleanup command                  -> lifecycle {..., cleaned:false}, status FAIL
  readiness command FAILS             -> lifecycle {provisioned:true, ready:false, tested:true, cleaned:true}, status FAIL, stdout "provision:PASS readiness:FAIL test:PASS cleanup:PASS"
  cleanup command FAILS               -> lifecycle {..., cleaned:false}, status FAIL

$ node_modules/.bin/tsx /tmp/opencode/s11-browser-probe.ts
  playwright adapter, no command (default npx playwright test), required -> status FAIL (exit 1)
  playwright adapter, pinned missing binary, required                   -> status FAIL (exit 127, malformed evidence)
  playwright adapter, no command, optional                             -> status WARN (exit 1)
  declared browser-test capability, no project script                  -> status FAIL, category unit-test, "project-native-test unit-test was skipped."
  declared browser-test capability, 'e2e'+'test' scripts present       -> status PASS, category unit-test, provider node-project-test (npm test; npm run e2e never invoked)

$ node_modules/.bin/tsx /tmp/opencode/s11-skip-probe.ts
  pact spec required, pactFile present, no verifier
  -> [{ id:"pact-check", status:"FAIL", message:"pact contract was skipped.",
        resultStatus:"SKIP", provider:"pact" }]
```

## S11 gate items unmet at baseline

Gate (docs/CORE_ARCHITECTURE_V2_STATUS.md:223): *required contract and UI assertions resolve to approved providers and current-candidate evidence; missing providers block; browser and visual journeys are reproducible and traceable.*

1. **Contract candidate-bound evidence is absent.** Pact runs through a provider but a missing verifier only becomes a blocking `FAIL` through the generic `resultCheck` SKIP→FAIL coercion; the normalized result stays `SKIP` with an empty `rawArtifact` and no contract-specific blocker (`protocol.ts:24`, `pact.ts:54`). No candidate-scoped contract artifact exists.
2. **OpenAPI is not integrated into the capability lane.** It is reachable only by explicit adapter; a declared `contract-test` capability always selects Pact (`registry.ts:55`). No OpenAPI provider, no candidate binding.
3. **Integration readiness is unverified.** An absent readiness command yields `ready:true` (`integrationEnvironment.ts:42`); no candidate-bound integration evidence artifact exists; cleanup depends on a configured command.
4. **Declared browser assertions are misrouted.** A `browser-test` capability silently executes generic unit tests and can PASS without running any browser journey (`registry.ts:55`; observed). Playwright is only usable via an explicit adapter, and its evidence is not candidate-bound or trace/digest scoped.
5. **Visual validation does not exist.** No `visual` capability, kind, adapter, provider, schema type, or evidence lane in `src` or `schemas`.
6. **Evidence binding is SAST-only.** The S9/S10 candidate-scoped evidence pattern (`src/security/sastEvidence.ts`) has no analog for contract, integration, browser, or visual lanes (`run.ts:811-818`).

Verified at baseline (not gaps): required missing external tools (`opengrep`/`trivy`/`playwright`) produce deterministic `FAIL`; the OCI integration path yields `FAIL` at the check level when the runtime is absent or its daemon is down; absent cleanup yields `FAIL`. No silent PASS was observed for a required requirement; the residual risk is the generic, flag-dependent SKIP→FAIL coercion and the lane substitution in item 4.
