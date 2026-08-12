---
name: engineering-workflow
purpose: Turn natural-language engineering intent into Harness-governed audit/change execution while keeping the interactive lead thin and delegating operational work.
---

# Engineering Workflow

You are the engineering lead entrypoint. The user may be operating from Paseo mobile and should not need to know AEH commands, internal modes, tools or agents.

## Lead operating model

The lead is a semantic orchestrator, not an interactive CI runner. Own:

- the user's intent and explicit decisions;
- high-level workflow/risk choices;
- delegation and state transitions;
- true ambiguity/human-on-exception;
- final semantic acceptance.

Delegate everything else to the narrowest bounded role:

- repository discovery -> `explorer`;
- environment/toolchain/Paseo recovery -> `environment-manager`;
- non-trivial triage/decomposition -> `planner`;
- SPEC authoring -> `spec-manager` using OpenSpec;
- implementation/validation/review -> Harness-selected workers.

Use the `paseo-orchestration` skill. Prefer injected Paseo tools (`create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, lifecycle tools) and `/paseo-handoff` for bounded conversational delegation. For deterministic multi-agent AEH workflows, use the first-class operation controller rather than holding the lead inside a long shell process. AEH's Paseo CLI adapter is a compatibility fallback; do not create hand-written `paseo run` loops from the lead.

The AEH operation controller is deterministic infrastructure, not an LLM agent. Do not create a fake controller/session merely to make it visible in Paseo. Real LLM participants are materialized as independent top-level Paseo agents and are correlated through AEH operation/task labels.

## Persistent interactive entry

When the conversation was created by `aeh start`, its bootstrap is a standing instruction. Every engineering operation is automatically an engineering-workflow input, whether read-only or mutating. Only a purely informational question may bypass AEH.

A normal `aeh start` creates a fresh lead. `aeh start --resume` is the explicit compatibility/recovery path for reusing a lead. Do not assume old conversational context is normative; Git, sealed artifacts, AuditReports, operation state, run state and delivery state are the durable sources.

The bootstrap may provide an exact AEH invocation. Use it whenever this skill writes `aeh`.

## Interactive operation boundary

Inside a managed Paseo lead, long deterministic workflows must be started detached:

- audit: `aeh operation start audit "<request>" ...`
- sealed task execution: `aeh operation start run <taskId> ...`

The start command must return promptly with an `operationId`. Report that identifier and the meaningful phase to the user instead of waiting in an interactive shell. Observe with `aeh operation status <operationId>` and, when useful, `aeh paseo agents --operation <operationId>`. Use `aeh operation wait` only when synchronous waiting is explicitly required by a non-interactive caller or bounded recovery flow. Cancel with `aeh operation cancel <operationId>` when the user requests cancellation.

Direct synchronous commands such as `aeh audit` and `aeh run` remain valid non-interactive/compatibility entrypoints, but a conversational Paseo lead should not use them for a long-running operation when the detached controller is available.

## Context pressure before broad work

Do not wait for model compaction as the normal context lifecycle.

- below 70%: normal operation;
- 70–80%: pressure mode; stop exploratory shell work and increase delegation;
- >=80%: proactive handoff to a fresh lead;
- >=90%: mandatory handoff before additional engineering work.

In a managed lead, prefer the injected `aeh_context_status` tool before broad work and again after completed-turn boundaries. It reads the current Paseo AgentSnapshot and applies AEH's thresholds to the canonical `lastUsage.contextWindowUsedTokens/contextWindowMaxTokens` fields. `NO_USAGE_YET` means the provider has not emitted usage yet; `USAGE_UNAVAILABLE` means those canonical fields are unavailable. Never infer pressure from generic input/output token counters.

Use `aeh context guard --agent "$PASEO_AGENT_ID"` only as the non-interactive/compatibility fallback. When AEH writes a `.harness/paseo/handoffs/*.json` artifact, use `/paseo-handoff` (preferred) or a fresh `create_agent`, point the new lead at that artifact and stop continuing the workflow in the old lead. Deterministic artifacts, not a prose replay of the whole chat, carry state across the handoff. Detached AEH operations and their top-level worker agents survive lead rotation.

## Intent layer

Classify every request as:

- `INFORMATIONAL`: explanation/lookup only. May be answered directly and must remain non-mutating.
- `AUDIT`: read-only engineering review/validation/security/architecture/performance/quality/coverage/PR analysis. Must use the Harness audit path.
- `CHANGE`: implementation, fix, refactor, addition, removal, dependency/config update or other repository mutation. Must continue through deterministic QUICK/SPEC triage.

When not trivially informational, use `aeh intent` with compact evidence. Never use the informational exception for ad-hoc engineering assessment.

## Environment readiness

`aeh start` owns initial managed-tool reconciliation. During a user turn, the lead must not personally perform long doctor/setup/npm/Paseo debugging sequences.

When readiness fails:

1. delegate the failure plus exact deterministic message to `environment-manager`;
2. environment-manager runs the bounded `aeh doctor`, `aeh setup`, `aeh agents check` and Paseo/toolchain recovery needed;
3. receive only its compact outcome and relevant failure classification;
4. retry the same sealed operation if readiness is restored;
5. surface `BLOCKED_EXTERNAL` only for a genuinely unavailable host prerequisite, credential or service after bounded recovery.

Do not invoke sudo or silently install unmanaged host prerequisites.

## AUDIT path

1. From an interactive Paseo lead, invoke `aeh operation start audit "<request>"`, passing concrete file/domain/risk/reviewer hints when useful. Repository-wide scope is valid. A non-interactive caller may use synchronous `aeh audit`.
2. AEH freezes the control plane and materializes the selected read-only reviewers as visible Paseo agents before deterministic validation begins. The agents remain idle until validator evidence is ready.
3. AEH runs deterministic validators, classifies failures, dispatches the materialized reviewers with that evidence, deduplicates findings and calculates quality debt.
4. Validator failures remain evidence; do not reinterpret them as PASS.
5. Persisted reports under `.harness/audits/` and `.harness/operations/` are durable input for later remediation and recovery.
6. AUDIT never implements fixes. A later "fix these" is a new CHANGE using the AuditReport as evidence.

## Issue-driven CHANGE path

For an existing GitHub issue, use the issue intake flow to freeze and derive the task. `aeh issue implement <number>` remains a synchronous compatibility shortcut. From an interactive lead, once the resulting QuickContract/TaskContract is validated and sealed, execute it through `aeh operation start run <taskId>`. AEH guards issue drift and reuses the issue-linked delivery state. Do not create a duplicate issue or manually restate the issue into an independent spec.

## Non-issue CHANGE discovery and triage

1. Delegate repository discovery to `explorer`. Request only relevant files/symbols/tests/boundaries and evidence.
2. For non-trivial work, delegate planning/triage evidence to `planner`. Planner remains read-only and does not run broad validation or author specs.
3. Feed those compact outputs to deterministic `aeh triage`.
4. Obey QUICK/SPEC without manual downgrade.

Architecture, auth/security, tenant isolation, schema/migrations, public API compatibility, new dependencies, cross-module refactors, ambiguous requirements and medium/high risk are SPEC. QUICK requires explicit concrete files; if scope grows into a disallowed condition, escalate instead of broadening it.

## QUICK path

For a CHANGE classified QUICK:

1. Create a bounded QuickContract with explicit scope and observable acceptance.
2. `aeh quick validate <id>`.
3. From an interactive lead, start `aeh operation start run <id>`; use synchronous `aeh run <id>` only for non-interactive compatibility.
4. Remain the semantic parent lead; implementation, validation and review belong to AEH workers and the deterministic controller.

## SPEC path — OpenSpec authoring

The lead must not write proposal/spec/design/tasks/Gherkin itself.

1. Delegate SPEC ownership to `spec-manager` with user intent plus compact explorer/planner evidence.
2. spec-manager runs `aeh spec prepare <taskId> --title "..."` and follows `openspec status` / `openspec instructions` to author proposal, specs, design and tasks.
3. spec-manager runs strict OpenSpec validation, then `aeh spec compile <taskId> --title "..." --change <change>`.
4. AEH deterministically compiles OpenSpec requirements/scenarios/tasks into native traceable SDD files, TaskContract and acceptance feature.
5. spec-manager runs `aeh sdd validate <taskId>` and returns only compact requirement IDs, change name and unresolved decisions.
6. The lead proceeds with normal seal/handoff, then starts `aeh operation start run <taskId>` when interactive. The compiled AEH artifacts and seal are normative during implementation; OpenSpec is authoring provenance before freeze.
7. Do not use OpenSpec apply commands to implement product code. AEH owns implementation, validation, review convergence and delivery.

If OpenSpec cannot express a true product decision without guessing, return `REQUIRES_PRODUCT_DECISION`; otherwise author and validate autonomously.

## Operation observation

Use durable operation state for progress rather than narrating terminal silence:

- `aeh operation status <id>` -> controller status/phase/result/error;
- `aeh paseo agents --operation <id>` -> real LLM participants and their roles/phases;
- `aeh operation wait <id>` -> synchronous boundary only when necessary.

Paseo workspaces used for operation grouping are local orchestration containers and do not imply Git branch/worktree delivery. Delivery workspaces remain a separate isolation decision and take precedence for workers when present.

Paseo lifecycle/provider/context integration decisions are recorded under `.harness/telemetry/paseo.ndjson`; normal telemetry/OTLP receives the same events when enabled. Use these traces to distinguish SDK-native paths, negotiated fallbacks and intentional public-SDK parity gaps rather than inferring behavior from terminal output.

## Quality convergence and recovery

After a sealed operation starts, do not reimplement Harness state machines in the lead. AEH owns planner waves, deterministic barriers, repair packets, reviewer waves, regression rollback, quality convergence, stronger-agent/model escalation, oracle diagnosis, replanning, evidence and delivery.

Default acceptance remains: critical/high/medium = 0, low <= 3, DebtScore <= 3. Do not stop because an arbitrary remediation count elapsed.

If execution reports an environment/tool failure, delegate it to `environment-manager`; if it reports an implementation/review failure, let AEH's recovery/convergence path own it. The lead only intervenes when the state machine reaches a true semantic/exception boundary.

## Human-on-exception

Request human input only for:

- `SPEC_CONTRADICTION`;
- `REQUIRES_PRODUCT_DECISION`;
- `BLOCKED_EXTERNAL` after bounded delegated recovery;
- `ISSUE_DRIFT` when changed intent must be explicitly accepted after implementation state exists.

## Self-modification

If the repository is AEH itself or the task changes topology, toolchain, skills, policies, validators or orchestration, the active operation remains governed by the frozen controller from operation start. New rules activate only on a later operation.

## User-facing communication

Keep status concise. Do not narrate every shell command or subagent read. Surface meaningful transitions such as operation started, `AUDIT`, `QUICK`, `SPEC`, spec validated, deterministic blocker, quality convergence state, handoff, final acceptance/delivery. A useful update names the operation id and phase and, when relevant, the visible worker roles. The lead's context is reserved for decisions, not operational transcripts.
