# Architecture

## Goal

Provide a reusable control layer between LLM coding agents and the source repository so software quality depends on explicit contracts and executable evidence rather than model self-confidence.

## Layers

### 1. Agent control plane

Paseo is the reference adapter. It owns process/session/worktree/mobile control, not product semantics.

### 2. Semantic authority

A lead agent (reference: Codex) owns requirement interpretation, architecture, SDD and review.

### 3. Implementation workers

Workers (reference: OpenCode + cost-efficient model) implement frozen, scoped tasks. They have no authority to redefine acceptance.

### 4. Normative truth

Git-versioned specs, ADRs, TaskContracts and executable acceptance criteria define intended behavior.

### 5. Structural truth

Graphify is the first code-intelligence adapter. A canonical AEH graph model
feeds context selection, scheduling, blast-radius evidence and architecture
validation. The provider owns doctor/build/refresh/load/freshness/impact
lifecycle; consumers do not construct Graphify CLI commands. Extracted graph
relationships may support deterministic gates; inferred/ambiguous
relationships should default to warnings until explicitly promoted.

### 6. Historical memory

Engram is the first memory adapter. The interface is deliberately replaceable by Cognee/Graphiti or another backend.

### 7. Validation plane

AEH reasons about validation capabilities, not language ecosystems. The
validation boundary is:

```text
                         Validation Plane
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
    TestExecution       BddExecution       IntegrationEnvironment
       Provider            Provider              Provider
          |                    |                    |
          v                    v                    v
    project-native       Gherkin runner       project-native /
       runner              adapter            OCI environment
          |                    |                    |
          +--------------------+--------------------+
                               |
                               v
                      Validation Evidence
                               |
                               v
                  RequirementEvidenceGraph
```

`ContractTestingProvider` is an independent capability. Pact is the reference
adapter, while project-native Pact DSLs remain optional. Providers expose
`detect`, `doctor`, `plan`, `execute` and `normalize`; normalized results use
the AEH protocol and retain raw process output as a separate artifact.

TaskContracts can declare `verification.capabilities` such as `unit-test`,
`bdd`, `integration-test` and `contract-test`. Deterministic resolution records
the selected provider and command; framework detection can select an adapter but
is not the architecture boundary.

### 7a. Gate authority

The deterministic harness evaluates build/type/lint/tests, scope, immutable files, API/schema policies, architecture, security and other machine-verifiable constraints.

### 7b. Context-efficiency authority

`ContextBudgetGateway` is the single controller-owned path for bounded agent context. It retrieves, classifies, selects, deterministically projects, budgets, selectively compresses and delivers a versioned `ContextEnvelope`. Required `VERBATIM` content is never lossy-compressed or character-truncated. Raw evidence remains in an AEH artifact and is available only through an operation/agent-authorized retrieval gateway.

```text
Graphify  -> macro structural topology and advisory dependency/community signals
Serena    -> micro semantic repository retrieval (symbol, overview, references)
Engram    -> historical memory authority
Headroom  -> local compression of AEH-marked COMPRESSIBLE fragments only
Paseo     -> agent process/session/workspace lifecycle
```

Serena editing is disabled by default. Headroom does not own TaskContracts, OpenSpec/SDD, structured results, control-plane files, OperationRecords or validation.

### Reference stack

```text
CONTROL PLANE   Paseo
AGENTS          Codex CLI, OpenCode
KNOWLEDGE       Engram, Graphify
CONTEXT         Serena, Headroom, RepoMap, ContextBudgetGateway
SPECIFICATION   OpenSpec, AEH SDD, TaskContracts, Gherkin
VALIDATION      TestExecutionProvider, BddExecutionProvider,
                IntegrationEnvironmentProvider, ContractTestingProvider/Pact,
                Playwright, Graphify
POLICY/SECURITY OPA, OpenGrep, Trivy
SANDBOX        Podman / OCI
OBSERVABILITY   OpenTelemetry, Engineering Evals
SUPPLY CHAIN    SBOM, SLSA, in-toto, Cosign
```

Reqnroll, xUnit/`dotnet test`, and Testcontainers are supported compatibility
adapters documented in [VALIDATION_COMPATIBILITY.md](VALIDATION_COMPATIBILITY.md);
none is a core architecture requirement.

### 8. Policy

OPA/Rego centralizes reusable allow/deny decisions instead of spreading policy across shell scripts.

### 9. Isolation

Worker execution should evolve toward an ephemeral rootless Podman sandbox with only the intended workspace writable, validation artifacts read-only, no SSH/private credentials and restricted network access.

### 10. Measurement

Every task should emit machine-readable reports and telemetry. Historical tasks become eval cases to measure harness improvements objectively.
