# Architecture

## Goal

Provide a reusable control layer between LLM coding agents and the source repository so software quality depends on explicit contracts and executable evidence rather than model self-confidence.

## Layers

### 1. Agent control plane

Paseo is the reference adapter. It owns process/session/worktree/mobile control, not product semantics.

### 2. Semantic authority

A lead agent (reference: Codex) owns requirement interpretation, architecture, SDD and review.

Conversational intent is a separate routing boundary. For a managed
conversation, the lead is the only natural-language semantic authority. It
translates each human turn, including negation, referents and follow-ups, into
a compact, versioned `IntentDecisionV1`; the controller never reclassifies the
original sentence after that decision.

```text
human turn -> Paseo lead -> IntentDecisionV1 -> selected AEH route
                                  |                  |
                                  |                  +-> informational / audit / change / run / status / cancel
                                  v
                    durable userTurnId, outcome, referents, constraints
```

The decision is descriptive, not a permission grant. Its contract contains
`version`, `source` (`lead-semantic`, `explicit-cli` or
`heuristic-fallback`), optional `userTurnId`, `intent`, compact
`requestedOutcome`, effect booleans, optional continuation references,
constraints, confidence and resolution state. AEH validates only this typed
contract and its internal effect invariants. Unknown policy claims such as
`skipValidation`, `allowNetwork`, `gitWrite` or `bypassProvenance` are rejected
by strict schema validation.

Explanatory repository questions use a bounded read-only context answer and do
not create lifecycle state. Audit, change and run routes enter their existing
deterministic contracts. The controller remains the authority for TaskContract,
SDD/seal, scope, capabilities, permissions, validators, evidence, lifecycle,
provenance and delivery. The retained `classifyEngineeringIntentHeuristic`
surface is diagnostic/evaluation/fallback infrastructure only; it cannot veto a
lead-selected route.

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

Context capability requirements are scoped to the selected execution contract:
each capability is `REQUIRED`, `OPTIONAL` or `FORBIDDEN`. Runtime and transport
registries describe actual MCP projection surfaces independently of runtime
names. The resolved capability object is reused for pre-materialization
readiness, MCP injection, prompt policy and diagnostics. The coordinator and
operation supervisor forbid repository/semantic/raw context by default, so a
global project requirement cannot leak Serena or raw retrieval into the
supervisory control plane.

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
