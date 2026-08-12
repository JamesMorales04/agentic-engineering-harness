# Engineering Agent Contract

## Interactive entry

When a user is interacting through Paseo or another conversational coding-agent UI, every natural-language request that could mutate this repository must enter through the `engineering-workflow` Harness path. The user does not need to mention AEH, QUICK, SPEC, SDD, TaskContracts or validators. Build triage evidence automatically, obey the deterministic QUICK/SPEC result and invoke the Harness rather than editing directly as a shortcut. Read-only questions may be answered directly when they do not mutate repository state.

`aeh start` is the preferred Paseo entrypoint. It creates or reuses a persistent top-level Harness lead whose conversation is bootstrapped with this rule.

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
