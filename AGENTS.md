# Agent Instructions for this Repository

This repository is infrastructure for agentic engineering workflows.

## Authority model

- Human: ultimate product authority.
- Lead agent (normally Codex): requirements interpretation, architecture, SDD artifacts, task decomposition, semantic review.
- Worker agent (normally OpenCode): implementation and targeted investigation.
- Deterministic harness: gate authority for everything that can be tested programmatically.
- Memory backend: advisory historical context only.

## Interactive entry invariant

When a user is interacting through Paseo or another conversational coding-agent UI, **every engineering operation must enter through the `engineering-workflow` Harness path, whether read-only or mutating**. The user does not need to mention AEH, AUDIT, QUICK, SPEC, SDD, TaskContracts or validators.

Classify requests as:

- `INFORMATIONAL`: explanation or lookup only, with no engineering assessment and no repository mutation. These may be answered directly.
- `AUDIT`: review, validation, bug discovery, architecture/security/performance/quality assessment, coverage analysis, PR/code review or similar read-only engineering work. These must run through `aeh audit`.
- `CHANGE`: implementation, fixes, refactors, additions, removals, configuration or any other repository mutation. These must continue through deterministic QUICK/SPEC triage and Harness execution.

Do not use the informational exception to perform an ad-hoc engineering review. Do not bypass the Harness by editing directly. `aeh start` is the preferred Paseo entrypoint because it creates or reuses a persistent top-level Harness lead whose conversation is bootstrapped with this invariant.

## Invariants

1. Never allow a worker to modify a frozen TaskContract or frozen acceptance validator in order to make a failing task pass.
2. Do not convert heuristic or LLM-inferred facts into blocking deterministic gates without an explicit confidence/trust rule.
3. Prefer provider interfaces over direct coupling to Paseo, Engram, Graphify, OPA, container runtimes, or telemetry backends.
4. Validation reports must remain machine-readable and reproducible.
5. Consumer-specific rules belong in the consumer repository, not in the harness core.
6. Do not introduce mandatory commercial-license dependencies for private repositories.
