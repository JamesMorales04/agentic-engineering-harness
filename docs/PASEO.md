# Paseo Integration

Paseo is AEH's default interactive orchestration surface. The integration separates **Paseo communication/session lifecycle** from **AEH deterministic workflow ownership**.

## SDK-first control plane

AEH uses the official TypeScript SDK, `@getpaseo/client`, as the primary control surface for agent creation, follow-up turns, status lookup and directory queries. The SDK is resolved directly when available and otherwise from the managed `@getpaseo/cli` installation. Paseo CLI already ships the matching client package, so AEH does not independently pin a second Paseo SDK version.

The CLI remains responsible for daemon bootstrap/recovery and is retained as a compatibility fallback when the SDK cannot be resolved or connected:

```text
AEH
├── daemon/bootstrap/recovery -> Paseo CLI
└── normal agent lifecycle    -> @getpaseo/client
```

Set `AEH_PASEO_FORCE_CLI=1` only when the compatibility path is deliberately required. `PASEO_DAEMON_URL` overrides the default SDK endpoint `ws://127.0.0.1:6767/ws`; `PASEO_DAEMON_PASSWORD` supplies daemon authentication when configured.

A system-prompt-only idle agent is an SDK-only invariant. If the SDK is unavailable, AEH refuses to degrade that lead creation into a CLI user turn because doing so would expose the bootstrap as conversational input.

## Conversational lead

`aeh start` creates the lead as an idle Paseo agent. The AEH bootstrap is passed through the SDK's `systemPrompt`; it is no longer sent as the first user message and there is no synthetic `AEH READY` turn.

The bootstrap is intentionally thin. `AGENTS.md`, `.harness/skills/engineering-workflow/SKILL.md`, and the resolved AEH agent topology are authoritative for roles, charters, permissions and delegation. This avoids duplicating a role map inside every Paseo conversation and prevents prompt/configuration drift.

When the lead is running inside Paseo and Paseo exposes its orchestration tools, it may still use the native/MCP conversational surface and `/paseo-handoff`. Deterministic Harness-owned work, however, is created externally by AEH through the SDK.

## Independent AEH agents

AEH-managed workers are created without the Paseo SDK `parent` option. A worker may be placed in a delivery workspace, but workspace placement does not establish parentage. This makes each worker a top-level Paseo agent rather than a child whose lifecycle belongs to the current lead conversation.

Workflow ownership is represented by labels instead:

```text
aeh.project=<project>
aeh.kind=lead|worker
aeh.role=<logical-agent>
aeh.task=<task-id>        # workers
aeh.profile=<profile>     # when selected
aeh.generation=<n>        # leads
```

The shared Paseo runtime exposes list/inspect primitives over those labels. This lets AEH determine which logical agent is active for a task without scraping assistant prose or relying on parent/child nesting. The same labels survive lead context rotation, so a fresh lead can correlate existing workers with durable AEH run state.

### Observe active agents

Use the top-level AEH command to inspect the live Paseo directory. The project label is applied automatically; filters are additive:

```bash
aeh paseo agents
aeh paseo agents --status working
aeh paseo agents --kind worker --role backend-implementer
aeh paseo agents --task TASK-123 --json
```

The tabular view reports status, logical role, task, kind, stable Paseo agent ID and title. `--json` returns the same normalized fields plus the complete AEH label set. This is the preferred way to answer which AEH agent is currently working without depending on Paseo parent/subagent nesting.

## Runtime consolidation

Lead startup, `PaseoWorkerExecutor`, and generic `agentPrompt` execution all use the same managed Paseo runtime. That runtime owns SDK-first create/run/probe/list behavior and the CLI fallback. Individual worker paths should not add new hand-written `paseo run/send/wait/logs` loops.

Structured output is passed through the SDK `outputSchema` field. The compatibility CLI path continues to negotiate `--output-schema` and background capabilities dynamically.

## Session policy

Default:

```yaml
orchestration:
  interactive:
    sessionPolicy: fresh-on-start
```

```bash
aeh start          # fresh idle lead
aeh start --resume # explicit compatible reuse
```

Workspaces and durable AEH state remain reusable even though normal conversational context starts clean.

## Context rotation

Default pressure policy is 70/80/90 percent. `aeh context guard` consumes a context ratio only when Paseo exposes a usable field; AEH does not guess.

At the handoff threshold it writes a deterministic `.harness/paseo/handoffs/*.json` artifact. From a managed Paseo lead it also creates the replacement lead automatically and bootstraps it from the handoff artifact and referenced sealed/run/audit/delivery state. Workers remain independent top-level agents associated through AEH labels and durable task/run state rather than lead parentage.

## Trust boundary

Paseo owns communication, process and session lifecycle. It is not normative engineering truth. AEH TaskContracts, seals, deterministic reports, evidence graphs and quality gates continue to decide acceptance.

For stronger direct process isolation configure Podman sandboxing where appropriate; Paseo orchestration and worker sandboxing remain separate policy axes.
