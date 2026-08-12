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
- [x] traceability matrix and orphan detection
- [x] validator reference resolution
- [x] generated TaskContract

## v0.2.2 — executable Gherkin and validator registry ✅
- [x] adapter-based validator registry
- [x] Reqnroll discovery and tag filtering
- [x] normalized results and OpenAPI compatibility

## v0.2.3 — worker execution ✅
- [x] `aeh run <task>`
- [x] Paseo/OpenCode executor
- [x] Podman/OpenCode executor
- [x] sealed read-only normative artifacts
- [x] Graphify snapshot lifecycle

## v0.2.4 — finite repair loop ✅
- [x] deterministic repair packets
- [x] finite repair budget
- [x] same-session Paseo repairs
- [x] persisted run/repair artifacts

## v0.2.5 — architecture, security, browser and contracts ✅
- [x] Graphify impact gates
- [x] Opengrep and Trivy
- [x] Playwright
- [x] Pact/custom contracts
- [x] OpenAPI compatibility
- [x] real dependency/schema evidence for OPA

## v0.3 — measurement and provenance ✅
- [x] engineering eval runner over frozen historical tasks/base refs
- [x] first-pass success, repair-count, human-intervention, duration and token/cost metrics
- [x] OTLP/HTTP JSON export plus OSS collector configuration
- [x] configurable Engram/Cognee/Graphiti memory-provider benchmark
- [x] mutation/property-testing adapters
- [x] CycloneDX SBOM + Cosign bundle + in-toto/SLSA v1 provenance
- [x] release hardening and gated npm package publishing

## v0.4 — scale and governance
- [ ] eval dashboards and statistical significance across repeated runs
- [ ] graph-derived safe parallelism scheduler
- [ ] policy bundles/versioned organization profiles
- [ ] remote execution queue and distributed workers
- [ ] signed policy/spec provenance and release verification gates
