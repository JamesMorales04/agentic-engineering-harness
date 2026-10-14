# Paseo Orchestration Runbook (verified 2026-10-14, paseo 0.9.1)

Durable procedure for creating, supervising and cleaning up campaign subagents.
Verified by the recovery session smoke test. Next Directors: follow this, do not
ask the Owner for routine orchestration help.

## 1. Environment

- `paseo --version` = 0.9.1. Daemon: local (`~/.paseo`), endpoint `ws://127.0.0.1:6767/ws`.
- Detached flag on this version is `-d` / `--background` (NOT `--no-wait`; that flag
  exists only on `paseo send`).
- Providers: `codex` (available), `opencode` (available). Others unavailable — do not use.
- `paseo permit allow <agent> [req_id]` supports exact request IDs; `--all` only when
  exactly one inspected request is pending for that agent.
- Child agents auto-associate: `ParentAgentId` = calling agent's `PASEO_AGENT_ID`.
  Verified: smoke agents show `"ParentAgentId": "4c707727-..."` (Director session).

## 2. Campaign model routing (DO NOT substitute silently)

| Role | Command fragment | Verified effective identity (`paseo inspect`) |
| --- | --- | --- |
| Implementation worker | `--provider "opencode/opencode-go/muse-spark-1.3-contributor" --thinking low` | Provider=opencode, Model=opencode-go/muse-spark-1.3-contributor, Thinking=low |
| Independent reviewer | `--provider "codex/gpt-6-luna" --thinking xhigh` | Provider=codex, Model=gpt-6-luna, Thinking=xhigh |

Known bad routes (do not use):
- `--provider "opencode/opencode-muse-spark-1.3"` → `Model not found` (mis-composed ID).
- `--provider "opencode/muse-spark-1.3"` → agent creates, then 401 `Invalid credential`
  on inference (credential does not cover the direct route). Error state, no output.
- The independent Luna reviewer must NEVER be executed through OpenCode.

## 3. Create (bounded, labelled, detached)

```bash
paseo run -d --provider "opencode/opencode-go/muse-spark-1.3-contributor" --thinking low \
  --title "AEH <scope>" --label aeh.campaign=<name> --label aeh.role=<role> --json \
  "<BOUNDED PROMPT with explicit read-only or file-scoped instruction>" | head -n 20
```

- Always `-d` + `--json` (captures `agentId`), always `--title`, always `aeh.*` labels.
- Reviewers: read-only prompt + `NEVER run git checkout/stash/clean/commit/push, NEVER modify files`.
  Reviewers inspect refs via `git show <sha>:<path>` / `git diff <base>..<head>`.
  Execution (if needed) only in a private worktree they create and remove themselves.
- Implementers: one branch + one private worktree each; explicit file scope; expected artifact.

## 4. Supervise (observable loop, bounded waits)

```bash
paseo ls --json                          # active execution (status=running)
paseo inspect <id> --json                # identity + Status + PendingPermissions + ParentAgentId
paseo permit ls --json                   # pending permission requests (all agents)
paseo wait <id> --timeout 300            # block until idle (bounded; does NOT resolve permits)
paseo logs <id> --tail 30                # timeline: [User]/[Shell]/[Read]/[Error]/verdict
paseo send <id> --prompt "..."           # follow-up turn (add --no-wait to not block)
```

State model: `running` (working) / `idle` (done — collect logs) / `error` (read System Error
in logs, diagnose, do NOT blindly respawn) / permission-blocked (`PendingPermissions` non-empty
in inspect, or `paseo permit ls` entries) / stalled (`running` with stale `UpdatedAt` — inspect
timeline, then continue/cancel/escalate explicitly).

Permission policy:
- Safe in-scope requests (read-only inspection, focused tests, writes inside the assigned
  worktree): allow the EXACT request ID: `paseo permit allow <agent> <req_id>`, then keep waiting.
- Over-scope requests (outside worktree, protected paths, destructive ops, credentials):
  `paseo permit deny <agent> <req_id>`, stop the agent, record the incident.
- Never enable unrestricted bypass for a whole agent to avoid prompts.
- Read-only tasks in default modes (`default` for opencode, `auto` for codex) needed NO approvals.

## 5. Finish

```bash
paseo logs <id> --tail 40    # preserve verdict/output BEFORE cleanup
paseo archive <id>           # soft-delete; add --force only if still running
```

Verify cleanup: `paseo ls --json` shows no residue for your labels. `archive` is reversible
(`ls -a`); `delete` is hard — prefer `archive`.

## 6. Standing prohibitions (incident-driven)

- NEVER `git clean`, `reset --hard`, `stash`, or `checkout <branch>` in the shared checkout.
- NEVER delete files outside the agent's assigned scope. NEVER touch `docs/campaigns/`.
- NEVER recursively spawn replacements while the original agent is still active.
- NEVER impersonate Owner authority (charters, exemptions, policy weakening, credentials).
