---
name: aeh-browser-e2e
description: Execute and review the governed real-browser E2E journey against the current AEH candidate Control Center.
license: Apache-2.0
---
# AEH Real-Browser E2E

Repository-owned developer knowledge for real-browser E2E execution and evidence review. It is not learned memory and not a normative architecture change. `docs/CORE_ARCHITECTURE_V2.md` remains the normative target. Keep assignment to the narrowest existing role that owns AEH browser evidence; do not load it into generic prompts by default.

## Golden path

One path, in order. Every step must be real; a substituted step is not browser E2E:

1. supported AEH self-checkout bootstrap/start path (`npm ci && npm run build` -> `startPaseoHarness`, `src/paseo/start.ts`);
2. exact candidate package/runtime invocation (`npm run aeh -- start --no-open`, which runs `node ./dist/main.js` and re-execs to the built package dist), never a global, stale or bundled copy;
3. real Paseo daemon/session with durable lead identity;
4. actual URL emitted/exposed by that supported flow (the stdout `controlCenterPairing=` value, cross-checked against the `controlCenter=` origin);
5. real Playwright browser provisioned from the candidate's pinned `@playwright/test`;
6. actual UI (Control Center embedded in the built package), no mock or jsdom DOM;
7. actual server/controller/backend behind that URL;
8. durable governed operation and its controller-owned state;
9. attributable evidence (assertions, exact command/exit, sanitized trace/screenshot).

If any step is replaced by API-only, source inspection or a direct HTTP substitute, the run is not browser E2E and must not be reported as PASS.

## Browser surfaces — do not mix

- **(A) Paseo Web UI** — human interaction with Paseo/workspaces. Never the AEH product URL and never acceptance evidence for AEH UI behavior.
- **(B) Paseo-native `browser_*` tools** — require a connected browser automation host and exist for that capability only. They are exploratory. Do not claim deterministic acceptance from them. Do not begin with `browser_list_tabs`/`browser_snapshot` unless Paseo-native browser tooling itself is under test.
- **(C) AEH real-browser validation** — runnable Playwright Chromium/Firefox/WebKit from the candidate against the actual product URL. This is the only surface that yields deterministic browser acceptance for AEH.

A missing Paseo-native browser host does **not** block Playwright E2E and is not a reason to install Paseo Desktop. Playwright test/validator evidence is deterministic browser acceptance; MCP browser interaction is exploratory only.

## Supported self-checkout invocation

The authoritative start path in this checkout is:

```sh
npm ci
npm run build                 # TypeScript + embedded Control Center release
npm run aeh -- start --no-open [projectRoot]
```

- `npm run aeh` executes `node ./dist/main.js`; the self-checkout re-execs to the built package `dist` release selected by `dist/current`.
- `--no-open` suppresses the host browser opener so the E2E controls navigation; it does not disable the Control Center.
- `--new` forces a fresh lead, `--resume` reuses a compatible one. Daemon recovery happens inside the flow (stale status -> `paseo daemon stop` -> `paseo daemon start --web-ui`). There is no `aeh restart` subcommand; a restart is a supported `start --new` plus a new detached Control Center. Record the command actually used.
- Never use `--deterministic` / `AEH_DETERMINISTIC_PASEO=1` for browser evidence; that path uses a fake Paseo boundary and prints no Control Center URL.
- Never substitute a global `aeh`, a stale `dist` release, or a guessed `npx` package.

## Product entry and URL discipline

- Never invent a test-only product entry route, server flag, deep link or query parameter.
- Capture the URL the supported flow actually prints. Navigate Playwright to the exact single-use `controlCenterPairing=` URL from the public start stdout. The bare `controlCenter=` URL is unauthenticated and must not be treated as the product entry.
- The UI consumes and clears the `#pair=` fragment in the browser, then continues with the same-browser session cookie. Keep pairing material only in memory; never save the nonce, fragment, CSRF token or cookies to fixtures, logs, screenshots, traces or reports.
- `.harness/runtime/snapshot.json` (`kind: "control-center"`, `healthUrl`) is the durable cross-check for the emitted origin. `aeh control-center <root> --ready-file <path>` emits the same URL for a supported standalone run.
- Never hardcode `localhost`, `127.0.0.1`, a port, `app.paseo.sh`, a workspace URL, or a guessed host; derive the origin from the emitted pairing URL.
- Sanitize every artifact before saving: pairing fragment, auth/CSRF, cookies, tokens and nonces must never appear.

## Pairing and session mechanics

1. The supported start prints `controlCenter=<base>` and `controlCenterPairing=<base>#pair=<nonce>`.
2. Playwright navigates once to the exact pairing URL. The UI stores `pair` from the fragment, clears the fragment with `history.replaceState`, POSTs `/api/v1/pair` same-origin, and receives the HttpOnly `SameSite=Strict` session cookie.
3. All later reads and mutations use that same browser context/session; mutations send `X-AEH-CSRF` obtained from `/api/v1/session`.
4. A second POST with the same nonce is rejected (one-use pairing). Session expiry requires a fresh supported start; never re-mint, hand-construct or share a session.
5. Pairing fragment, cookie and CSRF token never leave browser memory.

## Durable state map

| Artifact | What it proves |
|---|---|
| `.harness/paseo/lead-session.json` | Lead runtime identity: version 2, bootstrapVersion, `aehVersion`, exact `aehCommand`, generation, provider/model, agentId |
| `.harness/paseo/lead-bootstrap.md` | The bootstrap actually injected into the lead |
| `.harness/runtime/snapshot.json` | Managed service identity (`paseo`, `control-center`) and health URLs |
| `.harness/operations/<id>.json` | Authoritative operation status/phase/revision, candidate identity, policy digest, controller epoch, pending `DecisionRequest`, continuation |
| `.harness/operations/<id>/events.ndjson` | Durable transition history |
| `.harness/security/human-decisions.json` | Scoped `HumanDecision` records and consumption/continuation state |
| `.harness/evidence/...` | Candidate-bound run artifacts (sanitized) |
| `dist/current` + `dist/releases/<id>/build-identity.json` | The exact candidate build under test |

## Pre-browser checklist

Do not open a browser until each item is verified and recorded:

1. **Git/candidate state** — `git rev-parse HEAD`, `git status --short`, `dist/current`, `dist/releases/<id>/build-identity.json` (packageVersion, gitSha, releaseId, buildDigest, dirty). Rebuild when the candidate is stale; record the exact identity tested.
2. **Package/runtime invocation** — the exact bootstrap (`npm ci && npm run build`) and start (`npm run aeh -- start --no-open ...`) commands; confirm the package script runs `node ./dist/main.js` and that the self-checkout re-execs to the built package `dist`. No global/stale/npx substitution.
3. **Paseo daemon/session** — `paseo daemon status`, `paseo daemon status --json` when supported; `.harness/paseo/lead-session.json` (version, current supported bootstrap version, agentId, generation, leadAgent, provider, model, aehCommand); `paseo --version`. Read the bootstrap version from this candidate's implementation; do not assume a number from an earlier run.
4. **Actual URL production path** — the emitted `controlCenterPairing=` and `controlCenter=` lines, plus `.harness/runtime/snapshot.json` health URL. Quote the exact source; never assume a port.
5. **UI build** — `npm run build` embeds the Control Center into the release. Do **not** run the UI-only workspace build into `ui/control-center/dist` before the build-hygiene checks; that generated output is not the product. Confirm the footer `buildIdentity` matches the candidate.
6. **`@playwright/test` version** — read the exact version from this candidate's `package.json` and lockfile. Use the candidate's `node_modules/.bin/playwright`; a bare `npx playwright` may resolve another version.
7. **Browser binary/version/provisioning** — verify the pinned browser and version in the Playwright cache. If absent, provision through the candidate's supported `node_modules/.bin/playwright install <browser>` command after package setup. Do not blindly reinstall Playwright or its browsers.
8. **Configs/helpers** — inspect the maintained `tests/browser/playwright.config.ts`, `tests/browser/s9-control-center-journey.e2e.ts`, and `tests/browser/fixture/` real-journey fixture for this candidate. If a required journey fixture is absent, freeze its contract with the Lead before implementation; do not improvise one silently.
9. **Server/auth/CSRF** — loopback-only bind, one-use pairing, HttpOnly `SameSite=Strict` session cookie, same-origin POST, `X-AEH-CSRF` header for mutations. The UI, not the test, performs pairing.
10. **Durable fixture state** — operation ID, current candidate identity, `operationExecutionRevision`, `policyDigest`, `controllerEpoch`, pending `DecisionRequest`, and ledger path, all created through production paths (see fixture contract).
11. **Evidence destination** — a clean directory (for example `.harness/evidence/browser/<operation>/`) for sanitized screenshots/traces and the exact command/exit log.

## Focused repository discovery

Verify the path, then search narrowly; prefer known paths -> focused search -> runtime inspection. Do not broad-search when the skill already names the location:

`package.json` -> `AGENTS.md` -> `src/paseo/` -> `src/entry.ts` -> `src/control-center/` -> `ui/control-center/` -> `src/operations/` -> `src/runtime/` -> `src/validators/` -> `.harness/project.yaml` -> `presets/agents/` -> relevant tests.

Context/token efficiency: read only the smallest named file region, never dump a full log or the whole harness, quote only sanitized excerpts, and prefer the harness's structured `journey.json` over raw console output. A failing navigation is isolated in the focused spec run; do not expand into repository-wide exploration or a full-suite rerun to explain it.

Useful anchors: `startPaseoHarness`/`runStart` (start output), `LocalControlCenterV1` (server/pairing/CSRF/routes), `ui/control-center/src/{App.tsx,api.ts}` (rendered controls and strict response parsing), `src/operations/state.ts` (operation record, DecisionRequest, continuation, epochs), `src/security/humanDecision.ts` (scoped, exactly-once ledger), `src/runtime/managed.ts` (service snapshot), `tests/controlCenter.test.ts` and `tests/humanDecision.test.ts` (existing production-path fixtures).

## Fixture contract

- `AGENTS.md` forbids starting AEH operations against this AEH development checkout. Use a disposable consumer fixture root and drive the actual supported package path against it.
- Create fixture state through the production controller/public APIs against that disposable root, with a valid current candidate, policy and controller identity. Never hand-write a successful operation record, HumanDecision ledger entry, receipt or report; never edit `.harness/operations/*.json`, `events.ndjson` or `.harness/security/human-decisions.json` to simulate success.
- The browser must use the actual paired UI controls for every acceptance action. Direct HTTP is acceptable only for setup/verification that the UI itself cannot perform, and never as a substitute for UI evidence.
- If no reusable production-path fixture exists for the required state, stop and freeze the fixture contract with Luna before implementation. Do not improvise a new entry route, request type or controller shortcut.

## Mandatory S9 journey

Every item is an assertion in the browser test, not a manual narrative:

1. Start or reuse through the supported self-checkout path; capture the real emitted pairing URL and the candidate/runtime identity.
2. Playwright navigates to the exact emitted `controlCenterPairing=` URL; the UI consumes the fragment, establishes the same-browser session, and the Control Center loads (buildIdentity present, authenticated session).
3. Inspect a durable governed operation: read `.harness/operations/<id>.json` (or the controller API) and compare the semantic UI projection with authoritative durable state (kind, status, phase, revision, candidate identity). Mismatch is a finding.
4. Confirm a real pending `DecisionRequest` on a `RUNNING` `HUMAN_REQUIRED` operation, tied to the current operation/candidate/policy/scope (requestId, candidate digest, `operationExecutionRevision`, `policyDigest`, `controllerEpoch`, choices, `resumeTarget=SPEC_AUTHORING`).
5. Submit one allowed choice through the rendered UI control (radio choice + optional reason + submit).
6. Verify the frontend -> paired server -> controller path: durable `HumanDecision` persisted in `.harness/security/human-decisions.json`; exact-once consumption; replay of the same request/choice rejected; continuation target resumed; identity revalidated against operation, candidate, policy, `operationExecutionRevision`, controller epoch, participant/session identity as relevant, and decision scope/version; the refreshed UI shows the authoritative post-decision projection.
7. Exercise pause/resume/cancel controls that the candidate actually renders. Pause is the normative `PAUSED` operation state entered only after active writers are safely drained/fenced; resume is the controller's reload and revalidation of the saved `PAUSED` continuation against current identity before work continues. `PAUSED` is distinct from `HUMAN_REQUIRED`: `HUMAN_REQUIRED` waits for a scoped product/action decision and must never be labeled or tested as pause. Cancel is the candidate's cancellation control/route. If a control required by the frozen S9 contract is absent from the actual UI, classify it (normally `PRODUCT_DEFECT`) and report it; never add a test-only route or silently substitute direct HTTP.
8. Reject a stale or out-of-scope control/decision: wrong operation, consumed/expired request, wrong candidate/revision/policy/epoch, or replay must fail closed and leave durable state unchanged.
9. Prove writers are fenced/drained around a control transition: no participant/controller write lands after the fence, and old-epoch/fenced writers are rejected. Observe participant status and durable revision/epoch transitions.
10. Final projection matches durable controller state after the journey, including operation status/phase/revision and the absence of the consumed decision request.

## Evidence

Persist and report:

- the browser test assertions and the exact command with its exit status;
- candidate/package identity (packageVersion, releaseId, buildDigest, gitSha, dirty);
- the tested URL origin and path, never the pairing fragment or nonce;
- operation ID, candidate identity/digest, `operationExecutionRevision`, `controllerEpoch`;
- `@playwright/test`, Playwright and browser versions;
- sanitized screenshot and trace (video only if genuinely useful);
- relevant request/status summaries without credential material;
- console errors and page errors.

Evidence must identify the tested candidate/state precisely and must not expose pairing fragments, auth/CSRF tokens, cookies or nonces.

## Deterministic browser acceptance

- Run the journey as `@playwright/test` assertions with the JSON reporter; retain traces and screenshots on failure.
- The AEH `playwright` validator adapter (`src/validators/toolEvidence.ts`) normalizes the JSON report into deterministic findings; a required browser check passes only with a passing run bound to the current candidate.
- UI/browser impact resolves to the typed `browser-test` requirement through candidate assurance; a missing or disallowed browser provider fails closed.
- Store the run under the evidence destination and record the exact candidate/release identity in the report. Never infer browser success from adapter contracts or from an exploratory MCP session.

## Control semantics and fencing

- Product-choice suspension is durable: `phase=HUMAN_REQUIRED` plus a waiting continuation and complete `DecisionRequest` are persisted **before** the UI can show the choice. This is not pause.
- Pause is the separate normative `PAUSED` state: it requires safe drain/fencing of active writers and durable drain/fence receipts before it is observable, and resume reloads and revalidates the saved continuation against current identity. Never conflate `PAUSED` with `HUMAN_REQUIRED`, and never treat a pending decision as proof of pause.
- Resume requires the controller to revalidate the continuation and consumed-decision binding against current operation, candidate, policy, `operationExecutionRevision`, controller epoch, decision scope/version, and participant/session identity where relevant.
- A new controller epoch fences old writers; stale consumed choices are never rebound. After takeover, an unchanged unanswered request may be reissued, while a consumed choice requires a fresh current-binding request.
- Cancellation goes through the controller. After fencing, no participant write may land; inspect participant status and durable revision/epoch transitions to prove drain.
- Crash-uncertain external effects remain RECONCILING/BLOCKED/HUMAN_REQUIRED and are never retried blindly.
- The Control Center is a semantic projection; it cannot accept a transition on its own.

## Command reference

| Step | Command |
|---|---|
| Bootstrap candidate | `npm ci && npm run build` |
| Start against disposable root | `npm run aeh -- start --no-open <root>` |
| Daemon/session check | `paseo daemon status` |
| Candidate release | read `dist/current`; `dist/releases/<id>/build-identity.json` |
| Candidate version | `npm run aeh -- --version` |
| Pinned browser tool | `node_modules/.bin/playwright --version` |
| Provision pinned browser | `node_modules/.bin/playwright install chromium` |
| Focused journey run | `npm run test:browser-e2e` (builds the candidate, then runs `node_modules/.bin/playwright test --config tests/browser/playwright.config.ts`; add `-- --reporter=list,json` when a normalized report is needed) |

## Failure classification and debug order

Before any production repair, classify exactly one:

- `PRODUCT_DEFECT` — the candidate's product behavior or rendered UI is wrong.
- `TEST_DEFECT` — the test/assertion/fixture is wrong, flaky or over/under-specified.
- `TEST_INFRASTRUCTURE_UNAVAILABLE` — required browser/tool/provider cannot run in this environment.
- `ENVIRONMENT_DEFECT` — host, daemon, port, filesystem or platform problem.
- `AUTHORIZATION_REQUIRED` — missing human authority, credential or approval.
- `ARCHITECTURE_DECISION_REQUIRED` — the requirement contradicts the frozen architecture.

Classify `TEST_INFRASTRUCTURE_UNAVAILABLE` only after checking and, where supported, provisioning the pinned candidate Playwright browser and verifying that an approved execution path can launch it. If the browser is installed but the shell blocks its OS sandbox/process requirements, classify that environment restriction and use the host's approved browser execution path before concluding unavailable. A missing Paseo-native browser host does not establish unavailable infrastructure.

Then debug in this order: `REPRODUCE -> CLASSIFY -> ISOLATE -> REPAIR -> FOCUSED RERUN -> FULL BROWSER JOURNEY -> AFFECTED DETERMINISTIC GATES`. Do not edit production immediately after a browser failure; reproduce and classify first. An architecture contradiction means stop and report `ARCHITECTURE_DECISION_REQUIRED`; do not reinterpret `docs/CORE_ARCHITECTURE_V2.md`.

## Anti-patterns

- API-only substitution for UI behavior.
- Direct HTTP in place of browser evidence.
- jsdom/mock DOM or mocked browser as PASS.
- Source inspection reported as E2E PASS.
- Agent statement of PASS as evidence.
- Installing Paseo Desktop only to obtain a missing Paseo-native browser host.
- Blindly reinstalling Playwright or its browsers, or using bare `npx playwright` over the pinned candidate binary.
- Hardcoded URL, port or workspace.
- Unnecessary test-only server/UI route.
- Full-suite rerun after each navigation failure instead of focused isolation.
- Production edit before reproduction/classification.
- Browser MCP exploration treated as deterministic acceptance.
- Silent assertion weakening to make the journey pass.

## Exit criteria

Return PASS only when all are true; otherwise return the classification with blocking evidence:

- the journey ran against the exact candidate build identity recorded in the evidence;
- the pairing URL came from the live supported start output for this run;
- every journey item was asserted by Playwright, not described;
- decision and control evidence is durable, and replay/stale rejection was exercised;
- the final UI projection equals durable controller state;
- no pairing/secret material appears in any artifact;
- affected deterministic gates were rerun after any repair.

## Scope

Use this skill only for the AEH S9 browser-closure evidence review assignment. It is reconciled from `skills/aeh-browser-e2e/SKILL.md` into `.harness/skills/` by the managed-asset reconciler; the source is the single authoring location. After human Lead review against source and the current S9 contracts, use this procedure for the remaining S9 browser closure.
