# Paseo Integration

Paseo is AEH's default interactive orchestration surface. The integration separates **Paseo communication/session lifecycle** from **AEH deterministic workflow ownership**.

## Visible operation graph

A managed conversational lead does not own a long-running shell process. Long AUDIT/RUN workflows are first-class detached AEH operations:

```bash
aeh operation start audit "Review the repository architecture and security"
aeh operation start run TASK-123
```

`start` returns an operation id promptly. The deterministic controller persists state in `.harness/operations/<id>.json`, then performs the sealed workflow independently of the lead conversation:

```text
Paseo UI
   │
   ▼
AEH Lead (semantic orchestrator)
   │ operation tools / short status calls
   ▼
AEH Operation Controller (deterministic, not an LLM agent)
   ├── seals / validators / state machines
   ├── local orchestration workspace
   └── Paseo SDK
          ├── planner/reviewer/worker agent
          ├── planner/reviewer/worker agent
          └── ...
```

The controller is deliberately **not** represented by a fake Paseo agent. Only real LLM participants become Paseo sessions.

Observe or control an operation with:

```bash
aeh operation status <operation-id>
aeh operation wait <operation-id> --timeout 1800
aeh operation cancel <operation-id>
aeh paseo agents --operation <operation-id>
aeh paseo agents --operation <operation-id> --phase review
```

Synchronous `aeh audit` / `aeh run` remain valid compatibility entrypoints for non-interactive automation.

The conversational lead is the semantic authority for translating each human
turn into a typed, versioned `IntentDecisionV1`. It resolves the requested
outcome, negation, referents, constraints and follow-ups, then selects the
corresponding route. AEH does not re-interpret the original sentence after
that decision. The deterministic controller validates only the structured
decision and remains authoritative for contracts, capabilities, permissions,
validators, evidence, lifecycle, provenance and delivery.

Each decision is bound to the originating `userTurnId` when available and is
stored with the operation's durable intent state (or the deterministic
session's compact turn record). This lets lead rotation recover operation and
finding references without replaying the old model conversation. An unresolved
mutating referent is rejected by the route contract until the lead resolves it;
the controller never guesses a target from the human text.

Explanations and orientation use the bounded `aeh_informational_context` tool
and do not create an operation. Defect discovery, correctness/safety judgments
and formal review use the AUDIT start tool; mixed requests preserve the lead's
explicit semantic decision. A heuristic classifier remains available for the
`aeh intent` diagnostic/evaluation surface and explicitly marked compatibility
fallbacks only; disagreement cannot veto a lead decision.

## SDK-first control plane

AEH uses Paseo's published TypeScript client package, `@getpaseo/client`, as the primary control surface for agent creation, follow-up turns, status lookup and directory queries. Paseo currently documents that package as public but **not yet a stable public SDK**, so AEH deliberately resolves the copy bundled with the active `@getpaseo/cli` installation first instead of independently selecting a client version.

The resolver supports normal PATH installations and mise-managed npm tools, including non-hoisted/store layouts. AEH asks `command -v paseo`, `mise which paseo`, and `mise where npm:@getpaseo/cli`, then resolves or bounded-scans the active installation for its exact `@getpaseo/client` entry. A direct project-level SDK import is retained only as a compatibility fallback.

Normal lifecycle is always SDK-first unless `AEH_PASEO_FORCE_CLI=1` is explicitly set:

```text
AEH
├── daemon/bootstrap/recovery          -> Paseo CLI
├── normal agent lifecycle             -> active @getpaseo/client
└── explicit/recoverable compatibility -> Paseo CLI
```

`PASEO_DAEMON_URL` overrides the default SDK endpoint `ws://127.0.0.1:6767/ws`; `PASEO_DAEMON_PASSWORD` supplies daemon authentication when configured.

A system-prompt-only idle agent is an SDK-only invariant. If the SDK is unavailable, AEH refuses to degrade that lead creation into a CLI user turn because doing so would expose the bootstrap as conversational input.

## Agent lifecycle

AEH separates visible agent lifecycle into three phases:

```text
materialize -> dispatch -> wait
```

- **materialize** creates an idle top-level Paseo agent so it is visible immediately;
- **dispatch** sends the bounded prompt when deterministic prerequisites/evidence are ready;
- **wait** collects completion/result without conflating creation with execution.

For AUDIT, AEH materializes the selected read-only reviewers before running deterministic validators. They remain visible/idle while validation runs, then AEH dispatches them with the completed validator evidence. This preserves deterministic evidence precedence without the earlier “silent terminal” UX.

The adapter follows the Paseo 0.3.1 create contract: `cwd` remains present even when `workspaceId` controls placement, `initialPrompt` is used for the first turn, and provider/model remain separate session-config fields. It supports current handles through `send`, `refetch`, timeline polling and compatible legacy helpers where present.

## Conversational lead

`aeh start` creates the lead as an idle Paseo agent. The AEH bootstrap is passed through the SDK's `systemPrompt`; it is not sent as a user message and there is no synthetic readiness turn.

The bootstrap is intentionally thin. `AGENTS.md`, `.harness/skills/engineering-workflow/SKILL.md`, and the resolved AEH agent topology are authoritative for roles, charters, permissions and delegation.

When `orchestration.interactive.usePaseoTools` is enabled, AEH derives the exact command vector that launched the current package and injects an `aeh-control` stdio MCP server into the lead session. A normal installed launch therefore becomes conceptually:

```text
mcp server: aeh-control
command: <exact Node executable>
args: [<exact dist/main.js>, operation, mcp]
```

The control MCP is preapproved only for these bounded tools:

```text
aeh_informational_context
aeh_operation_start_audit
aeh_operation_start_run
aeh_operation_start_change
aeh_operation_digest
aeh_operation_status
aeh_operation_ack
aeh_operation_portfolio
aeh_operation_cancel
aeh_context_status
```

`aeh_informational_context` is read-only and accepts a lead-produced
`IntentDecisionV1` whose route is INFORMATIONAL. AEH validates the decision's
effects without scanning the human request. The lead is never given Serena through this control surface;
Serena is projected only to a routed worker/reviewer whose resolved capability
contract permits it.

Paseo's `toolPolicy.preapproved` is scoped to those exact MCP server/tool identities; native shell/edit tools are not broadened by this configuration. If the AEH invocation cannot be parsed as a safe command vector, MCP injection is skipped rather than evaluating shell syntax, and the short `aeh operation ...` CLI surface remains the fallback.

The lead bootstrap version is incremented when this managed-session contract changes, so explicit resume cannot silently reuse an older lead that lacks the current operation-control surface.

Paseo native orchestration tools remain preferred for bounded conversational delegation and `/paseo-handoff`. Deterministic multi-agent workflows are owned by the detached AEH operation controller, so the lead remains available to the user.

## Operation MCP server

The same control surface can be started directly for any MCP-capable host:

```bash
aeh operation mcp
```

It is a stdio JSON-RPC server and calls the same persistent controller used by the CLI. It does not duplicate workflow logic and does not become a normative engineering source.

## Independent AEH agents

AEH-managed workers are created without Paseo `parent` ownership. Workers are independent top-level sessions so lead context rotation cannot terminate or orphan their lifecycle.

Workflow ownership and visibility use labels:

```text
aeh.project=<project>
aeh.kind=lead|worker
aeh.role=<logical-agent>
aeh.task=<task-id>
aeh.operation=<operation-id>
aeh.operation.kind=audit|run|quick|...
aeh.operation.phase=queued|planning|review|implementation|diagnosis|...
aeh.workspace.kind=orchestration|delivery
aeh.profile=<profile>     # when selected
aeh.generation=<n>        # leads
```

The operation/task labels are durable correlation keys; Paseo parent/subagent nesting is not the workflow source of truth.

### Observe active agents

```bash
aeh paseo agents
aeh paseo agents --status working
aeh paseo agents --kind worker --role backend-implementer
aeh paseo agents --task TASK-123 --json
aeh paseo agents --operation AUDIT-... --phase review
```

The operation-aware view reports stable Paseo IDs, role, operation, phase, task, status and title.

## Orchestration workspace vs delivery workspace

Paseo workspaces and Git delivery isolation are separate concepts.

For each detached operation AEH attempts to create a **local Paseo workspace** pointing at the existing repository directory. Its purpose is UI/execution grouping: multiple agents for the same audit/run appear together. It does not create or imply a Git branch/worktree.

When delivery policy creates an issue-linked worktree workspace, that delivery workspace takes precedence for implementation/review agents:

```text
operation workspace -> local grouping, no Git isolation

delivery workspace  -> branch/worktree isolation and delivery lifecycle
```

This lets audits and non-delivery operations have coherent Paseo grouping even when `delivery.paseo.enabled` is false.

## Runtime consolidation

`PaseoWorkerExecutor` and generic `agentPrompt` no longer independently reconstruct provider/model/title/workspace/labels. Both consume one launch-spec compiler. This is the single boundary for:

- provider/model selection;
- title;
- operation/task labels;
- semantic phase;
- orchestration-vs-delivery workspace;
- timeout.

This prevents launch-path drift such as provider/model or cwd/workspace serialization mismatches.

## Operation/session metadata

Worker/reviewer execution records retain lifecycle metadata in addition to stdout/stderr:

```text
id
transport
workspaceId
title
operationId
operationKind
phase
status
startedAt
finishedAt
logicalAgent / runtime / model
```

Audit/run reports can therefore distinguish a real Paseo SDK session from CLI/direct/Podman execution without inferring it from logs.

Operation phase is durable even when optional telemetry export is disabled. Harness lifecycle events update `.harness/operations/<id>.json` through phases such as `validating`, `planning`, `implementation`, `remediation`, `review`, `delivery`, and `finished`.

## Cancellation

`aeh operation cancel <id>` terminates the detached controller and then discovers real Paseo agents by `aeh.operation=<id>`. Each active agent is interrupted through Paseo's supported `paseo agent stop <id>` lifecycle. Cleanup failures are retained as `cleanupWarnings` in operation state rather than silently ignored.

## Session policy and context rotation

Default lead policy remains:

```yaml
orchestration:
  interactive:
    sessionPolicy: fresh-on-start
```

```bash
aeh start          # fresh idle lead
aeh start --resume # explicit compatible reuse
```

Default context pressure policy is 70/80/90 percent. At the handoff threshold AEH writes `.harness/paseo/handoffs/*.json` and rotates responsibility to a fresh lead. Detached operations and independent worker agents continue; durable operation/run/audit/delivery state allows the replacement lead to correlate them without replaying the old conversation.

## Trust boundary

Paseo owns communication, UI grouping, process and session lifecycle. It is not normative engineering truth. AEH TaskContracts, seals, deterministic reports, operation state, evidence graphs and quality gates decide acceptance.

For stronger direct process isolation configure Podman sandboxing where appropriate; Paseo orchestration and worker sandboxing remain separate policy axes.
