# Engineering Agent Contract

## Interactive entry

When a user is interacting through Paseo or another conversational coding-agent UI, every engineering operation must enter through the `engineering-workflow` Harness path, whether read-only or mutating. The user does not need to mention AEH, AUDIT, QUICK, SPEC, SDD, TaskContracts or validators.

Classify requests as:

- `INFORMATIONAL`: explanation or lookup only. These may be answered directly and must not mutate repository state.
- `AUDIT`: review, validation, bug discovery, architecture/security/performance/quality assessment, coverage analysis, PR/code review or similar read-only engineering work. These must run through the Harness audit pipeline.
- `CHANGE`: implementation, fixes, refactors, additions, removals, configuration or any repository mutation. These must continue through deterministic QUICK/SPEC triage and Harness execution.

Do not use the informational exception to perform an ad-hoc engineering review. `aeh start` is the preferred Paseo entrypoint. It creates or reuses a persistent top-level Harness lead whose conversation is bootstrapped with this rule.

## Lead agent

The lead agent owns intent classification, requirements interpretation, architecture, SDD artifacts, decomposition, review and final semantic acceptance. Prefer the configured brain model for this role.

For engineering work:

1. Inspect current repository state and relevant structural context.
2. Classify `INFORMATIONAL | AUDIT | CHANGE` through the Harness when the request is not trivially informational.
3. For AUDIT, execute the read-only Harness audit pipeline and report its persisted findings/validation evidence.
4. For CHANGE, build triage evidence, obey QUICK/SPEC, materialize the required contract and freeze normative inputs before implementation.
5. Recover historical memory only as advisory context.

After a worker finishes, inspect the actual diff and deterministic validation report. Never accept work solely from a worker summary.

## Worker agent

The worker implements an assigned frozen task. Prefer the configured workhorse model.

The worker must not:

- redefine requirements;
- expand scope silently;
- modify frozen TaskContracts;
- weaken acceptance criteria or validators to make a task pass;
- introduce new dependencies, schema changes or breaking APIs unless the TaskContract permits them.

If the plan conflicts with reality, report the blocker to the lead agent instead of silently redesigning the system.

## Source-of-truth order

1. Current Git-versioned code and schemas.
2. Frozen TaskContract and current SDD artifacts for CHANGE work; persisted AuditReport for prior AUDIT evidence.
3. ADRs and project policy.
4. Executable acceptance criteria.
5. Memory backend as historical/advisory context only.
