# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control layer** for spec-driven, issue-driven and bounded-quick multi-agent software engineering where LLM output is treated as untrusted until deterministic and quality gates accept it.

```text
Natural-language request / GitHub issue
      -> lead / issue intake / triage
      -> QUICK or SDD + Gherkin -> sealed contract
      -> optional GitHub branch + Paseo worktree handoff
      -> declarative agent routing -> runtime/model/selective MCPs
      -> deterministic validators -> autonomous quality convergence
      -> lead acceptance -> evals + telemetry + provenance
```

## Status: v0.4.15

v0.4.15 adds **existing GitHub issues as a first-class execution source** on top of v0.4.14's default agents, selective MCPs and issue/worktree delivery.

- `aeh issue inspect/import/implement <number>` supports issue-native intake;
- `aeh run --issue <number>` is the one-command execution alias;
- an issue's title/body are frozen into a local snapshot with SHA-256 before implementation;
- issue intake deterministically extracts likely scope/domains/risk and uses a read-only planner for non-trivial normalization;
- the Harness materializes either a QuickContract or complete SDD/TaskContract, validates it and seals it;
- the **existing issue is reused**, never recreated by issue-driven handoff;
- issue-linked branches are reused when already present and created otherwise;
- Paseo worktree delivery is reused automatically when enabled;
- every issue-derived run verifies `ISSUE_DRIFT` before delegating work;
- the sealed TaskContract/SDD remain normative during the run; the mutable remote issue remains source provenance;
- `aeh:default` still supplies portable agents, profiles, skills and selective MCP capabilities;
- deterministic evidence and the Final Quality Gate continue to outrank agent optimism.

See [docs/V0.4.15.md](docs/V0.4.15.md), [docs/V0.4.14.md](docs/V0.4.14.md), [docs/V0.4.13.md](docs/V0.4.13.md) and [docs/V0.4.12.md](docs/V0.4.12.md).

## Bootstrap

```bash
npm install
npm run check
npm run build

aeh init /path/to/repo
cd /path/to/repo
aeh agents check
```

A project does **not** need to already contain `.harness/`. `aeh init` creates a thin `.harness/agents.source.jsonc` overlay extending the package-owned `aeh:default`, copies reusable skills into `.harness/skills`, creates runtime directories and compiles `.harness/generated/agents.json`.

## Issue-driven workflow

When the repository has an existing issue, you can start from that issue instead of manually creating an SDD first:

```bash
# Optional inspection only
aeh issue inspect 142

# Freeze and materialize the issue as QUICK or SPEC
aeh issue import 142

# Full intake -> optional branch/worktree -> implementation -> validation -> reviews
aeh issue implement 142

# Equivalent one-command alias
aeh run --issue 142
```

A lead using the `engineering-workflow` skill should route natural language such as **“implement issue #142”** directly to `aeh issue implement 142`, including when the lead was started from Paseo mobile.

### Intake semantics

The issue pipeline is:

```text
GitHub issue #142
      |
      v
fetch + freeze title/body + SHA-256
      |
      v
extract scope/domains/risk/acceptance
      |
      +--> bounded low-risk -> QuickContract
      |
      `--> non-trivial -> read-only planner normalization -> SDD/TaskContract
                                            |
                                            v
                                    deterministic validation
                                            |
                                            v
                                           seal
                                            |
                                            v
                                bind existing issue to delivery
                                            |
                                            v
                                branch/worktree + aeh run
```

The planner may derive implementation detail from repository evidence, but it may not invent a product decision. Genuine missing product decisions become `REQUIRES_PRODUCT_DECISION`; contradictory authoritative intent becomes `SPEC_CONTRADICTION`.

The frozen issue snapshot is stored under `.harness/issues/GH-<number>.json` and referenced by the TaskContract. Issue-derived task IDs use `GH-<number>`.

### Issue drift

For issue-derived work, title/body form the normative remote input and are hashed. Labels/comments may help triage but are not part of the content hash.

Before each run, the Harness re-fetches the issue and compares title/body against the frozen SHA-256:

```text
same hash    -> run normally
changed hash -> ISSUE_DRIFT
```

To explicitly accept a changed issue before implementation:

```bash
aeh issue import 142 --refresh
```

If a Paseo implementation workspace already exists, refresh is guarded and requires explicit `--force` so revised intent cannot silently replace an active implementation contract.

## Default agent pack

**Control/discovery:** `lead`, `planner`, `oracle`, `explorer`, `librarian`.

**Coordination/design:** `github-manager` (read-only GitHub triage), `designer` (read-only UI/UX review).

**Implementation:** `implementation-worker`, `backend-implementer`, `frontend-implementer`, `data-implementer`, `mobile-implementer`, `test-implementer`, `docs-implementer`, `ops-implementer`, `quality-implementer`, `senior-implementer`.

**Review:** `code-quality-reviewer`, `requirements-reviewer`, `architecture-reviewer`, `security-reviewer`, `api-reviewer`, `backend-reviewer`, `frontend-reviewer`, `data-reviewer`, `mobile-reviewer`, `test-reviewer`, `docs-reviewer`, `ops-reviewer`.

**Validation:** `validator`, `integration-validator`, `e2e-validator`.

The OMO-style `fixer` niche is intentionally represented by `quality-implementer`; councils use the Harness `councils` abstraction rather than another ordinary agent. `observer` remains an optional project overlay until a project explicitly configures a multimodal model/input contract. `openspec-manager` is not a default because the Harness already owns SDD/QuickContract normative truth.

Unused agents incur no execution cost.

## Compose, add, override or remove agents

```jsonc
{
  "version": 1,
  "extends": ["aeh:default"],
  "activeProfile": "balanced",
  "models": {},
  "agents": {},
  "routing": [],
  "remove": { "agents": [] }
}
```

Add a project specialist normally:

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
  "routing": [
    {
      "id": "payments",
      "priority": 90,
      "when": { "intent": "implement", "domains": ["payments"] },
      "use": "payments-implementer"
    }
  ]
}
```

Override only what changes:

```jsonc
{
  "version": 1,
  "extends": ["aeh:default"],
  "models": {
    "workhorse": { "provider": "opencode-go", "model": "another-model" }
  },
  "agents": {
    "backend-implementer": {
      "temperature": 0.05,
      "description": "Project-specific backend charter"
    }
  }
}
```

Remove inherited roles using minimatch patterns:

```jsonc
{
  "version": 1,
  "extends": ["aeh:default"],
  "remove": {
    "agents": ["mobile-*", "ops-reviewer"]
  }
}
```

Agent removal cascades through inherited routing/recovery/council references. Routing rules are keyed by `id`, so a local rule with the same `id` replaces the inherited rule. `extends` is ordered and supports relative JSONC layers.

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

`runtime` selects the CLI/runtime, model aliases select inference, logical agents define engineering ownership, and `nativeAgent` optionally selects a runtime-native agent.

## Selective MCPs

Project MCPs live in `.harness/project.yaml`, while each logical agent lists only the MCP names it needs.

Default template catalog:

```yaml
mcp:
  servers:
    context7:
      type: remote
      url: https://mcp.context7.com/mcp
      enabled: true

    playwright:
      type: local
      command: [npx, -y, "@playwright/mcp@0.0.78"]
      enabled: true

    github:
      type: local
      command:
        [podman, run, -i, --rm,
         -e, GITHUB_PERSONAL_ACCESS_TOKEN,
         -e, GITHUB_TOOLSETS,
         -e, GITHUB_READ_ONLY,
         ghcr.io/github/github-mcp-server]
      environment:
        GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_TOKEN}"
        GITHUB_TOOLSETS: repos,issues,pull_requests,actions
        GITHUB_READ_ONLY: "1"
      enabled: true

    sentry:
      type: remote
      url: https://mcp.sentry.dev/mcp
      enabled: false
```

For OpenCode direct/Podman sessions, the Harness materializes only selected MCP definitions into `OPENCODE_CONFIG_CONTENT` and disables the other configured MCP tool namespaces. This prevents browser/GitHub schemas from entering unrelated worker contexts.

The default pack intentionally does **not** require codegraph/codemap MCPs because Graphify is already the Harness structural graph; it also avoids filesystem and security-scanner MCP duplication where native file tools/OpenGrep/Trivy already provide the stronger deterministic surface.

## Reusable skills

The default pack can use these package skills:

`verification-planning`, `worktree-lifecycle`, `routing-normalizer`, `recovery-classifier`, `acceptance-traceability`, `finding-dedup`, `prompt-drift-audit`, `simplify`, `github-delivery-lifecycle`, plus the existing `engineering-workflow`, `lead-engineer`, `implementation-worker`, `deterministic-validation`, `memory-hygiene` and `sdd` skills.

Framework-specific skills belong in project overlays rather than the universal pack.

## Optional SDD / issue -> GitHub -> Paseo delivery

Remote delivery is **disabled by default**, while read-only issue intake is enabled by default.

```yaml
workflow:
  issueIntake:
    enabled: true
    snapshotDir: .harness/issues
    verifyDriftOnRun: true
    requireOpen: true
    plannerAgent: planner
    autoHandoff: true

delivery:
  stateDir: .harness/delivery
  github:
    enabled: true
    tokenEnv: GH_TOKEN
    assignTokenOwner: true
    branchPattern: feature/gh-{issue}-{slug}
  paseo:
    enabled: true
    createWorkspace: true
    autoUseWorkspace: true
    worktreeSlugPattern: gh-{issue}-{slug}
```

For a new local spec:

```bash
aeh sdd new CHANGE-142 --title "Add observable behavior"
# complete proposal/spec/design/tasks/Gherkin + TaskContract

aeh sdd validate CHANGE-142
aeh seal CHANGE-142
aeh sdd handoff CHANGE-142
aeh run CHANGE-142
```

For an existing issue:

```bash
aeh issue implement 142
```

The issue intake seeds the delivery record with issue #142, so handoff cannot create a duplicate issue. If the configured issue branch already exists, the Harness reuses it; otherwise it creates one from the captured originating branch.

With Paseo delivery enabled it creates a managed `worktree` workspace for that branch. Subsequent implementation, review and repair launches reuse that workspace automatically.

The delivery record is resumable:

```text
initialized -> issue-created -> branch-created -> workspace-created -> ready
```

The control checkout owns config/reports/telemetry/delivery state; the worktree owns code/diff/build/tests/Graphify/remediation. Sealed task context is materialized into the worktree before execution.

## Agent topology commands

```bash
aeh agents compile
aeh agents check
aeh agents list
aeh agents profiles
aeh agents show backend-implementer
aeh agents route --intent implement --domain backend security
aeh agents validate-output architecture-reviewer --file reviewer.json
aeh agents parallelism CHANGE-142 --plan planner-output.json
aeh agents dedupe-findings --input review-a.json review-b.json --out .harness/findings/CHANGE-142.json
```

Profiles can be selected per run:

```bash
aeh run CHANGE-142 --profile economy
aeh run CHANGE-142 --profile balanced
aeh run CHANGE-142 --profile maximum-quality
```

## QUICK workflow

```bash
aeh triage "Change button padding" --file src/Button.tsx --domain frontend --risk low
aeh quick new QUICK-001 --title "Adjust padding" --request "Change button padding" --scope src/Button.tsx --acceptance "Button uses 16px padding" --domain frontend
aeh quick validate QUICK-001
aeh run QUICK-001
```

## Quality convergence

Default review debt uses exact integer points:

```text
critical = 300 points = DebtScore 100
high     =  75 points = DebtScore 25
medium   =  24 points = DebtScore 8
low      =   3 points = DebtScore 1
note     =   1 point  = DebtScore 1/3
```

The lifecycle continues until the Final Quality Gate passes. Stagnation, regression and repeated quality-state sequences trigger stronger agents/models, diagnosis and autonomous replanning rather than routine human approval.

## Trust model

- Human/lead owns intent and product decisions that cannot be derived from authoritative artifacts.
- A GitHub issue can be an input source; its frozen snapshot becomes provenance for a sealed QUICK/SDD contract.
- Once frozen, the sealed TaskContract/SDD defines normative truth for the active run; remote issue edits trigger `ISSUE_DRIFT` instead of silently changing intent.
- Agent topology defines who may act, through which runtime/model and with which selected skills/MCPs.
- Built-in defaults are policy inputs, not hidden authority; project layers can replace/remove them.
- Workers do not own acceptance criteria.
- Deterministic evidence outranks agent summaries and MCP observations.
- The Final Quality Gate outranks reviewer optimism.
- Memory informs but never authorizes.
- Graphify informs structural impact/parallelism; it does not define desired architecture.
- Human interaction remains an exception path, not a remediation cadence.

## Existing capabilities

Requirement traceability, SHA-256 sealing, Paseo/OpenCode/Podman execution, Reqnroll/Gherkin, Graphify, OPA, OpenAPI, OpenGrep, Trivy, Playwright/Pact adapters, bounded deterministic repair, engineering evals, OTLP telemetry, memory benchmarks and SLSA/in-toto/Cosign provenance remain available.

## License

Apache-2.0.
