# Agent Instructions for this Repository

This repository is infrastructure for agentic engineering workflows.

## Authority model

- Human: ultimate product authority.
- Lead agent (normally Codex): requirements interpretation, architecture, SDD artifacts, task decomposition, semantic review.
- Worker agent (normally OpenCode): implementation and targeted investigation.
- Deterministic harness: gate authority for everything that can be tested programmatically.
- Memory backend: advisory historical context only.

## Invariants

1. Never allow a worker to modify a frozen TaskContract or frozen acceptance validator in order to make a failing task pass.
2. Do not convert heuristic or LLM-inferred facts into blocking deterministic gates without an explicit confidence/trust rule.
3. Prefer provider interfaces over direct coupling to Paseo, Engram, Graphify, OPA, container runtimes, or telemetry backends.
4. Validation reports must remain machine-readable and reproducible.
5. Consumer-specific rules belong in the consumer repository, not in the harness core.
6. Do not introduce mandatory commercial-license dependencies for private repositories.
