---
name: paseo-orchestration
purpose: Keep AEH leads thin by delegating through Paseo native/MCP tools and orchestration skills instead of ad-hoc shell control.
---

# Paseo orchestration

Use this skill whenever an AEH lead, planner or coordinator delegates work through Paseo.

## Preferred control surface

When Paseo tools are injected into the current agent, prefer them over shell commands:

- `create_agent` for a bounded subagent;
- `send_agent_prompt` for follow-up work;
- `get_agent_status` and `get_agent_activity` for compact observation;
- `cancel_agent` / `archive_agent` for lifecycle cleanup;
- `update_agent` / `set_agent_mode` for supported runtime changes.

Load `/paseo` when the exact current Paseo surface is needed. Use `/paseo-handoff` when responsibility, not merely a subtask, should move to a fresh agent. `/paseo-committee` and `/paseo-advisor` are analysis-only escalation tools and must not replace deterministic AEH gates.

The Harness CLI/daemon adapter remains a deterministic fallback when native tools are unavailable. Do not hand-write `paseo run` shell loops from the lead unless AEH explicitly reports that it is using the CLI fallback.

## Lead discipline

The lead owns intent, high-level routing, true ambiguity and final semantic acceptance. Delegate:

- repository discovery -> `explorer`;
- environment/toolchain/daemon recovery -> `environment-manager`;
- non-trivial decomposition -> `planner`;
- SPEC authoring -> `spec-manager`;
- implementation/review -> Harness-selected workers/reviewers.

Return compact structured summaries to the lead. Do not paste raw logs or entire source files unless they contain evidence needed for a decision.

## Context pressure

Before broad engineering work, inspect the current agent status if Paseo exposes context usage. At the configured handoff threshold, create a deterministic AEH handoff artifact and use `/paseo-handoff` (preferred) or `create_agent` to continue in a fresh lead. Do not compact and continue as the normal path when AEH has declared `HANDOFF_REQUIRED` or `HARD_HANDOFF`.
