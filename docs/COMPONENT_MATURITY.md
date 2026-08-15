# Component maturity at current `main`

This matrix is a human-readable view of the typed inventory in
[`maturity/components.yaml`](../maturity/components.yaml). The inventory is
validated deterministically by `src/maturity/inventory.ts`; arbitrary evidence
strings cannot promote a component.

A roadmap checkbox means that a capability exists; it is not evidence that the
capability is production-grade.

Levels are cumulative: `DECLARED`, `ADAPTER`, `EXECUTABLE`,
`WORKFLOW_INTEGRATED`, `DOGFOODED`, `EVAL_VALIDATED`, `PRODUCTION_GRADE`.

| Component | Highest evidence | Evidence |
| --- | --- | --- |
| Paseo | WORKFLOW_INTEGRATED | `src/paseo`, Paseo runtime tests |
| Codex CLI | WORKFLOW_INTEGRATED | `src/workers/agentPrompt.ts`, runtime invocation tests |
| OpenCode | WORKFLOW_INTEGRATED | `src/agents/permissions.ts`, direct/Podman/Paseo tests |
| Engram | WORKFLOW_INTEGRATED | `src/providers/engram.ts`, memory lifecycle tests |
| Graphify | WORKFLOW_INTEGRATED | canonical provider/model, snapshots and scheduling tests |
| OpenSpec | WORKFLOW_INTEGRATED | `src/spec`, OpenSpec bridge tests |
| AEH SDD | WORKFLOW_INTEGRATED | `src/core/sdd.ts`, SDD tests |
| TaskContracts | WORKFLOW_INTEGRATED | contract/seal and run tests |
| Project-Native Test Execution | WORKFLOW_INTEGRATED | Node/Python provider contract and normalized evidence |
| BDD Execution | WORKFLOW_INTEGRATED | two runner fixtures normalize Gherkin scenarios |
| Integration Environment | EXECUTABLE | explicit lifecycle provider contract; OCI lane is capability-gated |
| Contract Testing / Pact | EXECUTABLE | Pact provider contract and local verifier fixture |
| Gherkin | WORKFLOW_INTEGRATED | runner-neutral BDD provider and scenario evidence |
| Playwright | WORKFLOW_INTEGRATED | normalized browser evidence adapter |
| OPA | WORKFLOW_INTEGRATED | typed execution identity and Rego policy path |
| Opengrep | WORKFLOW_INTEGRATED | normalized security findings |
| Trivy | WORKFLOW_INTEGRATED | normalized vulnerability/secret/misconfiguration findings and SBOM |
| Podman | WORKFLOW_INTEGRATED | hardened worker executor and sandbox tests |
| OpenTelemetry | WORKFLOW_INTEGRATED | coherent operation trace IDs plus local NDJSON |
| Engineering Evals | EVAL_VALIDATED | `src/evals`, `tests/evals.test.ts` |
| SBOM | EXECUTABLE | Trivy-backed provenance generation |
| Cosign | EXECUTABLE | real sign/verify/tamper CI contract with non-production key material |
| in-toto/SLSA | EXECUTABLE | statement/predicate and manifest-chain generation |
| ContextBudgetGateway | WORKFLOW_INTEGRATED | typed fragments in the actual agent prompt path |
| Serena | ADAPTER | provider doctor/MCP projection; local installation is external |
| Headroom | ADAPTER | controller-side compression provider; not exposed as runtime MCP |
| Repository Context Map | WORKFLOW_INTEGRATED | Graphify/filesystem map consumed by prompt preparation |
| `aeh_context_retrieve` | WORKFLOW_INTEGRATED | authorization, path and SHA-256 checks |

The deliberately lower classifications are not failures: they identify where
the Harness supplies a replaceable adapter or consumer capability without
claiming evidence it does not currently own.
