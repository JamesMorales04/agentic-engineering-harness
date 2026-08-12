---
name: worktree-lifecycle
description: Manage isolated Git/Paseo workspaces without history rewriting or cross-task contamination.
license: Apache-2.0
---
# Worktree Lifecycle

Use for branch/worktree-backed task execution.

- Capture the originating branch before creating task state.
- Prefer one issue/task branch per isolated workspace.
- Never reuse a dirty worktree for an unrelated task.
- Do not force-push, amend, rebase or reset shared history as recovery.
- Keep sealed contracts/spec artifacts available read-only to workers.
- Reuse the same Paseo workspace for implementation, review and repair of one task.
- Archive/remove the workspace only after delivery state is durable.

Report branch, base, workspace id/path and any lifecycle blocker.
