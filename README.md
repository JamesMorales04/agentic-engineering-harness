# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control layer** for spec-driven and bounded-quick multi-agent software engineering where LLM output is treated as untrusted until deterministic and quality gates accept it.

```text
Human -> lead/triage -> QUICK or SDD + Gherkin -> sealed contract
      -> declarative agent routing -> runtime/model/native-agent
      -> deterministic validators -> autonomous quality convergence
      -> lead acceptance -> evals + telemetry + provenance
```

## Status: v0.4.12

v0.4 now covers **Agent Topology, QuickContract triage, automatic reviews and autonomous quality convergence** on top of the v0.1–v0.3 validation, execution, measurement and provenance stack.

- logical agents are independent from runtimes and models;
- model aliases (`@brain`, `@workhorse`) centralize provider/model changes;
- JSONC profiles switch cost/quality policies without editing prompts;
- routing selects implementers/reviewers/validators from intent/domain/files/risk;
- QUICK changes use sealed bounded QuickContracts; larger/riskier changes use SDD;
- reviewer output is machine-validated, normalized and deduplicated;
- the Final Quality Gate requires `critical=0`, `high=0`, `medium=0`, `low<=3`, `DebtScore<=3` by default;
- integer DebtPoints make **3 notes = 1 low** exactly;
- review remediation has no fixed round limit: improvement continues, while stagnation/regression/cycles trigger autonomous escalation and replanning;
- regressing remediations are rolled back to a path-scoped worktree checkpoint;
- human intervention is reserved for spec contradictions, missing product decisions, or unavailable external credentials/permissions;
- prompt/skill/config/generated-runtime drift and execution capabilities are audited;
- Graphify can inform conservative parallel scheduling and structural validation.

See [docs/V0.4.12.md](docs/V0.4.12.md).

## Bootstrap

```bash
npm install
npm run check
npm run build

aeh init /path/to/repo
cd /path/to/repo
aeh agents check
```

`aeh init` creates `.harness/agents.source.jsonc` and compiles `.harness/generated/agents.json`.

## Brain + workhorse configuration

The default template demonstrates the intended separation:

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
  },
  "agents": {
    "planner": {
      "role": "planner",
      "execution": { "model": "@brain" }
    },
    "implementation-worker": {
      "role": "implementer",
      "execution": { "model": "@workhorse" }
    },
    "quality-implementer": {
      "role": "implementer",
      "execution": { "model": "@workhorse" }
    },
    "senior-implementer": {
      "role": "implementer",
      "execution": { "model": "@brain" }
    },
    "oracle": {
      "role": "escalation",
      "execution": { "model": "@brain" }
    }
  }
}
```

`runtime` answers **which CLI executes**, `model` answers **which model**, the logical agent answers **which engineering role**, and `nativeAgent` optionally selects an agent inside a runtime such as OpenCode.

OpenCode native-agent selection is guaranteed through `direct`/`podman`, which execute `opencode run --agent`. Paseo remains the preferred cross-provider/session control plane when provider/model selection and visible child sessions are required. A custom Paseo provider can opt into `nativeAgentViaPaseo` if it explicitly supports that mapping.

## Agent topology commands

```bash
aeh agents compile
aeh agents check
aeh agents list
aeh agents profiles
aeh agents show implementation-worker
aeh agents route --intent implement --domain backend security
aeh agents validate-output architecture-reviewer --file reviewer.json
aeh agents parallelism CHANGE-142 --plan planner-output.json
aeh agents dedupe-findings --input review-a.json review-b.json --out .harness/findings/CHANGE-142.json
```

Profiles can be selected per run without rewriting the source topology:

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

## SDD workflow

```bash
aeh sdd new CHANGE-142 --title "Add observable behavior"
aeh sdd validate CHANGE-142
aeh agents check
aeh run CHANGE-142
```

The TaskContract may add routing hints:

```yaml
routing:
  intent: implement
  domains: [backend, security]
  risk: high
  agent: backend-implementer   # optional explicit override
  reviewers: [security-reviewer]
  profile: maximum-quality     # optional per-task profile
```

The resolved agent/runtime/model/profile and final quality state are persisted in `.harness/runs/<task>.json` and telemetry so engineering evals can compare topologies and convergence reproducibly.

## Quality convergence

Default review debt uses exact integer points:

```text
critical = 300 points = DebtScore 100
high     =  75 points = DebtScore 25
medium   =  24 points = DebtScore 8
low      =   3 points = DebtScore 1
note     =   1 point  = DebtScore 1/3
```

The review lifecycle continues until the Final Quality Gate passes. `maxRemediationRounds` is accepted only for backward-compatible configuration parsing and is ignored by the convergence engine. Stagnation, regression and repeated quality-state sequences trigger stronger agents/models, diagnosis and autonomous implementation replanning rather than routine human approval.

## Existing capabilities

The Harness also includes requirement traceability, SHA-256 sealing, Paseo/OpenCode and Podman execution, Reqnroll/Gherkin, Graphify, OPA, OpenAPI, Opengrep, Trivy, Playwright/Pact adapters, bounded pre-review deterministic repair, engineering evals, OTLP telemetry, memory benchmarks and SLSA/in-toto/Cosign provenance.

## Trust model

- Human/lead owns intent and product/architecture decisions that cannot be derived from authoritative artifacts.
- Git/SDD/TaskContracts/QuickContracts define normative truth.
- Agent topology defines who may act, through which runtime/model and with which capabilities.
- Workers do not own acceptance criteria.
- Deterministic evidence outranks agent summaries.
- The Final Quality Gate outranks reviewer optimism.
- Memory informs but never authorizes.
- Graphify informs structural impact/parallelism; it does not define desired architecture.
- Agent-generated findings and plans must satisfy machine-readable contracts before downstream use.
- Human interaction is an exception path, not a remediation cadence.

## License

Apache-2.0.
