# Supervisor watchdog snapshot

A stalled durable revision is not, by itself, evidence that semantic intervention is required.

Before waking the operation supervisor, AEH inspects unresolved participant runtimes deterministically. If any child is still running, working, streaming or initializing, the watchdog stays controller-only and emits no LLM wake.

When no child runtime is active, the supervisor wake contains a compact authoritative snapshot with durable participant status, runtime status, phase, result artifact references, errors and operation progress. The supervisor must reason from that snapshot and existing semantic context rather than rediscovering state with shell, filesystem, process or Paseo CLI commands.

This keeps runtime/process discovery in the deterministic controller and reserves the supervisor for semantic exceptions.
