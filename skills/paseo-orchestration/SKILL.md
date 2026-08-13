---
name: paseo-orchestration
purpose: Keep AEH leads thin by delegating through Paseo native/MCP tools and orchestration skills instead of ad-hoc shell control.
---

# Paseo orchestration

Use this skill whenever an AEH lead, planner or coordinator delegates work through Paseo.

## Authority boundary

Paseo is authoritative for agent lifecycle, agent snapshots, provider/model availability, context-window usage and generic orchestration tools. AEH is authoritative for engineering policy, SDD/contracts/seals, deterministic validation, detached operation state, quality convergence and acceptance. Do not reimplement Paseo snapshot/provider semantics by scraping CLI output, and do not move AEH acceptance policy into an LLM agent.

## Preferred control surface

When Paseo tools are injected into the current agent, prefer them over shell commands for bounded conversational delegation:

- `create_agent` for a bounded subagent;
- `send_agent_prompt` for follow-up work;
- `get_agent_status` and `get_agent_activity` for compact observation;
- `cancel_agent` / `archive_agent` for lifecycle cleanup;
- `update_agent` / `set_agent_mode` for supported runtime changes.

When the AEH control MCP server (`aeh operation mcp`) is injected, use its tools for deterministic Harness policy/control:

- `aeh_operation_start_audit`;
- `aeh_operation_start_run`;
- `aeh_operation_status`;
- `aeh_operation_cancel`;
- `aeh_context_status`.

`aeh_context_status` reads the current Paseo AgentSnapshot and applies AEH context thresholds. It must be preferred over shell/log parsing. `NO_USAGE_YET` means the provider has not emitted a usage snapshot yet; `USAGE_UNAVAILABLE` means the current provider snapshot lacks the canonical context-window fields. Never invent a percentage from input/output token counters.

These MCP tools call the same persistent detached operation controller/policy code as the CLI. They do not create a controller LLM agent. If the AEH MCP server is not injected, `aeh operation start/status/cancel` and `aeh context guard` are short compatibility surfaces; do not replace them with long synchronous `aeh audit`/`aeh run` from the conversational lead.

## Detached operation completion

Managed AUDIT/RUN operations are callback-driven. When `aeh_operation_start_audit` or `aeh_operation_start_run` succeeds, the deterministic controller durably records the initiating managed lead as the completion target. The lead may end its current conversational turn while reviewers/workers continue independently.

Do **not** repeatedly poll `aeh_operation_status` in the normal path. When the operation reaches `SUCCEEDED`, `FAILED` or `CANCELLED`, AEH sends an `[AEH_OPERATION_COMPLETED]` follow-up to the same lead. Treat that message as an internal continuation of the still-pending user request:

- do not start a duplicate AUDIT/RUN;
- inspect the existing operation record and the durable report/result artifact named by the callback;
- finish the original user-facing request from those durable results;
- use `aeh_operation_status` only for explicit diagnostics, manual inspection, or recovery when callback delivery is known to have failed.

Callback delivery state is persisted separately from the engineering result. A failed callback must never rewrite a successful engineering operation as failed. Relevant integration traces are `harness.paseo.operation.callback.registered`, `.target`, `.sent`, `.failed`, and `.disabled`.

This wake-up mechanism is intentionally independent of Paseo parent/child ownership. AEH reviewers/workers remain top-level agents so a lead rotation does not terminate them.

Load `/paseo` when the exact current Paseo surface is needed. Use `/paseo-handoff` when responsibility, not merely a subtask, should move to a fresh agent. `/paseo-committee` and `/paseo-advisor` are analysis-only escalation tools and must not replace deterministic AEH gates.

## SDK-first lifecycle

AEH should use the public `@getpaseo/client` surface first for semantic operations:

- provider/model preflight before creating agents;
- `agents.ref(id).refetch()` for current snapshots;
- `AgentSnapshot.lastUsage.contextWindowUsedTokens/contextWindowMaxTokens` for context pressure;
- agent subscriptions for event-driven completion, with subscribe-before-refetch race closure;
- provider snapshot/model/diagnostic APIs for early configuration failures.

For a continued/reused agent turn, capture the last assistant response **before** dispatch. An `idle` snapshot is not sufficient proof that the new turn finished: accept it only after a real active-turn transition or assistant output that differs from the pre-dispatch baseline. Metadata-only subscription updates are not turn activity.

The CLI remains a compatibility/parity-gap surface, not a parallel source of truth. Two intentional external-controller CLI uses currently remain for Paseo 0.3.1:

1. operation workspace creation requiring `--isolation local` plus user-visible `--title`, which the public SDK create contract does not yet expose with equivalent parity;
2. external cleanup/stop where the public agent handle does not expose cancel/kill parity required by the deterministic controller.

Do not replace those two bounded uses with internal `DaemonClient` imports. Their use must remain traceable and should disappear when the public SDK reaches parity.

## Visible execution graph

Real planner/reviewer/implementer/oracle sessions should be top-level Paseo agents labeled with their AEH operation/task/role. The deterministic operation controller remains outside the agent graph. Operation-local Paseo workspaces are grouping containers; delivery worktree workspaces are a separate Git-isolation concern.

Use `aeh paseo agents --operation <id>` (or Paseo's corresponding directory/status tools) to observe real participants without scraping terminal output.

## Observability

AEH persists integration decisions under `.harness/telemetry/paseo.ndjson` even when remote OTLP export is disabled. Relevant events include provider preflight, agent snapshot/context source, lifecycle transport, event-driven wait, resumed-turn baseline, detached-operation callback delivery, SDK-to-CLI fallback, intentional workspace CLI use and cleanup CLI use. When normal Harness telemetry is enabled the same events also flow through the standard telemetry/OTLP path.

A trace should answer: which transport was used, which source supplied state, whether a fallback was intentional or exceptional, why it happened, which operation/agent/provider/model was affected, and whether completion notification reached the initiating lead.

## Lead discipline

The lead owns intent, high-level routing, true ambiguity and final semantic acceptance. Delegate:

- repository discovery -> `explorer`;
- environment/toolchain/daemon recovery -> `environment-manager`;
- non-trivial decomposition -> `planner`;
- SPEC authoring -> `spec-manager`;
- implementation/review -> Harness-selected workers/reviewers.

Return compact structured summaries to the lead. Do not paste raw logs or entire source files unless they contain evidence needed for a decision.

## Context pressure

Before broad engineering work and after completed-turn boundaries, use `aeh_context_status` when injected. At the configured handoff threshold, create a deterministic AEH handoff artifact and use `/paseo-handoff` (preferred) or `create_agent` to continue in a fresh lead. Detached operations and their top-level workers remain valid across lead rotation. Do not compact and continue as the normal path when AEH has declared `HANDOFF_REQUIRED` or `HARD_HANDOFF`.
