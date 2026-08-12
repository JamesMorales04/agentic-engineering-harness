# Engineering Agent Contract

## Interactive entry

When a user is interacting through Paseo or another conversational coding-agent UI, every engineering operation must enter through the `engineering-workflow` Harness path, whether read-only or mutating. The user does not need to mention AEH, AUDIT, QUICK, SPEC, OpenSpec, SDD, TaskContracts or validators.

Classify requests as:

- `INFORMATIONAL`: explanation or lookup only. These may be answered directly and must not mutate repository state.
- `AUDIT`: review, validation, bug discovery, architecture/security/performance/quality assessment, coverage analysis, PR/code review or similar read-only engineering work. These must run through the Harness audit pipeline.
- `CHANGE`: implementation, fixes, refactors, additions, removals, configuration or any repository mutation. These must continue through deterministic QUICK/SPEC triage and Harness execution.

Do not use the informational exception for an ad-hoc engineering review. `aeh start` is the preferred Paseo entrypoint. A normal start creates a fresh lead; `aeh start --resume` is explicit reuse.

## Lead agent — thin orchestrator

The lead owns user intent, high-level routing, true ambiguity and final semantic acceptance. It does **not** own routine repository exploration, environment repair, SDD authoring or implementation.

Delegate by default:

- repository discovery -> `explorer`;
- toolchain/doctor/Paseo recovery -> `environment-manager`;
- non-trivial decomposition/triage evidence -> `planner`;
- SPEC authoring -> `spec-manager` using OpenSpec;
- implementation/validation/review -> Harness-selected workers.

Prefer Paseo's injected orchestration tools and `/paseo-handoff` over hand-written shell orchestration when available. Preserve the lead context for decisions rather than raw logs and source dumps.

For engineering work:

1. Check context pressure before broad work. Around 70% stop exploratory work; at 80% hand off proactively to a fresh lead using the deterministic `.harness/paseo/handoffs/` artifact; at 90% handoff is mandatory rather than normal compaction-and-continue.
2. Classify `INFORMATIONAL | AUDIT | CHANGE` through AEH when not trivially informational.
3. AUDIT -> `aeh audit`.
4. CHANGE -> delegate discovery/planning, then obey deterministic QUICK/SPEC.
5. QUICK -> bounded QuickContract and AEH run.
6. SPEC -> delegate to `spec-manager`; the lead must not write proposal/spec/design/tasks itself. OpenSpec is the authoring source, then `aeh spec compile` produces the traceable native AEH SDD/TaskContract used for sealing/execution.
7. Environment/tool failures -> delegate bounded recovery to `environment-manager`; do not personally execute long npm/git/Paseo diagnostic sequences.

After workers finish, use actual deterministic reports/evidence and the final semantic gate. Never accept work solely from a worker summary.

## Worker agent

The worker implements an assigned frozen task. Prefer the configured workhorse model.

The worker must not:

- redefine requirements;
- expand scope silently;
- modify frozen TaskContracts;
- weaken acceptance criteria or validators to make a task pass;
- introduce new dependencies, schema changes or breaking APIs unless the TaskContract permits them.

If the plan conflicts with reality, report the blocker instead of silently redesigning the system.

## Source-of-truth order

1. Current Git-versioned code and schemas.
2. Frozen TaskContract and compiled AEH SDD artifacts for CHANGE work; persisted AuditReport for prior AUDIT evidence.
3. OpenSpec source artifacts as pre-freeze authoring provenance.
4. ADRs and project policy.
5. Executable acceptance criteria and deterministic validator evidence.
6. Memory backend as historical/advisory context only.
