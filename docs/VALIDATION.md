# Validation

LLM output is an untrusted proposal. Acceptance is based on executable evidence.

## Capability registry

The normative unit of validation is a capability. TaskContracts should prefer:

```yaml
verification:
  capabilities:
    - unit-test
    - bdd
    - contract-test
```

The `ValidationCapabilityRegistry` resolves a capability using explicit project
configuration first, deterministic project detection second, and a generic
configured command as fallback. A provider never needs to know whether the
project is Node, Python, JVM, .NET, Go, Rust, Ruby or PHP.

Built-in provider contracts expose `detect`, `doctor`, `plan`, `execute` and
`normalize`:

- `TestExecutionProvider` normalizes project-native test results into
  `TestExecutionResult`.
- `BddExecutionProvider` keeps Gherkin while accepting Cucumber, Behave,
  pytest-bdd, Reqnroll or another compatible runner.
- `IntegrationEnvironmentProvider` owns explicit ephemeral dependency
  lifecycle, readiness, test execution and cleanup.
- `ContractTestingProvider` runs an actual verifier; Pact is the reference
  adapter and a local pact file is sufficient.

Normalized results include provider, command/runtime, status, counts, duration,
failures, source locations, requirement IDs and a bounded raw-artifact
reference. Bulk stdout/stderr is persisted separately and is not placed in the
validation report.

## Validator registry

Project and TaskContract validators share a `ValidatorSpec` with `id`, `adapter`, optional `command`, `required`, timeout/working-directory and adapter-specific `options`.

Supported adapters include `test-execution`, `bdd`/`gherkin`,
`integration-environment`, `contract-test`/`pact`, `graphify`, `opengrep`,
`trivy`, `playwright`, `openapi` and `command`.

A missing optional external tool returns WARN. A missing required tool returns FAIL. An installed tool that reports defects returns FAIL; `required` controls availability, not whether findings are ignored.

## Requirement mapping

Requirements may reference a validator by ID or a capability, e.g.:

```yaml
requirements:
  - id: API-BEHAVIOR
    capabilities: [bdd, contract-test]
```

`aeh sdd validate` rejects unresolved references. Normalized test, BDD and Pact
results are attached to the same `ValidationReport` and
`RequirementEvidenceGraph`.

Integration environment policy is explicit. Providers must declare network
scope, ephemerality and any mounts/credentials; privileged containers, host
networking, unrestricted host mounts and Docker socket access are rejected by
default.

## OPA evidence

OPA receives changed dependency-manifest and schema-affecting paths from the Git diff instead of placeholder values. Dependency-manifest changes are treated conservatively as dependency-change evidence.

## OpenAPI

The built-in adapter accepts JSON or YAML snapshots and rejects supported breaking changes: removed paths/operations/responses/schemas/properties, newly-required parameters/properties, and schema type changes. Full semantic `$ref` compatibility can be delegated to a dedicated project CLI through `adapter: command` when needed.
