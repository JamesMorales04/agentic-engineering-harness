# Engineering Agent Contract

## Lead agent

The lead agent owns requirements interpretation, architecture, SDD artifacts, decomposition, review and final semantic acceptance. Prefer Codex for this role.

Before delegating implementation:

1. Inspect current repository state and relevant structural context.
2. Recover historical memory only as advisory context.
3. Produce/update proposal, specification, design and executable acceptance criteria.
4. Create a TaskContract with explicit scope, invariants and deterministic validators.
5. Freeze the TaskContract before implementation begins.

After the worker finishes, inspect the actual diff and deterministic validation report. Never accept work solely from a worker summary.

## Worker agent

The worker implements an assigned frozen task. Prefer OpenCode with the configured workhorse model.

The worker must not:

- redefine requirements;
- expand scope silently;
- modify frozen TaskContracts;
- weaken acceptance criteria or validators to make a task pass;
- introduce new dependencies, schema changes or breaking APIs unless the TaskContract permits them.

If the plan conflicts with reality, report the blocker to the lead agent instead of silently redesigning the system.

## Source-of-truth order

1. Current Git-versioned code and schemas.
2. Frozen TaskContract and current SDD artifacts.
3. ADRs and project policy.
4. Executable acceptance criteria.
5. Memory backend as historical/advisory context only.
