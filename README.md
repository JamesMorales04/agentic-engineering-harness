# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control layer** for spec-driven multi-agent software engineering where LLM output is treated as untrusted until deterministic gates accept it.

```text
Human -> lead/planner -> SDD + Gherkin -> sealed TaskContract
      -> declarative agent routing -> runtime/model/native-agent
      -> deterministic validators -> typed recovery loop -> lead review
      -> evals + telemetry + provenance
```

## Status: v0.4.8

v0.4 adds a declarative **Agent Topology** on top of the v0.1–v0.3 validation, execution, measurement and provenance stack.

- logical agents are independent from runtimes and models;
- model aliases (`@brain`, `@workhorse`) make provider/model changes centralized;
- JSONC profiles can switch cost/quality policies without editing prompts;
- routing rules select implementers/reviewers/validators from task intent/domain/files/risk;
- agent output contracts are machine-validated;
- recovery uses canonical failure types and versioned policies;
- prompt/skill/config/generated-runtime drift is audited;
- permissions/capabilities are checked before execution;
- Graphify snapshots can make parallel scheduling more conservative;
- reviewer findings are normalized and deduplicated before remediation.

See [docs/V0.4.md](docs/V0.4.md).

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
    "native-opencode-worker": {
      "role": "implementer",
      "execution": {
        "model": "@workhorse",
        "transport": "direct",
        "nativeAgent": "build"
      }
    }
  }
}
```

`runtime` answers **which CLI executes**, `model` answers **which model**, the logical agent answers **which engineering role**, and `nativeAgent` optionally selects an agent inside a runtime such as OpenCode.

OpenCode native-agent selection is guaranteed through `direct`/`podman`, which execute `opencode run --agent`. Paseo remains the preferred cross-provider/session control plane when only provider/model selection is required. A custom Paseo provider can opt into `nativeAgentViaPaseo` if it explicitly supports that mapping.

## Agent topology commands

```bash
aeh agents compile
aeh agents check
aeh agents list
aeh agents profiles
aeh agents show implementation-worker
aeh agents route --intent implement --domain backend security
aeh agents validate-output backend-reviewer --file reviewer.json
aeh agents parallelism CHANGE-142 --plan planner-output.json
aeh agents dedupe-findings --input review-a.json review-b.json --out .harness/findings/CHANGE-142.json
```

Profiles can be selected per run without rewriting the source topology:

```bash
aeh run CHANGE-142 --profile economy
aeh run CHANGE-142 --profile balanced
aeh run CHANGE-142 --profile maximum-quality
```

## Core workflow

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

The resolved agent/runtime/model/profile is persisted in `.harness/runs/<task>.json` and telemetry so v0.3 evals can compare topologies reproducibly.

## Existing capabilities

The Harness still includes requirement traceability, SHA-256 sealing, Paseo/OpenCode and Podman execution, Reqnroll/Gherkin, Graphify, OPA, OpenAPI, Opengrep, Trivy, Playwright/Pact adapters, finite repair loops, engineering evals, OTLP telemetry, memory benchmarks and SLSA/in-toto/Cosign provenance.

## Trust model

- Human/lead owns intent and architecture.
- Git/SDD/TaskContracts define normative truth.
- Agent topology defines who may act, through which runtime/model and with which capabilities.
- Workers do not own acceptance criteria.
- Deterministic evidence outranks agent summaries.
- Memory informs but never authorizes.
- Graphify informs structural impact/parallelism; it does not define desired architecture.
- Agent-generated findings and plans must satisfy machine-readable contracts before downstream use.

## License

Apache-2.0.
