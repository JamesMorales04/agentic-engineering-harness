# Agent Instructions for this Repository

This repository is infrastructure for agentic engineering workflows.

## Authority model

- Human: ultimate product authority and genuine product decisions.
- Lead agent (normally Codex): preserve intent, orchestrate bounded agents, resolve true ambiguity, and perform final semantic acceptance.
- Explorer/planner/spec-manager/environment-manager: bounded discovery, delegation planning, OpenSpec authoring and environment recovery respectively.
- Worker agent (normally OpenCode): implementation and targeted investigation within frozen scope.
- Deterministic Harness: gate authority for everything that can be tested programmatically.
- Memory/Graphify: advisory historical/structural context only.

## Interactive entry invariant

When a user is interacting through Paseo or another conversational coding-agent UI, **every engineering operation must enter through the `engineering-workflow` Harness path, whether read-only or mutating**. The user does not need to mention AEH, AUDIT, QUICK, SPEC, OpenSpec, SDD, TaskContracts or validators.

Classify requests as:

- `INFORMATIONAL`: explanation or lookup only, with no engineering assessment and no repository mutation. These may be answered directly.
- `AUDIT`: review, validation, bug discovery, architecture/security/performance/quality assessment, coverage analysis, PR/code review or similar read-only engineering work. These must run through the Harness audit path.
- `CHANGE`: implementation, fixes, refactors, additions, removals, configuration or any other repository mutation. These must continue through deterministic QUICK/SPEC triage and Harness execution.

Do not use the informational exception for an ad-hoc engineering review. Do not bypass the Harness by editing directly.

## Thin lead invariant

The lead is an orchestrator, not an interactive CI/operator process. It must delegate:

- repository discovery -> `explorer`;
- environment/toolchain/Paseo recovery -> `environment-manager`;
- non-trivial planning/triage evidence -> `planner`;
- SPEC authoring -> `spec-manager` using OpenSpec;
- implementation/validation/review -> Harness-selected agents.

The lead must not spend its context running long npm/git/Paseo diagnosis sequences or writing proposal/spec/design/tasks itself when a bounded specialist can own that operation. Prefer Paseo native/MCP orchestration tools and `/paseo-handoff` for bounded conversational delegation. Long deterministic AUDIT/RUN workflows must use the detached AEH operation controller (`aeh operation start ...`) so the lead remains available; synchronous `aeh audit`/`aeh run` are compatibility paths for non-interactive callers.

The operation controller is deterministic infrastructure, not an LLM agent. Do not create a fake controller agent. Real planner/reviewer/implementer/oracle work should appear as independent top-level Paseo agents correlated by `aeh.operation`, `aeh.task` and `aeh.role` labels. Operation-local Paseo workspaces group sessions without implying a Git delivery branch/worktree.

`aeh start` creates a fresh lead by default. Reuse is explicit with `aeh start --resume`. Around 70% context usage the lead enters pressure mode; at 80% AEH creates a deterministic handoff and rotates to a fresh lead when running inside a managed Paseo session; at 90% continued engineering work in the old lead is forbidden. Durable Git/seal/run/audit/operation/delivery artifacts carry state across the handoff rather than normal chat compaction.

## SPEC authoring invariant

OpenSpec is the preferred authoring source before freeze. `spec-manager` authors and strictly validates the OpenSpec proposal/specs/design/tasks, then `aeh spec compile` generates native AEH proposal/spec/design/tasks/acceptance plus TaskContract and requirement-validator traceability.

After compilation/sealing, the compiled AEH artifacts and seal are normative during implementation. OpenSpec source remains authoring provenance and may not be silently reinterpreted mid-run. OpenSpec apply commands do not own product implementation; AEH does.

## Invariants

1. Never allow a worker to modify a frozen TaskContract or frozen acceptance validator in order to make a failing task pass.
2. Do not convert heuristic or LLM-inferred facts into blocking deterministic gates without an explicit confidence/trust rule.
3. Prefer provider interfaces over direct coupling to Paseo, Engram, Graphify, OPA, container runtimes, or telemetry backends.
4. Validation reports must remain machine-readable and reproducible.
5. Consumer-specific rules belong in the consumer repository, not in the Harness core.
6. Do not introduce mandatory commercial-license dependencies for private repositories.
7. Self-modification is governed by the control-plane snapshot taken at operation/run start; changes to these rules take effect only on a later operation.
