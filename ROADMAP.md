# Roadmap

## v0.1 — executable foundation

- [x] CLI bootstrap/doctor/verify.
- [x] SDD change scaffolding.
- [x] Gherkin acceptance artifact.
- [x] TaskContract schema and deterministic diff/frozen-path/budget gates.
- [x] SHA-256 sealing of TaskContract + referenced SDD artifacts.
- [x] OPA policy execution scaffold.
- [x] Paseo, Engram and Graphify provider abstractions.
- [x] local lifecycle telemetry and OTel API spans.
- [x] reusable lead/worker/SDD/validation/memory skills.
- [x] Pawra consumer example.

## v0.2 — hard gates and traceability

- [ ] Requirement-ID traceability across proposal/spec/design/Gherkin/tasks/contract/report.
- [ ] Reqnroll adapter and generated acceptance-test command discovery for .NET.
- [ ] Playwright adapter for web acceptance/evidence capture.
- [ ] Pact/OpenAPI compatibility adapters.
- [ ] Graphify before/after architecture snapshots and blast-radius gates.
- [ ] Dependency and schema-change detectors feeding OPA.
- [ ] Opengrep and Trivy first-class validators with SARIF normalization.
- [ ] Rootless Podman worker executor with read-only sealed artifacts.
- [ ] Automatic structured repair packets and finite repair budget.

## v0.3 — measurable engineering platform

- [ ] Eval runner against frozen historical tasks/base commits.
- [ ] Variant comparison: prompts/models/memory/provider/SDD revisions.
- [ ] Full OpenTelemetry SDK/exporter integration and optional OSS dashboard stack.
- [ ] Memory adapter benchmarks: Engram vs Cognee vs Graphiti.
- [ ] Graph-derived safe-parallelism/overlap heuristics.
- [ ] SBOM generation, Cosign signatures and in-toto attestations.
- [ ] Mutation/property/performance gate adapters.
