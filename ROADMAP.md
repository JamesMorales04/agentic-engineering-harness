# Roadmap

## v0.1 — foundation ✅

- [x] portable TypeScript CLI
- [x] project bootstrap and technology presets
- [x] TaskContracts and SHA-256 sealing
- [x] basic deterministic build/test/diff gates
- [x] OPA policy scaffolding
- [x] Paseo, Engram and Graphify provider abstractions
- [x] local lifecycle telemetry and OTel API spans
- [x] reusable lead/worker/SDD/validation/memory skills

## v0.2.1 — requirement traceability ✅

- [x] canonical requirement IDs across proposal/spec/design/tasks/Gherkin/TaskContract
- [x] traceability matrix in `aeh sdd validate`
- [x] missing and orphan requirement detection
- [x] validator reference resolution
- [x] `sdd new` generates the initial TaskContract automatically

## v0.2.2 — executable Gherkin and validator registry ✅

- [x] adapter-based validator registry
- [x] automatic Reqnroll project discovery
- [x] Reqnroll tag filtering by task ID
- [x] normalized validation results and custom command override
- [x] built-in OpenAPI backward-compatibility validator

## v0.2.3 — worker execution ✅

- [x] `aeh run <task>` end-to-end command
- [x] Paseo executor spawning OpenCode workers
- [x] provider/model selection through project configuration
- [x] optional direct Podman/OpenCode worker executor
- [x] sealed SDD/contract mounts read-only inside Podman
- [x] Graphify before/after snapshot lifecycle

## v0.2.4 — finite repair loop ✅

- [x] structured repair packets generated exclusively from deterministic failures
- [x] configurable finite repair budget
- [x] same Paseo worker session receives targeted repair prompts
- [x] run and repair artifacts persisted under `.harness/`
- [x] deterministic revalidation after every repair

## v0.2.5 — architecture, security, browser and contracts ✅

- [x] Graphify structural diff, stale-graph detection and impact policy gates
- [x] Opengrep adapter
- [x] Trivy adapter
- [x] Playwright adapter
- [x] Pact/custom contract command adapter
- [x] OpenAPI JSON/YAML compatibility checks
- [x] dependency/schema evidence fed into OPA rather than placeholders

## v0.3 — measurement and provenance

- [ ] engineering eval runner over frozen historical tasks
- [ ] first-pass success, repair-count, human-intervention and token/cost metrics
- [ ] full OpenTelemetry collector/export configuration
- [ ] Engram/Cognee/Graphiti memory-provider benchmark
- [ ] mutation/property-testing adapters
- [ ] SBOM + Cosign + in-toto/SLSA provenance
- [ ] release hardening and package publishing
