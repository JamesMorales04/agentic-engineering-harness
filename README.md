# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control plane** for agentic software engineering. AEH treats LLM output as untrusted until deterministic validation, evidence and quality gates accept it. Free, locally executable OSS capabilities may be mandatory; paid licenses and paid hosted services are not.

## Status: v0.6.x

v0.6 makes the interactive lead a **thin semantic orchestrator** instead of an interactive shell/CI operator. Long Harness workflows are first-class detached operations: AEH remains the deterministic authority while real planners, reviewers, implementers and escalation agents appear as independent Paseo sessions correlated by durable operation/task labels.

```text
User / Paseo
    |
    v
fresh AEH Lead
    |
    +-- INFORMATIONAL -> direct answer
    |
    +-- AUDIT -> detached AEH operation
    |               -> visible Paseo reviewers
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
                          `-> detached AEH run operation
                                  -> visible Paseo workers/reviewers
    |
    v
planner waves -> workers -> deterministic barriers
    -> evidence graph -> validators -> reviewer convergence
    -> final quality gate -> lead acceptance -> delivery
```

See [docs/V0.6.md](docs/V0.6.md), [docs/PASEO.md](docs/PASEO.md), [docs/CONTEXT_EFFICIENCY.md](docs/CONTEXT_EFFICIENCY.md), and [ROADMAP.md](ROADMAP.md).

## Installation

Pin AEH as a project development dependency:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
npm exec aeh -- doctor
```

`aeh setup` provisions the project-selected engineering toolchain through mise/Aqua/OCI where configured. New projects provision the mandatory local Serena semantic provider and Headroom compression provider through the pinned Python/uv toolchain. There is no mutating npm `postinstall`.

A new project receives repository-owned declarative configuration plus generated local state:

```text
.harness/project.yaml
.harness/agents.source.jsonc   -> extends aeh:orchestration
.harness/toolchain.yaml
.harness/otel-collector.yaml
.harness/skills/
.harness/managed-assets.json
openspec/config.yaml
AGENTS.md
```

`.harness` runtime state is ignored by default. Only repository-owned declarative files are explicitly allowlisted in `.gitignore`, so newly introduced generated state cannot be committed accidentally.

Packaged core skills and policies are reconciled by `aeh init`, `aeh setup`, and `aeh start`. Missing assets are restored, untouched managed assets can be upgraded with the installed AEH version, and locally modified copies are preserved as explicit overrides.

### Developing AEH itself

When the target repository is **this AEH source checkout**, do not rely on an unqualified remote `npm exec aeh` as the runtime selector. npm may reuse an `_npx` cache copy that is older than the checked-out source.

Build and use the repository-local entrypoint:

```bash
npm ci
npm run build
npm run aeh -- start
# equivalent: node dist/main.js start
```

AEH detects when an external/global/npm-exec runtime tries to start a lead for an `agentic-engineering-harness` checkout and re-enters that checkout's `dist/main.js`. If the local build is missing, startup fails closed with build instructions instead of creating a potentially stale lead.

Every managed start prints the executing `aehRuntime` and `aehEntry`. Lead state also records the exact AEH version/invocation, and `--resume` rejects a lead created by a different runtime identity.

Consumer repositories should continue to pin AEH as a dev dependency and use their project-local `npm exec aeh -- ...` binary normally.

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

Before the agent topology is loaded, `aeh start` reconciles managed `.harness` assets. The lead is resolved from the active agent topology, Paseo and the configured lead runtime are reconciled, the daemon is started/recovered, and the lead is created through the Paseo SDK with its bootstrap as `systemPrompt`.

When `orchestration.interactive.usePaseoTools` is enabled, AEH also injects an exact local `aeh-control` MCP server into the managed lead. The server runs through the same Node executable and packaged `aeh` entrypoint that created the lead and preapproves only these bounded controller tools:

```text
aeh_operation_start_audit
aeh_operation_start_run
aeh_operation_status
aeh_operation_cancel
```

This lets the lead control long Harness workflows without sitting inside a blocking shell command. If the MCP cannot be represented safely, the short `aeh operation ...` CLI surface remains available.

### Lead responsibilities

The lead owns:

- user intent and explicit product decisions;
- high-level routing and true ambiguity;
- deterministic state transitions;
- final semantic acceptance.

For managed conversational turns, routing is emitted as a typed,
versioned `IntentDecisionV1`. The lead owns the meaning of the human request;
AEH validates the decision's structure and effects, then enforces the
TaskContract, permissions, capabilities, validators, lifecycle, provenance and
delivery gates. AEH does not run a second regex/keyword interpretation of the
original sentence. The heuristic intent classifier remains available only for
the explicit diagnostic/evaluation command and configured legacy fallback.

It delegates:

```text
explorer              -> repository discovery
environment-manager   -> doctor/setup/Paseo/toolchain recovery
planner               -> read-only decomposition and triage evidence
spec-manager          -> OpenSpec SPEC authoring
implementers          -> code changes
validators/reviewers  -> evidence and quality assessment
```

Paseo native/MCP tools are preferred for bounded conversational delegation and `/paseo-handoff`. Deterministic multi-agent workflows use the AEH operation controller. The controller itself is **not** represented as an LLM agent.

## Detached operations

Interactive AUDIT/RUN work starts detached:

```bash
aeh operation start audit "review the repo and validate the code for improvements"
aeh operation start run TASK-123
```

The start command returns promptly with a durable operation id. State is persisted under:

```text
.harness/operations/<operation-id>.json
```

Observe or control it with:

```bash
aeh operation status <operation-id>
aeh operation wait <operation-id> --timeout 1800
aeh operation cancel <operation-id>
aeh paseo agents --operation <operation-id>
aeh paseo agents --operation <operation-id> --phase review
```

Synchronous `aeh audit` and `aeh run` remain valid non-interactive/compatibility entrypoints. Inside a managed Paseo lead, AEH treats accidental synchronous `aeh audit` and standard `aeh run <taskId>` calls as compatibility syntax and **auto-promotes them to detached operations**. Complex synchronous shortcuts fail closed unless `AEH_ALLOW_SYNC_INTERACTIVE=1` is explicitly set for a bounded compatibility/recovery flow.

For each detached operation AEH attempts to create a **local Paseo workspace** pointing at the existing repository. This is UI/execution grouping only; it does not create a Git branch/worktree. A delivery worktree workspace, when configured, remains a separate concern and takes precedence for implementation agents.

## Visible Paseo agent lifecycle

Real Harness LLM participants use a split lifecycle:

```text
materialize -> dispatch -> wait
```

This is especially useful for AUDIT. AEH first materializes the selected read-only reviewers so they appear immediately in Paseo, then runs deterministic validators, and only then dispatches the reviewers with the completed validator evidence.

Agents carry durable correlation labels:

```text
aeh.project=<project>
aeh.kind=lead|worker
aeh.role=<logical-agent>
aeh.task=<task-id>
aeh.operation=<operation-id>
aeh.operation.kind=audit|run|quick|...
aeh.operation.phase=planning|review|implementation|diagnosis|...
aeh.workspace.kind=orchestration|delivery
```

Managed leads additionally carry `aeh.version=<runtime-version>` and `aeh.bootstrap=<bootstrap-version>`, making stale-session/runtime mismatches visible in Paseo metadata.

Workers remain top-level Paseo agents rather than children owned by one lead conversation, so lead context rotation cannot terminate their workflow ownership.

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

The artifact carries prior/new lead IDs and durable branch/run/audit/operation/delivery references. Detached operations and their independent workers continue across lead rotation.

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

Repository-wide audits are not forced into fake QUICK scope.

## OpenSpec-backed SPEC authoring

For SPEC work the lead does **not** write proposal/spec/design/tasks itself. It delegates to `spec-manager`.

```bash
aeh spec prepare READABILITY-001 --title "Improve readability"
# spec-manager authors/validates OpenSpec artifacts
aeh spec compile READABILITY-001 --title "Improve readability"
aeh sdd validate READABILITY-001
aeh seal READABILITY-001
aeh operation start run READABILITY-001
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
# synchronous compatibility shortcut
aeh run --issue 142
```

An issue is frozen as input, converted into QUICK/SPEC artifacts, sealed, and executed through the same worker/validation/review lifecycle. `ISSUE_DRIFT` prevents silent reinterpretation after intake. Interactive leads use a detached `operation start run` once the derived task is ready.

## AUDIT

Interactive:

```bash
aeh operation start audit "review the repo and validate the code for improvements"
```

Synchronous compatibility:

```bash
aeh audit "review the repo and validate the code for improvements"
```

AUDIT is read-only but Harness-governed:

- frozen control plane;
- visible read-only Paseo reviewers materialized before validation;
- deterministic validators;
- explicit environment/sandbox/assertion/tool failure classification;
- reviewer dispatch with validator evidence;
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

## Build and distribution hygiene

`dist/` is disposable repository state and a required npm artifact. Every `npm run build` deletes `dist` before TypeScript compilation, and npm `prepare` rebuilds it during local `npm ci`/packaging. This prevents stale generated JavaScript from surviving source updates.

AEH is a development tool, not an application runtime dependency. The npm package contains CLI code, templates, presets, policies, schemas, skills and docs. CI validates `npm ci`, typecheck, tests, clean build, `npm pack --dry-run`, the operation MCP surface, and installs the generated tarball into an empty consumer project for smoke testing.

Pushes to `main` can publish automatically through `.github/workflows/publish.yml`. `package.json` is the version source; if its current version has already shipped, Conventional Commit semantics select the next patch/minor/major version before publication. See [docs/PUBLISHING.md](docs/PUBLISHING.md) for authentication, retry and manual-release controls.

## License

Apache-2.0.
