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
- [x] deterministic accepted commit/push/draft-PR finalization

## v0.4.16 — toolchain and bootstrap ✅
- [x] npm package remains the AEH distribution boundary with no mutating `postinstall`
- [x] declarative `.harness/toolchain.yaml` and JSON Schema
- [x] automatic capability-based tool closure from agents/orchestration/validators/project stack
- [x] named toolchain profiles with inheritance
- [x] mise/Aqua provisioning and optional OCI validators
- [x] explicit `aeh setup`, side-effect-free `--dry-run`, `--update-lock` and `aeh init --setup`
- [x] exact logical toolchain lock plus machine-local state/PATH injection
- [x] automatic frozen project dependency setup for npm/pnpm/yarn/bun/uv/.NET
- [x] toolchain-aware `aeh doctor` and packaged-consumer smoke validation

## v0.4.17 — Control-Plane Snapshot & Hard Freeze ✅
- [x] materialized per-run controller snapshot with per-file and composite SHA-256
- [x] freeze project config, agent topology, toolchain lock, policies, schemas and skills
- [x] self-hosted AEH runs freeze controller source modules as well
- [x] selected skill content is injected from the frozen snapshot rather than mutable live files
- [x] OPA validation resolves policies through the frozen control-plane root
- [x] live controller drift is recorded but cannot govern the active run

## v0.4.18 — Executable Multi-Worker Planner Waves ✅
- [x] planner output becomes an executable delegation DAG rather than advisory metadata
- [x] every requirement must be assigned to at least one implementation task
- [x] one isolated Git worktree per task with binary patch return
- [x] dependency-aware/concurrency-bounded waves
- [x] scope enforcement and all-patch integration checks before wave application
- [x] deterministic validation barrier between waves
- [x] local or distributed task execution behind the same patch boundary

## v0.4.19 — Requirement Evidence Graph ✅
- [x] first-class run/requirement/task/file/check/finding/session/commit/PR evidence nodes
- [x] requirement-to-task-to-file and requirement-to-validator edges
- [x] concrete changed-file implementation evidence required
- [x] PASS validator evidence required for declared validators
- [x] configurable strict evidence completeness gate
- [x] final delivery commit/PR captured into the persisted graph

## v0.4.20 — Worker Sandbox Hardening ✅
- [x] risk-driven sandbox enforcement policy
- [x] rootless Podman worker isolation for supported OpenCode workloads
- [x] read-only container root, ephemeral HOME, `cap-drop=ALL`, no-new-privileges and PID limits by default
- [x] network deny when policy/agent permissions deny network
- [x] optional CPU/RAM/tmpfs limits and immutable image digest
- [x] explicit environment/credential allowlists; no implicit host SSH/socket projection
- [x] legacy Podman worker path uses the same hardened policy

## v0.5 — Scale & Organization Governance ✅
- [x] repeated-run eval dashboards with variance, confidence intervals and Wilson pass-rate intervals
- [x] SHA-pinned organization policy bundles, inheritance and optional Cosign signature verification
- [x] filesystem and HTTP remote execution queues with leases, expiry and worker loops
- [x] remote workers remain untrusted patch producers; coordinator owns scope checks, integration and deterministic validation
- [x] richer Graphify node/file mapping, adjacency distance, shared-node and centrality scheduling evidence
- [x] output-schema-native adapters where supported plus Zod fallback verification
- [x] Codex/OpenCode/Paseo structured session-resume primitives where runtime semantics allow them
- [x] MCP benchmark harness for configuration token footprint, probe latency, stale-data risk and permission surface
- [x] named least-privilege MCP packs; observability pack remains opt-in until project evals justify it

## v0.5.1 — Zero-friction Paseo entrypoint ✅
- [x] `aeh start` starts or reuses the Paseo daemon and web UI
- [x] interactive lead is resolved from the active agent topology rather than hard-coded
- [x] managed Paseo/lead runtime dependencies reconcile automatically when needed
- [x] persistent project lead session is created once and reused while compatible
- [x] session bootstrap turns every repository-mutating natural-language prompt into an automatic `engineering-workflow` entry
- [x] lead automatically builds triage evidence and obeys deterministic QUICK/SPEC classification
- [x] parent lead cannot use direct implementation as a shortcut around sealing/Harness execution
- [x] generated `AGENTS.md` provides a second project-level interactive-entry invariant
- [x] local Paseo session/bootstrap state is gitignored and no global Paseo config is rewritten

## v0.5.2 — Engineering intent + Harness-governed AUDIT ✅
- [x] top-level `INFORMATIONAL | AUDIT | CHANGE` intent model
- [x] only pure INFORMATIONAL requests may bypass Harness execution
- [x] `aeh intent` classifies engineering work before change complexity triage
- [x] `aeh audit` provides repository-wide read-only engineering review without fake QUICK/SDD scope
- [x] transient sealed audit TaskContract and hard-frozen control plane
- [x] configured deterministic validation plus explicit assertion/environment/sandbox/dependency/tool failure classification
- [x] read-only reviewer sessions with write/gitWrite/delegate denied
- [x] worktree checkpoint/rollback preserves pre-existing local changes and removes accidental audit mutations
- [x] normalized/deduplicated findings plus severity DebtScore and Quality Gate assessment
- [x] machine-readable `.harness/audits/<id>.json` and `latest.json`
- [x] audit-to-remediation continuity: later fixes become a new CHANGE and re-enter QUICK/SPEC
- [x] Paseo bootstrap v2 makes engineering reviews use AUDIT instead of the v0.5.1 read-only escape
- [x] self-hosted hard freeze includes `src/audit` and `src/paseo`

## v0.6 — Orchestration & Context Architecture ✅
- [x] thin lead becomes semantic orchestrator instead of interactive environment/SDD/operator process
- [x] bounded `environment-manager` and `spec-manager` agents plus read-only planner discipline
- [x] `aeh:orchestration` built-in preset becomes the new project default while retaining `aeh:default` composition
- [x] Paseo-native/MCP orchestration and `/paseo-handoff` preferred from conversational agents; CLI remains deterministic fallback
- [x] Paseo CLI capability negotiation removes hard dependency on `--quiet`/fixed output shape and recovers stale daemons
- [x] `aeh start` creates a fresh lead by default; `--resume` explicitly reuses a compatible session
- [x] 70/80/90 context-pressure policy with durable `.harness/paseo/handoffs/` state
- [x] managed context guard automatically rotates to a fresh lead at the handoff threshold instead of normal compaction
- [x] OpenSpec becomes the SPEC authoring backend through `spec-manager`
- [x] `aeh spec prepare/compile` compiles OpenSpec requirements/scenarios/tasks into native AEH SDD, TaskContract and Gherkin
- [x] OpenSpec authoring provenance is SHA-256 recorded while compiled/sealed AEH artifacts remain runtime truth
- [x] OpenSpec is provisioned declaratively through the existing toolchain
- [x] OpenSpec compilation refuses phantom validators and derives executable project test/typecheck/build evidence when safe
- [x] consumer and self-hosted instructions/configuration dogfood the orchestration-first design

## Next
- [ ] signed attestations for evidence/controller/audit/handoff manifests themselves
- [ ] remote worker sealed-context bundles for workloads needing full SDD text rather than delegated summaries
- [ ] queue persistence/HA adapters beyond filesystem/simple HTTP
- [ ] empirical MCP tool-schema token measurement through runtime-native introspection
- [ ] statistical sequential testing and automatic model/topology promotion policies
- [ ] configurable organization audit policies and audit report upload/retention adapters
- [ ] runtime-native context telemetry contract once Paseo exposes a stable cross-provider percentage field
