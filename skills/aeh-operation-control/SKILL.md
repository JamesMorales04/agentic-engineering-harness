---
name: aeh-operation-control
purpose: Select and use the managed Lead's durable operation-control tools without taking controller authority.
---

# AEH Operation Control

Use this procedure only as the interactive Lead/Director. The tool name fixes the route. Tool schemas define syntactic requirements; this skill explains procedure. The controller remains final lifecycle and security authority.

## START

- Use `aeh_informational_context` for explanation only; it creates no operation.
- Use `aeh_operation_start_audit` for read-only engineering assessment.
- Use `aeh_operation_start_change` for repository mutation.
- Use `aeh_operation_start_run` only for an already prepared task; include its exact `taskId`.
- Start tools require the original `request` and a version 1 `operationIntent` with `requestedOutcome`; add material user constraints there. Do not send `IntentDecision`, effect booleans, route, source, or user-turn identity. The controller derives route effects and binds the host's current user turn.
- User delivery intent such as commit, push, or PR stays in `request`/`requestedOutcome`/`constraints`. `effects.deliver` is not a Lead input. Delivery authority is the intersection of Owner authorization, project delivery policy, controller/action authority, and acceptance.
- A successful start returns a compact digest. Return idle; do not poll normal progress.

## PORTFOLIO

- Use `aeh_operation_portfolio` for cross-operation choices, never as a progress poll.
- Read each entry's `leadRelationship`, `lineageRelationship`, `ownerAttention`, and `deadlineDisposition`. `OPERATION_UNSUPPORTED_UNFROZEN_DEADLINE` means the legacy active record has no frozen deadline; it is not watchdog-terminalized or counted as valid active capacity and remains visible for migration. `BOUND_OTHER_LEAD` and `UNBOUND_HISTORICAL` do not require this Lead to ACK. A historical unrelated FAILED chain remains evidence but does not block an independent new Owner turn.
- `CONTINUATION_RELEVANT` means the durable causal user-turn identity matches the current request. Continue that chain explicitly.
- An exact prepared `taskId` also identifies the same task across turns; a failed task using that `taskId` requires explicit continuation.

## STATUS

- Use `aeh_operation_digest` after a block, terminal callback, or explicit user status request.
- Use `aeh_operation_status` with `detail=full` only for exceptional diagnosis when the digest/result artifact is insufficient.
- Reading status never acknowledges a revision.

## ACK

- ACK only after consuming the referenced blocked/terminal revision, with `aeh_operation_ack(operationId, revision)`.
- ACK remains bound-Lead-only. If the error says another Lead owns the operation, do not retry ACK; treat it as historical unless the current Owner request explicitly continues that operation.

## CONTINUATION

- A continuation must include `operationIntent.continuation.operationId` for the exact current failed leaf. Do not branch from an earlier failed ancestor or infer a parent from similar text.
- The controller validates the parent, preserves its root hard deadline and inherited economic usage/authority, increments bounded recovery depth, and retains Owner boundaries. A new user turn may explicitly continue the old chain; it does not reset those limits.
- Never omit the parent to turn the same trusted user turn into a fresh root. A genuinely new Owner user turn with no causal reference is an independent root and receives its own deadline.

## RECOVERY

- `INVALID_INTENT_DECISION` / `OPERATION_INPUT_INVALID`: correct the named caller-owned field and retry once; no operation was created.
- `OPERATION_RECOVERY_PARENT_REQUIRED`: if continuing, retry with the exact `continuation.operationId`; if unrelated, verify that the current Owner user turn is distinct and start that request independently.
- `OPERATION_RECOVERY_PARENT_NOT_LEAF`: inspect the compact portfolio and continue from the related current failed leaf, never create a sibling recovery.
- `OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED`: the chain exhausted its inherited allowance; stop and wait for an Owner-authorized resolution.
- `OPERATION_HARD_DEADLINE_NOT_REACHED`: this is a controller/watchdog state error, not permission to retry in a new operation. Stop repeated starts and surface the structured error for controller repair.
- `OPERATION_LEAD_USER_TURN_UNAVAILABLE`: do not invent a turn ID; restore the managed Paseo Lead snapshot, then retry.
- `OPERATION_NOT_FOUND`: returned only by an explicit operation lookup with an unknown `operationId`; check the compact portfolio and correct the ID.
- `OPERATION_START_FAILED_AFTER_CREATE`: the start call failed after persisting an operation. Do not start again; inspect the related operation's digest and recover from durable status.
- `OPERATION_START_FAILED`: the start call failed before an operation was found for this request. Do not retry automatically; surface the controller/runtime failure.
- Follow the structured error's `retryDisposition`, `requiresHuman`, `relatedOperationId`, and `nextActions`. Do not infer recovery from free-text alone.

## OWNER BOUNDARIES

- Failed-chain recovery budget, retry depth, continuation identity, and root deadline are `CHAIN_SCOPED_BOUNDARY`.
- Only an explicit project policy `PROJECT_OR_OWNER_GLOBAL_BOUNDARY` can make configured Owner economic/deadline boundaries block independent operations. A normal FAILED/CANCELLED task chain never becomes a project-wide Owner lock.
- Do not clear, ACK, or rewrite unrelated Owner boundaries. A same-chain boundary blocks that chain; only the configured Owner resolution path can resolve it.

## DELIVERY

- The Lead may preserve requested delivery intent but cannot grant delivery authority.
- The controller checks Owner authorization, project policy, allowed action, and accepted candidate before any external effect. Never make `deliver=true`, a skill instruction, or a requested PR substitute for those gates.

## PROHIBITED ACTIONS

- Do not construct controller-owned booleans, caller-supplied user-turn IDs, or alternate operation origins.
- Do not disguise a failed-chain continuation as a new root, reset its budget/deadline, or bypass its Owner boundary.
- Do not ACK another Lead's revision, weaken acceptance, or treat skill text as authority.
