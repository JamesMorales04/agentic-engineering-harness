# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control plane** for agentic software engineering. AEH treats LLM output as untrusted until deterministic validation, evidence and quality gates accept it.

## Status: v0.6.1

v0.6 makes the interactive lead a **thin semantic orchestrator** instead of an interactive shell/CI operator. Repository discovery, environment repair, planning, SPEC authoring, implementation and review are delegated to bounded roles while AEH remains the deterministic authority. v0.6.1 adds managed Harness asset reconciliation and automatic semantic release publication from `main`.

```text
User / Paseo
    |
    v
fresh AEH Lead
    |
    +-- INFORMATIONAL -> direct answer
    |
    +-- AUDIT -> frozen read-only AEH audit
    |
    `-- CHANGE
          |
          +-- explorer -> planner -> deterministic triage
          |
          +-- QUICK -> bounded sealed QuickContract
          |
          `-- SPEC -> spec-manager -> OpenSpec
                                  -> aeh spec compile
                                  -> sealed AEH SDD/TaskContract
    |
    v
planner waves -> workers -> deterministic barriers
    -> evidence graph -> validators -> reviewer convergence
    -> final quality gate -> lead acceptance -> delivery
```

See [docs/V0.6.md](docs/V0.6.md) for the orchestration/context design and [ROADMAP.md](ROADMAP.md) for completed milestones.

## Installation

Pin AEH as a project development dependency:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
npm exec aeh -- doctor
```

`aeh setup` provisions the project-selected engineering toolchain through mise/Aqua/OCI where configured. There is no mutating npm `postinstall`.

A new project receives:

```text
.harness/project.yaml
.harness/agents.source.jsonc   -> extends aeh:orchestration
.harness/toolchain.yaml
.harness/skills/
.harness/managed-assets.json   -> versioned hashes for AEH-managed skills/policies
openspec/config.yaml
AGENTS.md
```

Packaged core skills and policies are reconciled by `aeh init`, `aeh setup`, and `aeh start`. Missing assets are restored, untouched managed assets can be upgraded with the installed AEH version, and locally modified copies are preserved as explicit overrides.

## Zero-friction Paseo entrypoint

```bash
aeh start
# or
npm exec aeh -- start
```

A normal start creates a **fresh lead conversation**. Reuse is explicit:

```bash
aeh start --resume
```

Before the agent topology is loaded, `aeh start` reconciles the managed `.harness` control-plane assets. The lead is then resolved from the active agent topology. Paseo and the configured lead runtime are reconciled when needed, the daemon is started/recovered, and the lead is bootstrapped with the project engineering workflow.

### Lead responsibilities

The lead owns:

- user intent and explicit product decisions;
- high-level routing and true ambiguity;
- deterministic state transitions;
- final semantic acceptance.

It delegates:

```text
explorer              -> repository discovery
environment-manager   -> doctor/setup/Paseo/toolchain recovery
planner               -> read-only decomposition and triage evidence
spec-manager          -> OpenSpec SPEC authoring
implementers          -> code changes
validators/reviewers  -> evidence and quality assessment
```

When Paseo injects its orchestration tools, the lead prefers its native/MCP `create_agent`, prompt/status/activity/lifecycle tools and `/paseo-handoff`. AEH retains a capability-aware CLI adapter as a deterministic fallback.

The fallback probes the installed Paseo version/help surface rather than assuming flags such as `--quiet`, and recovers recognized stale/unreachable daemon states before relaunch.

## Context lifecycle

Default interactive thresholds:

```text
<70%     normal
70-80%   pressure mode; stop exploratory work and increase delegation
>=80%    proactive handoff + fresh lead rotation
>=90%    mandatory handoff; old lead must not continue engineering work
```

Public guard:

```bash
aeh context guard --agent "$PASEO_AGENT_ID"
```

When Paseo exposes a usable context ratio, AEH persists:

```text
.harness/paseo/handoffs/lead-<timestamp>.json
```

The artifact carries prior/new lead IDs and durable branch/run/audit/delivery references. Inside a managed Paseo lead, AEH automatically creates the fresh replacement at the handoff threshold. The new lead reads deterministic artifacts rather than relying on normal chat compaction.

## Intent model

Every engineering request is classified as:

```text
INFORMATIONAL
AUDIT
CHANGE
```

Examples:

```text
"What does this class do?"
  -> INFORMATIONAL

"Review the repo and validate it for improvements"
  -> AUDIT

"Improve the code readability"
  -> CHANGE -> QUICK | SPEC
```

Repository-wide audits use `aeh audit`; they are not forced into fake QUICK scope.

## OpenSpec-backed SPEC authoring

For SPEC work the lead does **not** write proposal/spec/design/tasks itself. It delegates to `spec-manager`.

```bash
aeh spec prepare READABILITY-001 --title "Improve readability"
# spec-manager authors/validates OpenSpec artifacts
aeh spec compile READABILITY-001 --title "Improve readability"
aeh sdd validate READABILITY-001
aeh seal READABILITY-001
aeh run READABILITY-001
```

Authority split:

```text
OpenSpec
  = authoring source before freeze

compiled AEH SDD + TaskContract + seal
  = normative execution truth
```

The compiler maps OpenSpec requirements/scenarios/tasks into stable AEH requirement IDs, Gherkin and TaskContract traceability. It records OpenSpec SHA-256 provenance and refuses to emit a requirement backed only by a nonexistent validator. Configured validators are preferred; standard project test/typecheck/build commands are derived when safe.

OpenSpec is provisioned automatically when `sdd.authoring.provider: openspec` is active.

## Issue-driven execution

```bash
aeh issue inspect 142
aeh issue import 142
aeh issue implement 142
# equivalent
aeh run --issue 142
```

An issue is frozen as input, converted into QUICK/SPEC artifacts, sealed, and then executed through the same worker/validation/review lifecycle. `ISSUE_DRIFT` prevents silent reinterpretation after intake.

## AUDIT

```bash
aeh audit "review the repo and validate the code for improvements"
```

AUDIT is read-only but Harness-governed:

- frozen control plane;
- deterministic validators;
- explicit environment/sandbox/assertion/tool failure classification;
- read-only reviewer wave;
- finding normalization/deduplication;
- DebtScore/Quality Gate reporting;
- worktree rollback preserving pre-existing dirty state.

Reports live under `.harness/audits/`. A later `fix these` request becomes a new CHANGE using the AuditReport as evidence.

## QUICK and SPEC

QUICK is only for concrete bounded low-risk file scope. Wildcard/repository-wide, security, architecture, auth, schema/migration, public API, dependency, cross-module or medium/high-risk changes escalate to SPEC.

For SPEC, OpenSpec authors the intent and AEH compiles/seals the executable contract. AEH then executes the planner-produced multi-worker DAG with isolated worktrees, deterministic wave barriers, requirement evidence, validators, review convergence and final lead acceptance.

## Quality authority

Default DebtPoints:

```text
critical = 300 = DebtScore 100
high     =  75 = DebtScore 25
medium   =  24 = DebtScore 8
low      =   3 = DebtScore 1
note     =   1 = DebtScore 1/3
```

Final acceptance requires critical/high/medium = 0, low <= 3 and DebtScore <= 3. Remediation has no arbitrary maximum round count; stagnation/regression/cycles trigger rollback, stronger agents/models, diagnosis and replanning.

## Trust model

1. User intent and genuine product decisions.
2. Frozen TaskContract / compiled AEH SDD / issue snapshot as applicable.
3. Deterministic validator and evidence output.
4. Quality/review gates.
5. LLM summaries, memory and structural/research tooling as advisory information.

Workers never gain authority to weaken requirements or deterministic gates. Paseo improves orchestration; OpenSpec improves authoring; neither replaces AEH acceptance authority.

## Distribution

AEH is a development tool, not an application runtime dependency. The npm package contains CLI code, templates, presets, policies, schemas, skills and docs. CI validates `npm ci`, typecheck, tests, build, `npm pack --dry-run`, and installs the generated tarball into an empty consumer project for smoke testing.

Pushes to `main` can publish automatically through `.github/workflows/publish.yml`. `package.json` is the version source; if its current version has already shipped, Conventional Commit semantics select the next patch/minor/major version before publication. See [docs/PUBLISHING.md](docs/PUBLISHING.md) for authentication, retry and manual-release controls.

## License

Apache-2.0.
