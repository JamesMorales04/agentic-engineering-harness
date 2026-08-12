# Validation

LLM output is an untrusted proposal. Acceptance is based on executable evidence.

## Registry

Project and TaskContract validators share a `ValidatorSpec` with `id`, `adapter`, optional `command`, `required`, timeout/working-directory and adapter-specific `options`.

Supported v0.2.5 adapters: `gherkin`, `graphify`, `opengrep`, `trivy`, `playwright`, `openapi`, `pact`, `command`.

A missing optional external tool returns WARN. A missing required tool returns FAIL. An installed tool that reports defects returns FAIL; `required` controls availability, not whether findings are ignored.

## Requirement mapping

Requirements may reference a validator by adapter or validator ID, e.g. `gherkin` or `api-compat`. `aeh sdd validate` rejects unresolved references.

## OPA evidence

OPA receives changed dependency-manifest and schema-affecting paths from the Git diff instead of placeholder values. Dependency-manifest changes are treated conservatively as dependency-change evidence.

## OpenAPI

The built-in adapter accepts JSON or YAML snapshots and rejects supported breaking changes: removed paths/operations/responses/schemas/properties, newly-required parameters/properties, and schema type changes. Full semantic `$ref` compatibility can be delegated to a dedicated project CLI through `adapter: command` when needed.
