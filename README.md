# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control layer** for spec-driven, issue-driven and bounded-quick multi-agent software engineering where LLM output is treated as untrusted until deterministic and quality gates accept it.

```text
clone / npm bootstrap
      -> aeh setup -> locked engineering toolchain
      -> natural-language request / GitHub issue
      -> lead / issue intake / triage
      -> QUICK or SDD + Gherkin -> sealed contract
      -> optional GitHub branch + Paseo worktree handoff
      -> declarative agent routing -> runtime/model/selective MCPs
      -> deterministic validators -> autonomous quality convergence
      -> lead acceptance -> deterministic delivery
```

## Status: v0.4.16

v0.4.16 adds **declarative toolchain provisioning and one-command bootstrap** on top of v0.4.15 issue-driven execution.

- AEH remains a normal npm development package; it is not an application runtime dependency;
- `.harness/toolchain.yaml` declares external engineering tools instead of requiring manual one-by-one installation;
- `aeh setup` resolves the tools actually required by the current project and provisions them through mise;
- `.harness/toolchain.lock.json` freezes resolved tool versions and OCI digests;
- `.harness/toolchain.state.json` stores machine-local bin paths and is not committed;
- heavy validators may use local tooling or OCI/Podman through `prefer-container`;
- project lockfiles are installed with frozen/reproducible commands (`npm ci`, pnpm/yarn/bun lock modes, `uv sync --frozen`, `dotnet restore`);
- provisioned binaries are injected into Harness subprocess PATH without requiring `mise activate`;
- `aeh doctor` verifies the reconciled environment;
- no npm `postinstall` silently mutates the host.

See [docs/V0.4.16.md](docs/V0.4.16.md), [docs/V0.4.15.md](docs/V0.4.15.md) and the earlier v0.4 documentation.

## Recommended installation

AEH should be pinned as a project development dependency:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
npm exec aeh -- doctor
```

For an existing clone that does not yet have `node_modules`, bootstrap a pinned AEH package explicitly:

```bash
npm exec --yes --package=agentic-engineering-harness@0.4.16 -- aeh setup
```

`aeh setup` is the explicit provisioning boundary. Installing the npm package itself does not install Codex, OpenCode, Paseo, scanners or system packages as a side effect.

## Toolchain bootstrap

Every initialized project receives `.harness/toolchain.yaml`.

Default capabilities cover the common Harness stack:

```text
host/system:  git, optional podman
managed:      node, bun, dotnet, codex, opencode, paseo,
              uv, graphify, opa, opengrep, trivy
OCI optional: OPA, Trivy
```

Auto mode selects only what the project needs. For example:

```text
runtime:codex               -> codex
runtime:opencode            -> opencode
orchestration:paseo         -> paseo
code-intelligence:graphify  -> uv + graphify
validation:opa              -> opa
security-tool:opengrep      -> opengrep
validator:trivy             -> trivy
project:dotnet              -> dotnet
project:bun                 -> bun
```

Useful commands:

```bash
aeh toolchain show
aeh setup --dry-run
aeh setup
aeh setup --update-lock
aeh setup --prefer-containers
aeh setup --profile agents
aeh setup --profile validation
aeh setup --profile full
aeh doctor
```

`--dry-run` is side-effect free. Existing locks are reused by default; `--update-lock` is the deliberate toolchain-upgrade operation.

The source/lock/state split is:

```text
.harness/toolchain.yaml           desired configuration, committed
.harness/toolchain.lock.json      resolved versions/digests, committed
.harness/toolchain.state.json     local absolute bin paths, gitignored
.config/mise/conf.d/aeh.toml      generated mise layer
.harness/bin/                     generated OCI command wrappers, gitignored
```

Existing project version authority is respected before creating a new lock, including `.node-version` / `.nvmrc`, .NET `global.json`, and a pinned Bun `packageManager` declaration.

## Bootstrap without an existing `.harness`

```bash
npm exec --yes --package=agentic-engineering-harness@0.4.16 -- aeh init --setup /path/to/repo
```

`aeh init` creates the project config, thin agent overlay extending `aeh:default`, reusable skills, policies and toolchain source. `--setup` additionally compiles and reconciles the toolchain.

## Issue-driven workflow

Once the environment is ready, an existing issue can be implemented directly:

```bash
aeh issue inspect 142
aeh issue import 142
aeh issue implement 142
# equivalent
aeh run --issue 142
```

A lead using the `engineering-workflow` skill should route natural language such as **“implement issue #142”** directly through this workflow, including when started from Paseo mobile.

The issue pipeline is:

```text
GitHub issue #142
      -> fetch + freeze title/body + SHA-256
      -> scope/domains/risk/acceptance
      -> bounded low-risk -> QuickContract
         OR non-trivial -> read-only planner -> SDD/TaskContract
      -> deterministic validation + seal
      -> reuse existing issue + branch/worktree
      -> implementation + validation + review convergence
      -> lead acceptance
      -> optional deterministic commit/push/draft PR
```

Before every issue-derived run, title/body are re-fetched. A changed fingerprint produces `ISSUE_DRIFT`; the active sealed contract is never silently reinterpreted.

## Default agent pack

**Control/discovery:** `lead`, `planner`, `oracle`, `explorer`, `librarian`.

**Coordination/design:** `github-manager`, `designer`.

**Implementation:** `implementation-worker`, `backend-implementer`, `frontend-implementer`, `data-implementer`, `mobile-implementer`, `test-implementer`, `docs-implementer`, `ops-implementer`, `quality-implementer`, `senior-implementer`.

**Review:** `code-quality-reviewer`, `requirements-reviewer`, `architecture-reviewer`, `security-reviewer`, `api-reviewer`, plus backend/frontend/data/mobile/test/docs/ops reviewers.

**Validation:** `validator`, `integration-validator`, `e2e-validator`.

Unused agents incur no execution cost.

## Compose, add, override or remove agents

```jsonc
{
  "version": 1,
  "extends": ["aeh:default"],
  "agents": {
    "payments-implementer": {
      "role": "implementer",
      "domains": ["payments"],
      "execution": { "model": "@workhorse" },
      "permissions": { "read": "allow", "write": "allow", "shell": "allow" },
      "outputContract": "implementer"
    }
  },
  "remove": { "agents": ["mobile-*"] }
}
```

Local agent/model/runtime/profile definitions partially override inherited definitions. Routing rules are keyed by `id`; inherited agents may be removed with minimatch patterns and stale routing/recovery/council references are cleaned automatically.

## Brain + workhorse

```jsonc
{
  "models": {
    "brain": {
      "runtime": "codex",
      "provider": "openai",
      "model": "gpt-5.6-luna",
      "variant": "max"
    },
    "workhorse": {
      "runtime": "opencode",
      "provider": "opencode-go",
      "model": "deepseek-v4-flash"
    }
  }
}
```

Logical agent, runtime, model and transport remain separate concepts.

## Selective MCPs

Project MCPs live in `.harness/project.yaml`; each logical agent lists only the MCP names it needs. The default catalog includes Context7, Playwright, a read-only GitHub MCP and disabled Sentry integration.

For OpenCode direct/Podman sessions, AEH materializes only the selected MCP definitions into the runtime configuration and suppresses unrelated MCP tool namespaces. GitHub delivery writes remain deterministic Harness operations rather than write-capable LLM MCP access.

## Reusable skills

The default pack includes `engineering-workflow`, `lead-engineer`, `implementation-worker`, `deterministic-validation`, `memory-hygiene`, `sdd`, `verification-planning`, `worktree-lifecycle`, `routing-normalizer`, `recovery-classifier`, `acceptance-traceability`, `finding-dedup`, `prompt-drift-audit`, `simplify` and `github-delivery-lifecycle`.

Framework-specific skills belong in project overlays.

## Optional GitHub -> Paseo delivery

Remote delivery is disabled by default while read-only issue intake is enabled.

```yaml
delivery:
  github:
    enabled: true
    tokenEnv: GH_TOKEN
    branchPattern: feature/gh-{issue}-{slug}
    finalizeOnAcceptance: true
    pullRequestDraft: true
  paseo:
    enabled: true
    createWorkspace: true
    autoUseWorkspace: true
```

The control checkout owns configuration, sealed artifacts, telemetry and delivery state. The Paseo worktree owns code, Git diff, builds, tests, Graphify, remediation and reviews. Accepted issue work may be committed/pushed and linked to a draft PR only after the configured deterministic/quality/lead gates pass.

## QUICK workflow

```bash
aeh triage "Change button padding" --file src/Button.tsx --domain frontend --risk low
aeh quick new QUICK-001 --title "Adjust padding" --request "Change button padding" --scope src/Button.tsx --acceptance "Button uses 16px padding" --domain frontend
aeh quick validate QUICK-001
aeh run QUICK-001
```

QUICK requires concrete bounded file paths; wildcard/repository-wide scope cannot bypass SDD.

## Quality convergence

```text
critical = 300 DebtPoints = DebtScore 100
high     =  75 DebtPoints = DebtScore 25
medium   =  24 DebtPoints = DebtScore 8
low      =   3 DebtPoints = DebtScore 1
note     =   1 DebtPoint  = DebtScore 1/3
```

Final acceptance requires critical/high/medium = 0, low <= 3 and DebtScore <= 3. Review remediation has no arbitrary round limit; stagnation, regression and cycles trigger rollback, stronger agents/models, diagnosis and autonomous replanning.

## Trust model

- Human/lead owns intent and genuinely non-derivable product decisions.
- Git/SDD/TaskContract/QuickContract define normative truth.
- The frozen issue snapshot is provenance; remote issue drift cannot silently change an active run.
- `toolchain.yaml` defines desired engineering capabilities; its lock defines resolved executable versions.
- Agent topology defines who may act and with which model/skills/MCPs.
- Workers do not own acceptance criteria or Git delivery authority.
- Deterministic evidence outranks agent summaries.
- The Final Quality Gate outranks reviewer optimism.
- Memory and Graphify inform; neither authorizes desired behavior.
- Human interaction remains an exception path rather than a remediation cadence.

## License

Apache-2.0.
