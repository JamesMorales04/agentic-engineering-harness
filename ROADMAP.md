# Roadmap

## v0.1 — foundation ✅
- [x] portable CLI, TaskContracts, sealing, deterministic gates, OPA, Paseo/Engram/Graphify, telemetry and reusable skills

## v0.2 — executable delivery ✅
- [x] requirement traceability, executable Gherkin, validator registry, workers, repair loops, architecture/security/browser/API gates

## v0.3 — measurement and provenance ✅
- [x] engineering evals, run metrics, OTLP, memory benchmarks, mutation/property adapters, SBOM/Cosign/in-toto/SLSA and release hardening

## v0.4.1–v0.4.8 — agent topology and governance ✅
- [x] agent/model/runtime separation, profiles, routing, output contracts, recovery, drift gates, permissions, Graphify parallelism and finding dedup

## v0.4.9 — QuickContract + triage ✅
- [x] deterministic QUICK/SPEC classification from lead-supplied evidence
- [x] sealed QuickContracts with bounded scope and non-bypassable safety constraints

## v0.4.10 — automatic review lifecycle ✅
- [x] routed reviewer wave after deterministic PASS
- [x] structured reviewer output and finding dedup
- [x] deterministic revalidation after remediation
- [x] final lead semantic acceptance

## v0.4.11 — engineering workflow skill ✅
- [x] natural-language entry protocol for Codex/Paseo leads
- [x] QUICK/SPEC workflow selection and mobile-friendly operation
- [x] self-modification controller freeze rule

## v0.4.12 — autonomous quality convergence ✅
- [x] strict residual Quality Gate with integer DebtPoints and 3 notes = 1 low
- [x] no fixed review-remediation round limit
- [x] improvement/stagnation/regression/cycle detection
- [x] safe remediation checkpoint and regression rollback
- [x] automatic workhorse/quality/senior model-agent escalation
- [x] oracle exception diagnosis and autonomous replanning
- [x] human-on-exception only for spec contradiction, missing product decision or external blocker
- [x] quality trajectory and final state persisted in run telemetry

## v0.4.13 — built-in default agent pack ✅
- [x] package-owned `aeh:default` cross-project agent topology
- [x] project topology layers with ordered `extends`
- [x] partial model/runtime/agent/profile overrides
- [x] additive project-specific agents and routing rules
- [x] minimatch removal of inherited agents/models/runtimes/profiles/routing/councils
- [x] cascading cleanup of removed agent references
- [x] agent descriptions propagated as executable role charters
- [x] Harness repository dogfoods its own `.harness/` configuration

## v0.4.14 — selective MCPs + issue/worktree delivery ✅
- [x] OMO/Pawra agent capability review with `designer` and read-only `github-manager` defaults
- [x] reusable verification/worktree/routing/recovery/traceability/dedup/drift/simplify/delivery skills
- [x] per-agent MCP projection into OpenCode runtime configuration
- [x] default Context7, Playwright and read-only GitHub MCP catalog; disabled Sentry candidate
- [x] originating-branch capture at SDD creation
- [x] sealed/non-template `aeh sdd handoff` readiness gate
- [x] deterministic GitHub issue + issue-linked branch creation with env-only credentials
- [x] resumable delivery state after each remote write
- [x] Paseo worktree workspace creation and automatic workspace reuse for implementation/review/repair

## v0.4.15 — issue-driven execution ✅
- [x] `aeh issue inspect/import/implement <number>` and `aeh run --issue <number>`
- [x] deterministic existing-issue fetch, open-state validation and PR-number rejection
- [x] frozen title/body snapshot with SHA-256 provenance
- [x] deterministic scope/domain/risk/acceptance extraction with read-only planner normalization for non-trivial issues
- [x] automatic issue-derived QuickContract or complete SDD/TaskContract/Gherkin materialization
- [x] stable `GH-<issue>-R<n>` traceability and sealing
- [x] bind/reuse the existing issue rather than creating a duplicate delivery issue
- [x] exact issue-linked branch reuse before branch creation
- [x] reuse v0.4.14 Paseo worktree/control-root delivery lifecycle
- [x] `ISSUE_DRIFT` preflight before every issue-derived run
- [x] explicit issue refresh guard once an implementation workspace exists
- [x] engineering-workflow natural-language routing for `implement issue #X`

## v0.5 — scale and governance
- [ ] repeated-run eval dashboards/statistical confidence
- [ ] signed organization policy bundles and inheritance
- [ ] remote execution queue/distributed workers
- [ ] richer code-graph task-to-node mapping for parallel scheduling
- [ ] output-schema-native runtime adapters and structured session resume
- [ ] MCP benchmark harness for token overhead, latency, stale-data risk and permission surface
- [ ] optional observability/issue-system/database/cluster MCP packs validated by evals
