# Agentic Engineering Harness

An OSS-first, reusable engineering control layer for **spec-driven, multi-agent software delivery with deterministic gates**.

The harness is designed around one principle:

> **LLMs propose and modify. Deterministic systems decide whether the result is acceptable.**

The reference workflow uses:

- **Paseo** as the multi-agent runtime/control plane.
- **Codex** as lead engineer, planner, reviewer, and semantic authority.
- **OpenCode** with a lower-cost model as implementation workhorse.
- **SDD** artifacts to make intent explicit and versioned.
- **Gherkin/BDD** for executable business acceptance criteria.
- **Engram** as the initial persistent memory backend, behind an adapter.
- **Graphify** as structural code intelligence, behind an adapter.
- **OPA** for policy-as-code.
- Deterministic build/test/security/architecture/diff gates.
- **OpenTelemetry-compatible tracing boundaries** and local engineering evals.

This repository intentionally does **not** hard-code Pawra-specific knowledge. Product-specific policies and requirements stay in each consumer repository.

## Status

`v0.1` is an executable foundation. It provides:

- `engineering-harness init`
- `engineering-harness doctor`
- `engineering-harness sdd new`
- `engineering-harness sdd validate`
- `engineering-harness verify`
- project/task schemas
- reusable policies and presets
- provider abstractions for Paseo, Engram and Graphify
- deterministic diff-scope and frozen-file gates
- command-based validation gates
- machine-readable validation reports
- reusable agent skills
- a Pawra integration example

The integrations are intentionally adapter-based so Engram can later be replaced by Cognee/Graphiti and Graphify can be replaced by another structural intelligence provider without changing the SDD or validation core.

## Quick start

```bash
npm install
npm run build
npm link

cd /path/to/project
engineering-harness init
engineering-harness doctor
```

Create an SDD change:

```bash
engineering-harness sdd new PAWRA-142 --title "Location-scoped membership permissions"
```

After the spec/design/tasks and TaskContract exist, cryptographically freeze the normative artifacts before delegation:

```bash
engineering-harness seal PAWRA-142
```

After implementation:

```bash
engineering-harness verify PAWRA-142
```

The report is written to `.harness/reports/PAWRA-142.json`.

## Trust model

The recommended authority chain is:

```text
Human
  ↓
Codex (semantic / architecture authority)
  ↓
Frozen TaskContract
  ↓
OpenCode worker(s) (implementation only)
  ↓
Deterministic Harness (gate authority)
  ↓
Codex final semantic review
  ↓
Git / CI / release
```

Memory informs decisions but is **never authoritative**. Git-versioned specs, ADRs, contracts, executable acceptance criteria and the current codebase are the sources of truth.

## Repository layout

```text
src/          CLI and core engine
schemas/      machine-readable contracts
presets/      reusable technology presets
policies/     OPA/Rego policy examples
skills/       agent instruction packs
specs/        SDD documentation/templates
examples/     consumer examples, including Pawra
evals/        repeatable engineering benchmark corpus
docs/         architecture and operating model
```

## OSS-first constraint

The project is designed so a private/commercial repository can use the harness without requiring a mandatory commercial-license dependency. SaaS services are optional. Model inference remains external to this project.

## License

Apache-2.0.
