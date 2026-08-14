# Component maturity at current `main`

This matrix records the highest level supported by executable code and tests at
the current revision. The machine-readable source is
[`component-maturity.json`](component-maturity.json). A roadmap checkbox means
that a capability exists; it is not evidence that the capability is
production-grade.

A roadmap checkbox means that a capability exists; it is not evidence that the capability is production-grade.

Levels are cumulative: `DECLARED`, `ADAPTER`, `EXECUTABLE`,
`WORKFLOW_INTEGRATED`, `DOGFOODED`, `EVAL_VALIDATED`, `PRODUCTION_GRADE`.

| Component | Highest evidence | Evidence |
| --- | --- | --- |
| Paseo | WORKFLOW_INTEGRATED | `src/paseo`, Paseo runtime tests |
| Codex CLI | WORKFLOW_INTEGRATED | `src/workers/agentPrompt.ts`, runtime invocation tests |
| OpenCode | WORKFLOW_INTEGRATED | `src/agents/permissions.ts`, direct/Podman/Paseo tests |
| Engram | WORKFLOW_INTEGRATED | `src/core/run.ts`, `src/memory/candidates.ts`, real CLI contract and full-stack fixture |
| Graphify | WORKFLOW_INTEGRATED | provider-owned CLI lifecycle, canonical model, freshness metadata and real CLI contract |
| OpenSpec | WORKFLOW_INTEGRATED | `src/spec`, OpenSpec bridge tests |
| AEH SDD | WORKFLOW_INTEGRATED | `src/core/sdd.ts`, SDD tests |
| TaskContracts | WORKFLOW_INTEGRATED | contract/seal and run tests |
| Gherkin | EXECUTABLE | `.NET` command adapter and validator tests |
| Reqnroll | DECLARED | consumer-project capability; no AEH runtime dependency |
| .NET/xUnit integration | EXECUTABLE | Gherkin/project validation path |
| Testcontainers capability | DECLARED | consumer test capability; detected through project validation |
| Playwright | WORKFLOW_INTEGRATED | normalized browser evidence adapter |
| Pact | ADAPTER | normalized contract evidence adapter; consumer runtime remains external |
| OPA | WORKFLOW_INTEGRATED | typed execution identity and Rego policy path |
| Opengrep | WORKFLOW_INTEGRATED | normalized security findings |
| Trivy | WORKFLOW_INTEGRATED | normalized vulnerability/secret/misconfiguration findings and SBOM |
| Podman | WORKFLOW_INTEGRATED | hardened worker executor and sandbox tests |
| OpenTelemetry | WORKFLOW_INTEGRATED | official SDK provider/context propagation plus local NDJSON |
| Engineering Evals | DOGFOODED | deterministic production-path fixture in `src/evals/fullStack.ts` |
| SBOM | EXECUTABLE | Trivy-backed provenance generation |
| Cosign | EXECUTABLE | optional signing plus verification path |
| in-toto/SLSA | EXECUTABLE | statement/predicate and manifest-chain generation |
| ContextBudgetGateway | WORKFLOW_INTEGRATED | typed fragments in the actual agent prompt path |
| Serena | ADAPTER | provider doctor/MCP projection; local installation is external |
| Headroom | EXECUTABLE | controller-side SDK bridge, real compression contract and full-stack fixture |
| Repository Context Map | WORKFLOW_INTEGRATED | Graphify/filesystem map consumed by prompt preparation |
| `aeh_context_retrieve` | WORKFLOW_INTEGRATED | authorization, path and SHA-256 checks |

The deliberately lower classifications are not failures: they identify where
the Harness supplies a replaceable adapter or consumer capability without
claiming evidence it does not currently own.
