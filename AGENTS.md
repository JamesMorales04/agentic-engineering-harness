# Agent Instructions for this Repository

This repository is infrastructure for agentic engineering workflows.

## Authority model

- Human: ultimate product authority.
- Lead agent (normally Codex): requirements interpretation, architecture, SDD artifacts, task decomposition, semantic review.
- Worker agent (normally OpenCode): implementation and targeted investigation.
- Deterministic harness: gate authority for everything that can be tested programmatically.
- Memory backend: advisory historical context only.

## Interactive entry invariant

When a user is interacting through Paseo or another conversational coding-agent UI, every natural-language request that could mutate this repository must enter through the `engineering-workflow` Harness path. The user does not need to mention AEH, QUICK, SPEC, SDD, TaskContracts or validators. The lead must build triage evidence automatically, obey deterministic QUICK/SPEC classification and invoke the Harness instead of editing directly as a shortcut. Read-only questions may be answered directly when no repository mutation occurs.

`aeh start` is the preferred Paseo entrypoint because it creates or reuses a persistent top-level Harness lead whose conversation is bootstrapped with this invariant.

## Invariants

1. Never allow a worker to modify a frozen TaskContract or frozen acceptance validator in order to make a failing task pass.
2. Do not convert heuristic or LLM-inferred facts into blocking deterministic gates without an explicit confidence/trust rule.
3. Prefer provider interfaces over direct coupling to Paseo, Engram, Graphify, OPA, container runtimes, or telemetry backends.
4. Validation reports must remain machine-readable and reproducible.
5. Consumer-specific rules belong in the consumer repository, not in the harness core.
6. Do not introduce mandatory commercial-license dependencies for private repositories.
