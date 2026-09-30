---
name: github-delivery-lifecycle
description: Safe issue-linked GitHub delivery and Paseo worktree handoff.
license: Apache-2.0
---
# GitHub Delivery Lifecycle

Use only when project delivery integration is enabled or explicitly requested.

- Treat the validated local SDD/TaskContract as normative; the GitHub issue is a delivery mirror unless project policy explicitly says otherwise.
- Read tokens from environment only; never write credentials into specs, logs or delivery state.
- Create at most one issue and one issue-linked branch per task; persist identifiers after each successful remote write.
- Base the branch on the originating branch captured when the spec was created.
- Never force-push, amend, rebase or rewrite shared history as recovery.
- Create/reuse one Paseo worktree workspace for implementation, review and repair.
- Report issue URL/number, branch, workspace id/path and partial-state failures.
