# Paseo Integration

Paseo is treated as a replaceable orchestration provider, not as part of the harness core.

Recommended ownership model:

```text
Human → Codex lead → Paseo delegation → OpenCode worker(s) → Harness → Codex review
```

Use one feature/worktree for tightly coupled work. Parallelize only genuinely independent workstreams. Do not create a swarm merely because multiple workers are available.

Install the harness skills alongside Paseo's own orchestration skills. The lead-agent instructions should explicitly retain task ownership after delegation.
