# Paseo Integration

Paseo is AEH's default interactive orchestration surface. In v0.6 the design intentionally separates **agent-local orchestration** from the **external deterministic Harness adapter**.

## Conversational lead

When the lead is running inside Paseo and Paseo exposes its orchestration tools, prefer the native/MCP control surface:

- create a bounded agent;
- send follow-up prompts;
- inspect agent status/activity;
- cancel/archive/update agent lifecycle;
- use `/paseo` for the current tool reference;
- use `/paseo-handoff` when responsibility moves to a fresh agent.

This keeps the lead as an orchestrator and avoids filling its context with hand-written shell control loops. Committee/advisor skills are advisory reasoning only; deterministic AEH validation remains authoritative.

## External AEH fallback

AEH itself is an external Node control-plane process and cannot assume access to tools injected only into an agent conversation. Therefore it retains a CLI adapter for deterministic launches, waits, logs and repair prompts.

The adapter no longer hard-codes a specific Paseo CLI surface. Before launch it probes:

```text
paseo --version
paseo run --help
paseo daemon status --help
```

and conditionally uses JSON/quiet/background flags only when supported. This permits older Paseo installations to fail with a precise capability error rather than because AEH blindly passed a newer flag.

Recognized stale/unreachable daemon states are recovered by stop/start + readiness verification before launching a lead/worker.

## Session policy

Default:

```yaml
orchestration:
  interactive:
    sessionPolicy: fresh-on-start
```

```bash
aeh start          # fresh lead
aeh start --resume # explicit compatible reuse
```

Workspaces and durable AEH state remain reusable even though normal conversational context starts clean.

## Context rotation

Default pressure policy is 70/80/90 percent. `aeh context guard` consumes a context ratio only when Paseo exposes a usable field; AEH does not guess.

At the handoff threshold it writes a deterministic `.harness/paseo/handoffs/*.json` artifact. From a managed Paseo lead it also creates the replacement lead automatically and bootstraps it from the handoff artifact and referenced sealed/run/audit/delivery state. The old lead stops engineering work rather than compacting and continuing normally.

## Trust boundary

Paseo owns communication/process/session lifecycle. It is not normative engineering truth. AEH TaskContracts, seals, deterministic reports, evidence graphs and quality gates continue to decide acceptance.

For stronger direct process isolation configure Podman sandboxing where appropriate; Paseo orchestration and worker sandboxing remain separate policy axes.
