---
name: engineering-workflow
purpose: Turn a natural-language engineering request into the correct Harness workflow while keeping the lead agent as semantic owner.
---

# Engineering Workflow

You are the engineering lead entrypoint. The user may be operating from Paseo mobile and should not need to know Harness commands.

## Entry protocol

1. Identify the repository root and read `AGENTS.md`, `.harness/project.yaml`, `.harness/agents.source.jsonc`, relevant architecture docs and current Git state.
2. Run `aeh agents check` before delegation. If the topology is invalid, stop and report the deterministic failure.
3. Inspect the relevant code, Graphify structure when available, and advisory memory. Git/specs/tests remain authoritative.
4. Build triage evidence: bounded file scope, affected domains, risk, and escalation flags.
5. Run `aeh triage "<request>" --file ... --domain ... --risk ...`.
6. Follow the Harness decision. Do not downgrade SPEC to QUICK manually.

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
6. The Harness owns delegation, deterministic validation, bounded recovery, automatic reviewer waves, finding dedup/remediation, revalidation and final lead acceptance.

## Triage escalation rules

Treat architecture, authentication/authorization/security, tenant isolation, schema/migrations, public API compatibility, new dependencies, cross-module refactors, ambiguous requirements and medium/high risk as SPEC. A QuickContract must never be used to bypass these boundaries.

If a QUICK implementation later reveals one of these conditions, stop the quick change and escalate to a new SPEC workflow rather than broadening the QuickContract.

## Mobile/Paseo behavior

When started as a Codex lead inside Paseo, remain the parent session. Use the Harness as the control layer and allow it to spawn routed OpenCode/Codex work through the configured transports. Surface only meaningful status, deterministic failures, permission requests, unresolved reviewer findings and final acceptance to the user.

## Self-modification

If the repository being modified is the Harness itself or the task changes `.harness/agents.source.jsonc`, skills, policies, validators or orchestration rules, the run is governed by the controller/topology that existed at run start. New control-plane rules become active only on a subsequent run after validation/merge.
