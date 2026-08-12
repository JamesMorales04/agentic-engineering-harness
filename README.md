# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS control layer** for spec-driven multi-agent software engineering where LLM output is treated as untrusted until deterministic gates accept it.

```text
Human -> Codex/lead -> SDD + Gherkin -> sealed TaskContract
      -> worker (Paseo -> OpenCode, or Podman -> OpenCode)
      -> deterministic validators -> finite repair loop -> lead review
      -> evals + telemetry + provenance
```

## Status: v0.3.0

v0.3 includes the complete v0.2 execution path plus measurement and provenance:

- requirement traceability across proposal/spec/design/tasks/Gherkin/TaskContract;
- SHA-256 sealing of normative inputs;
- Paseo/OpenCode and Podman/OpenCode worker execution;
- finite deterministic repair loops;
- Graphify, OPA, Reqnroll, OpenAPI, Opengrep, Trivy, Playwright and contract gates;
- mutation/property-test adapters;
- frozen historical engineering evals with variant ranking;
- first-pass, repair, intervention, duration, token and cost metrics;
- OTLP/HTTP JSON telemetry export plus local NDJSON audit trail;
- provider-neutral Engram/Cognee/Graphiti memory benchmarking;
- CycloneDX SBOM, SLSA v1/in-toto provenance and optional Cosign signing;
- gated npm release workflow with provenance.

See [docs/V0.2.md](docs/V0.2.md) and [docs/V0.3.md](docs/V0.3.md).

## Development

```bash
npm install
npm run check
npm run build
```

## Consumer bootstrap

```bash
aeh init /path/to/repo
cd /path/to/repo
aeh doctor
```

## Core workflow

```bash
aeh sdd new CHANGE-142 --title "Add observable behavior"
aeh sdd validate CHANGE-142
aeh run CHANGE-142
```

`aeh run` validates traceability, seals the contract/SDD inputs, snapshots structural intelligence when configured, launches the worker, validates the actual diff, emits structured repair packets for deterministic failures and stops after the configured repair budget.

## Evals

```bash
aeh eval run EVAL-001 --variant model-a
aeh eval run EVAL-001 --variant model-b
aeh eval compare EVAL-001
```

An eval runs from a frozen Git `baseRef` in an ephemeral worktree. It can overlay a fixture and setup commands, then scores deterministic success, first-pass success, repairs, human interventions and cost. This makes prompt/model/memory/SDD changes comparable on the same historical task.

## Memory benchmark

Configure command adapters for any memory backends:

```yaml
memory:
  benchmark:
    providers:
      - name: engram
        command: engram-search-wrapper {query}
      - name: cognee
        command: cognee-search-wrapper {query}
      - name: graphiti
        command: graphiti-search-wrapper {query}
```

Then run:

```bash
aeh memory-benchmark
```

All providers receive the same cases and are ranked on expected-term recall, stale-answer contamination and latency. Memory remains advisory; Git/specs/tests remain authoritative.

## OpenTelemetry

Local telemetry is always available through `.harness/telemetry/events.ndjson` unless disabled. For an OSS Collector:

```yaml
telemetry:
  enabled: true
  exporter: otlp-http-json
  endpoint: http://localhost:4318
```

`aeh init` installs `.harness/otel-collector.yaml`. Standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, header and service-name environment variables are also honored.

## Provenance

```bash
npm pack
aeh provenance generate --artifact agentic-engineering-harness-0.3.0.tgz
```

This creates a SLSA v1 predicate and in-toto Statement v1 bound to the artifact SHA-256. If Trivy exists, a CycloneDX SBOM is generated. Add `--task CHANGE-142` to bind run/report hashes, and `--sign` to create a Sigstore bundle with `cosign sign-blob`.

## Validator adapters

`gherkin`, `graphify`, `opengrep`, `trivy`, `playwright`, `openapi`, `pact`, `mutation`, `property`, and generic `command` validators all normalize into the same `ValidationCheck` contract.

## Trust model

- Human/lead owns product intent and architecture.
- Git-versioned SDD and TaskContracts define normative truth.
- Workers cannot redefine frozen acceptance criteria.
- Deterministic evidence outranks agent summaries.
- Graphify describes current structure, not desired architecture.
- Memory informs but never authorizes.
- Evals measure the harness itself rather than assuming every new component improves it.
- Provenance binds produced artifacts to source/build evidence.

## License

Apache-2.0.
