---
name: engineering-workflow
purpose: Turn a natural-language engineering request or existing GitHub issue into the correct Harness workflow while keeping the lead agent as semantic owner.
---

# Engineering Workflow

You are the engineering lead entrypoint. The user may be operating from Paseo mobile and should not need to know Harness commands.

## Entry protocol

1. Identify the repository root and read `AGENTS.md`, `.harness/project.yaml`, `.harness/agents.source.jsonc`, relevant architecture docs and current Git state.
2. Run `aeh agents check` before delegation. If the topology is invalid, stop and report the deterministic failure.
3. If the user explicitly asks to implement an existing GitHub issue (`issue #123`, `#123`, or an issue URL), use the **Issue-driven path** below. Do not manually recreate the issue as a new SDD request first.
4. Otherwise inspect relevant code, Graphify structure when available, and advisory memory. Git/specs/tests remain authoritative.
5. Build triage evidence: bounded file scope, affected domains, risk, and escalation flags.
6. Run `aeh triage "<request>" --file ... --domain ... --risk ...`.
7. Follow the Harness decision. Do not downgrade SPEC to QUICK manually.

## Issue-driven path

For an existing GitHub issue, the issue is an **input source**, not mutable normative truth during execution.

1. Run `aeh issue inspect <number>` when you need to surface intake classification/evidence before execution.
2. Normally start the complete workflow with `aeh issue implement <number>` (equivalent entry: `aeh run --issue <number>`).
3. The Harness fetches the issue from the repository associated with the current project, freezes title/body into `.harness/issues/GH-<number>.json`, computes a SHA-256 content fingerprint, and rejects PR numbers masquerading as issues.
4. The Harness deterministically extracts labels, likely domains, paths and acceptance statements. Non-trivial issues are normalized by the configured read-only planner against repository evidence. The planner may derive implementation details from the repository but must not invent product decisions.
5. The normalized intake is deterministically materialized as either:
   - a bounded QuickContract when QUICK safety rules are satisfied; or
   - a complete SDD/TaskContract with requirement IDs, design/tasks and acceptance traceability.
6. The generated TaskContract/SDD plus frozen issue snapshot are sealed. From this point they are normative for the run; later edits to the GitHub issue cannot silently change the active task.
7. The existing issue is seeded into the delivery record, so handoff must **reuse it**, never create a duplicate issue. If delivery is enabled, the Harness reuses/creates the issue-linked branch and Paseo worktree, materializes sealed context there, then runs the normal implementation/validation/review lifecycle.
8. Before every run of an issue-derived contract, the Harness re-fetches issue title/body and compares the content SHA. `ISSUE_DRIFT` blocks silent execution on changed requirements.
9. If `ISSUE_DRIFT` occurs before implementation, inspect the change and use `aeh issue import <number> --refresh` when the new issue text should become authoritative. If an active delivery workspace already exists, do not overwrite it casually; the Harness requires explicit `--force` for refresh.
10. `SPEC_CONTRADICTION` and `REQUIRES_PRODUCT_DECISION` remain human-on-exception outcomes. Ordinary missing implementation detail should be resolved from repository evidence by planner/oracle rather than escalated to the user.

## QUICK path

Use QUICK only when the Harness returns QUICK.

1. Create a QuickContract with explicit scope and observable acceptance:
   `aeh quick new <id> --title "..." --request "..." --scope <paths...> --acceptance "..." --domain <domains...>`
2. Run `aeh quick validate <id>`.
3. Run `aeh run <id>` with the desired profile.
4. Remain the lead; do not perform delegated implementation yourself unless recovery explicitly escalates to the lead.
5. Inspect the final deterministic report. Agent reviews are skipped for QUICK by default unless project policy enables them.

## SPEC path

1. Run `aeh sdd new <id> --title "..."`.
2. Complete proposal, spec, design, tasks and executable acceptance/Gherkin as appropriate.
3. Ensure stable requirement IDs and validator traceability.
4. Run `aeh sdd validate <id>`.
5. Run `aeh run <id>` with the appropriate profile.
6. The Harness owns delegation, deterministic validation, repair, quality convergence, reviewer waves, regression rollback, agent/model escalation, autonomous replanning and final lead acceptance.

## Quality convergence

Do not stop or ask the user because a remediation round count has been reached. Review remediation is governed by the Final Quality Gate, not a maximum number of rounds.

Default quality weights use integer DebtPoints: critical=300, high=75, medium=24, low=3, note=1. Therefore three notes equal one low and DebtScore is DebtPoints/3. Final acceptance requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3.

When quality is improving, continue autonomously. When it stagnates, regresses or cycles, allow the Harness to change strategy, escalate from the workhorse to stronger agents/models, diagnose root cause and replan. A remediation that worsens deterministic validation or review debt is rolled back before the next strategy is attempted.

## Human-on-exception

Human intervention is the final exception path, not a routine review step. Request a human decision only when the Harness identifies one of these states:

- `SPEC_CONTRADICTION`: authoritative requirements cannot all be satisfied.
- `REQUIRES_PRODUCT_DECISION`: the repository/spec/issue cannot determine a required business/product choice.
- `BLOCKED_EXTERNAL`: a required credential, account permission or external resource is unavailable to the agents.
- `ISSUE_DRIFT`: a frozen issue's title/body changed after intake and accepting that new intent requires an explicit refresh decision once implementation state exists.

Implementation defects, review debt, regressions, cycles, invalid strategies and ordinary tool failures stay inside autonomous recovery/escalation whenever possible.

## Triage escalation rules

Treat architecture, authentication/authorization/security, tenant isolation, schema/migrations, public API compatibility, new dependencies, cross-module refactors, ambiguous requirements and medium/high risk as SPEC. A QuickContract must never be used to bypass these boundaries.

If a QUICK implementation later reveals one of these conditions, stop the quick change and escalate to a new SPEC workflow rather than broadening the QuickContract.

## Mobile/Paseo behavior

When started as a Codex lead inside Paseo, remain the parent session. Use the Harness as the control layer and allow it to spawn routed OpenCode/Codex work through the configured transports. For `implement issue #X`, prefer `aeh issue implement X`; that command owns intake, freeze, optional handoff/worktree and execution. Surface only meaningful status, deterministic failures that cannot self-recover, permission requests, true human-on-exception states and final acceptance to the user. Do not surface every remediation round as a request for approval.

## Self-modification

If the repository being modified is the Harness itself or the task changes `.harness/agents.source.jsonc`, skills, policies, validators or orchestration rules, the run is governed by the controller/topology that existed at run start. New control-plane rules become active only on a subsequent run after validation/merge.
