# Operation control contracts

Interactive operation starts use route-specific MCP tools. The tool name fixes the route; the provider JSON Schema and `LeadOperationIntentV1` Zod contract expose only `requestedOutcome`, optional `constraints`, and an explicit `continuation.operationId`. The deterministic controller derives the route effects and the trusted Paseo user-turn identity. The Lead cannot submit controller-owned delivery or lifecycle booleans.

The contracts have separate jobs:

- **Tool schema:** makes malformed caller input invalid before the MCP method runs.
- **CapabilityRegistry:** records which role may receive a capability; `aeh:operation-control` is available only to the interactive Lead when Paseo tools are enabled.
- **Operational skill:** gives the Lead a JIT procedure. It is not the only source of a required field constraint.
- **Controller:** enforces origin, continuation, deadline, economic usage, acceptance, delivery and all final lifecycle/security decisions.

Requested effects remain part of the human request. A request to commit, push or open a PR stays in `request`, `requestedOutcome` or `constraints`; it does not set `effects.deliver`. Delivery requires the intersection of Owner authorization, project delivery policy, controller/action authority and accepted candidate state.

## Operation lineage and boundaries

Each independent trusted Paseo user turn receives its own root operation origin and `rootHardDeadlineAt`. A continuation must name the exact current failed leaf `operationId`; the controller rejects recovery branches from an ancestor, inherits economic usage and the root deadline, increments recovery depth, and retains the parent's authority and Owner boundaries. A same-turn retry or reuse of the same prepared `taskId` cannot silently turn a pending failed chain into a new root.

Recovery budget, retry depth, continuation identity and root deadline are chain-scoped. `orchestration.operations.ownerBoundaryScope` defaults to `CHAIN_SCOPED_BOUNDARY`. A project may explicitly set `PROJECT_OR_OWNER_GLOBAL_BOUNDARY` to make unresolved Owner economic/deadline boundaries global. A normal `FAILED_TASK_CHAIN` or `CANCELLED_TASK_CHAIN` is never promoted into a project-wide lock.

The portfolio projects `leadRelationship`, `lineageRelationship` and `ownerAttention` from durable state. A historical operation owned by another Lead remains visible and can be acknowledged only by that bound Lead; it does not require ACK from a new Lead to start an unrelated Owner turn.

An active record without a frozen policy/origin deadline is projected as `deadlineDisposition: UNFROZEN_UNSUPPORTED` with `deadlineDiagnosticCode: OPERATION_UNSUPPORTED_UNFROZEN_DEADLINE`. The controller does not retrofit today's deadline onto it or treat it as valid active capacity; it remains visible for explicit migration/repair.

MCP operation failures use `OperationToolErrorV1` (`structuredContent.version = 1`) with a stable code, category, optional path/related operation, creation/recovery disposition, Owner requirement, relationship, next actions and skill reference. `CURRENT_OPERATION` identifies a record created by the failing start call; `CONTINUATION_RELEVANT` identifies causal history needed to choose a continuation. Human-readable text accompanies it. Stack traces and raw internal diagnostics are not included.

Only explicit operation lookup tools map a missing file to `OPERATION_NOT_FOUND`. A start-side `ENOENT` remains a controller/runtime failure; if durable request correlation finds that the operation was already persisted, the error is `OPERATION_START_FAILED_AFTER_CREATE` and carries that operation ID. Correlation uses a fresh per-call event UUID in addition to the Lead identity, so a reused JSON-RPC ID cannot match an older request.
