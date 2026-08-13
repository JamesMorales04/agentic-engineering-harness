# Paseo-native integration contract

AEH treats Paseo as the authority for agent runtime state and generic agent orchestration, while AEH remains the authority for engineering policy and deterministic acceptance.

## Authority split

| Concern | Authority | Preferred surface |
| --- | --- | --- |
| Agent creation/session lifecycle | Paseo | `@getpaseo/client` |
| Agent current state | Paseo | `agents.ref(id).refetch()` |
| Agent context-window usage | Paseo/provider | `AgentSnapshot.lastUsage` |
| Provider/model availability | Paseo | provider snapshot/listModels/diagnostic |
| Generic create/send/status/activity tools | Paseo | injected native/MCP Paseo tools |
| AUDIT/RUN operation state | AEH | `aeh-control` / operation state |
| Context thresholds and handoff policy | AEH | `aeh_context_status` / `context guard` |
| SDD, contracts, seals, validation | AEH | deterministic Harness core |
| Quality convergence/acceptance | AEH | deterministic Harness core |

Do not copy generic Paseo lifecycle tools into `aeh-control`. The AEH MCP exists only for AEH-specific controller and policy semantics.

## Context pressure

Paseo v0.3.1 exposes canonical context-window fields in `AgentUsage`:

```text
contextWindowUsedTokens
contextWindowMaxTokens
```

AEH reads them from the full agent snapshot. It does **not** derive context pressure from `inputTokens`, `outputTokens`, `totalTokens`, log text or compact agent-list metadata.

States:

```text
NO_USAGE_YET
  snapshot exists but the provider has not emitted lastUsage yet

USAGE_UNAVAILABLE
  snapshot/usage exists but canonical context-window fields are unavailable

OK
  ratio < pressureThreshold (default 70%)

PRESSURE
  pressureThreshold <= ratio < handoffThreshold (default 70–80%)

HANDOFF_REQUIRED
  handoffThreshold <= ratio < hardHandoffThreshold (default 80–90%)

HARD_HANDOFF
  ratio >= hardHandoffThreshold (default 90%)
```

Managed leads receive the preapproved `aeh_context_status` tool. A normal managed lead calls it without an `agentId`. AEH resolves the context target in strict order: explicit diagnostic `agentId`, host-provided `PASEO_AGENT_ID`, then the compatible project-local `lead-session.json` written by `aeh start`. The durable fallback respects configured `orchestration.interactive.stateDir` and validates the lead-state schema version, current bootstrap/runtime version, project root, project name and agent id before use. It fails closed on stale or mismatched state and never guesses by listing agents. The selected identity source is traced as `harness.paseo.context.identity`.

`aeh context guard --agent ...` remains the CLI compatibility/non-interactive surface and owns handoff-artifact/rotation side effects.

## Event-driven completion

Agent waiting is:

```text
subscribe(agent_update)
        |
        +--> refetch current snapshot
        |
        +--> updates trigger refetch
        |
        `--> terminal state -> read recent timeline -> complete
```

Subscription is installed **before** the first refetch so a transition cannot fall between the snapshot and listener setup. A freshly observed `idle` state is not treated as completion until the wait has observed activity/update evidence, avoiding a send/wait race.

Fallback order:

```text
Paseo SDK subscription
        ↓ unavailable
public SDK wait compatibility
        ↓ unavailable
Paseo CLI wait/log compatibility
```

The selected path is emitted in Paseo integration traces.

## Provider/model preflight

Before creating or materializing an agent, AEH attempts a public-SDK preflight:

1. read the provider snapshot for the target cwd;
2. reject explicitly disabled/error/unavailable providers;
3. use the snapshot model catalog when available;
4. otherwise call `listModels(provider, { cwd })`;
5. when provider/model discovery fails, obtain a provider diagnostic where supported;
6. fail before `createAgent` when the catalog authoritatively excludes the requested model;
7. if the installed SDK does not expose provider preflight APIs, record `provider.preflight.skipped` and let agent creation remain authoritative.

AEH does not force provider refreshes on every launch. Paseo owns snapshot caching and explicit refresh semantics.

## Intentional CLI parity gaps (P2)

CLI usage is not forbidden when the public SDK lacks required semantics. It must be narrow and traced.

### Operation workspace creation

AEH currently uses:

```text
paseo workspace create --isolation local --path ... --title ... --json
```

because the Paseo v0.3.1 public SDK workspace create surface does not expose equivalent isolation/title controls. This workspace is orchestration grouping only; it is not a Git delivery worktree.

Trace events:

```text
harness.paseo.workspace.cli.required
harness.paseo.workspace.cli.created
harness.paseo.workspace.cli.error
```

### External controller cleanup

The external deterministic controller may stop agents with the supported Paseo CLI because the public v0.3.1 agent handle does not expose the cancel/kill parity needed for operation cleanup. AEH deliberately does not import internal `DaemonClient` APIs.

Trace events:

```text
harness.paseo.cleanup.cli.required
harness.paseo.cleanup.cli.stop
harness.paseo.cleanup.cli.error
```

These two gaps should be removed when the public SDK reaches parity.

## Integration traces

Paseo integration events are always persisted locally to:

```text
.harness/telemetry/paseo.ndjson
```

When normal Harness telemetry is enabled, the same event is also emitted through `recordEvent` and the configured OTLP path.

Representative events:

```text
harness.paseo.provider.preflight
harness.paseo.provider.preflight.skipped
harness.paseo.agent.launch
harness.paseo.agent.materialize
harness.paseo.agent.dispatch
harness.paseo.agent.snapshot
harness.paseo.agent.wait
harness.paseo.agent.wait.completed
harness.paseo.agent.wait.fallback
harness.paseo.context.identity
harness.paseo.context.status
harness.paseo.context.handoff
harness.paseo.fallback.cli
harness.paseo.workspace.cli.*
harness.paseo.cleanup.cli.*
```

A useful trace answers:

- which transport was selected (`sdk` or `cli`);
- which observation source was used (`subscription`, snapshot, sdk-wait, cli-wait);
- how the managed lead identity was resolved (`argument`, `environment`, `lead-state`);
- whether a fallback was exceptional or an intentional SDK parity gap;
- why the fallback occurred;
- the associated agent/operation/provider/model/workspace;
- the relevant duration/status/error when applicable.

## Migration rule

When Paseo adds public SDK parity for a CLI-only operation:

1. add the public SDK path;
2. make it primary;
3. retain CLI only as version-negotiated compatibility if still necessary;
4. add a regression proving SDK use;
5. keep a fallback trace until the compatibility floor makes CLI removable;
6. remove any capability inference based on parsing help text when it no longer serves a compatibility path.