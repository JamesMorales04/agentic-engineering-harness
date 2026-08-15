# OSS-first Technology Map

The default policy is **zero mandatory SaaS and zero mandatory paid-license dependency for private repositories**. A free, locally executable OSS dependency may be mandatory when AEH needs its capability and its license, version lock and supply chain are reviewed.

Reference components:

| Concern | Default | Role |
|---|---|---|
| Agent runtime | Paseo | Cross-provider process/session/mobile control |
| Lead agent | Codex | Requirements, architecture, planning, review |
| Worker | OpenCode | Routine implementation using the configured workhorse model |
| Persistent memory | Engram | Advisory historical memory; adapter is replaceable |
| Code topology | Graphify | Structural graph and future architecture/blast-radius gates |
| Semantic code retrieval | Serena 1.6.1 (`serena-agent`) | Configured local OSS symbol lookup, references and targeted repository navigation; not memory authority |
| Context compression | Headroom 0.28.0 | Configured local OSS selective compression after AEH projection; no hosted Headroom service required |
| Specification | SDD + Git | Versioned normative intent |
| Validation | TestExecutionProvider, BddExecutionProvider, IntegrationEnvironmentProvider | Capability-based project-native validation |
| BDD acceptance | Gherkin | Runner-neutral executable business behavior |
| Policy | OPA/Rego | Centralized allow/deny decisions |
| Static/security analysis | Opengrep | OSS rules/dataflow checks |
| Vulnerability/SBOM | Trivy | Dependency, secret, IaC and SBOM scanning |
| Integration environments | Podman / OCI or project-native provider | Explicit ephemeral dependencies and readiness; Testcontainers is optional |
| Web E2E | Playwright | Deterministic browser acceptance and traces |
| Consumer contracts | ContractTestingProvider / Pact / OpenAPI checks | Local verifier-backed compatibility evidence |
| Worker isolation | Podman rootless | Ephemeral least-privilege execution |
| Telemetry | OpenTelemetry | Portable traces/metrics/log semantics |
| Provenance | Cosign + in-toto | Artifact signing and attestations |
| Harness quality | Engineering eval corpus | Reproducible comparison of system variants |

Runtime notes: Serena is the semantic repository adapter and Engram is the
historical memory adapter; neither is interchangeable with the other. Headroom
is controller-side compression and is intentionally not exposed as a general
agent MCP surface. All three remain optional/configurable where the project
profile permits it, with required providers failing closed.

Do not add a mandatory SaaS or paid-license dependency because it is convenient. Any hosted integration must be optional behind an interface and have a documented local/OSS path. Serena and Headroom are AEH-managed local tools, pinned through the project toolchain; Headroom's agent-wrapping lifecycle is deliberately not used.
