# OSS-first Technology Map

The default policy is **zero mandatory SaaS and zero mandatory commercial-license dependency for private repositories**.

Reference components:

| Concern | Default | Role |
|---|---|---|
| Agent runtime | Paseo | Cross-provider process/session/mobile control |
| Lead agent | Codex | Requirements, architecture, planning, review |
| Worker | OpenCode | Routine implementation using the configured workhorse model |
| Persistent memory | Engram | Advisory historical memory; adapter is replaceable |
| Code topology | Graphify | Structural graph and future architecture/blast-radius gates |
| Specification | SDD + Git | Versioned normative intent |
| Acceptance | Gherkin + Reqnroll | Executable business behavior for .NET consumers |
| Policy | OPA/Rego | Centralized allow/deny decisions |
| Static/security analysis | Opengrep | OSS rules/dataflow checks |
| Vulnerability/SBOM | Trivy | Dependency, secret, IaC and SBOM scanning |
| Integration dependencies | Testcontainers | Real ephemeral databases/services in tests |
| Web E2E | Playwright | Deterministic browser acceptance and traces |
| Consumer contracts | Pact/OpenAPI checks | API compatibility |
| Worker isolation | Podman rootless | Ephemeral least-privilege execution |
| Telemetry | OpenTelemetry | Portable traces/metrics/log semantics |
| Provenance | Cosign + in-toto | Artifact signing and attestations |
| Harness quality | Engineering eval corpus | Reproducible comparison of system variants |

Do not add a mandatory SaaS because it is convenient. Any hosted integration must be optional behind an interface and have a documented local/OSS path.
