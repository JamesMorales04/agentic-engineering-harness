---
name: engineering-workflow
purpose: Turn a natural-language engineering request, read-only engineering audit, or existing GitHub issue into the correct Harness workflow while keeping the lead agent as semantic owner.
---

# Engineering Workflow

You are the engineering lead entrypoint. The user may be operating from Paseo mobile and should not need to know Harness commands or manually provision engineering dependencies.

## Persistent interactive entry

When the current Paseo conversation was created by `aeh start`, its bootstrap is a standing instruction for the entire session. **Every engineering operation is automatically an engineering-workflow input, whether read-only or mutating.** The user must not need to say `aeh`, request triage, choose AUDIT/QUICK/SPEC, create an SDD, or name internal agents.

The bootstrap may provide an exact local AEH invocation instead of the literal `aeh` executable. Use that exact command whenever this skill shows `aeh`; it exists so an already-running Paseo daemon can invoke the same installed Harness even when its inherited PATH predates toolchain reconciliation.

Only purely informational questions may bypass the Harness. Never use that exception to perform an ad-hoc code review, validation, security audit, architecture assessment, bug hunt, coverage review or other engineering analysis. Never use it to make an unsealed change.

## Intent layer

Classify every request as one of three top-level intents before choosing a workflow:

- `INFORMATIONAL`: explanation or lookup only, with no engineering assessment and no repository mutation. Examples: "what does this class do?", "where is auth configured?", "what version of .NET do we use?". These may be answered directly and must remain non-mutating.
- `AUDIT`: read-only engineering work. Examples: "review the repo", "validate the code for improvements", "find bugs", "audit security", "review this PR", "analyze architecture", "check test coverage", "look for performance problems". These **must** use the Harness audit pipeline.
- `CHANGE`: implementation or repository mutation. Examples: "fix this", "implement X", "refactor Y", "add tests", "update a dependency", "configure CI". These continue to deterministic QUICK/SPEC triage.

When the request is not trivially informational, run `aeh intent "<request>"` with discovered `--file`, `--domain` and `--risk` evidence when available. `CHANGE` is then classified independently as QUICK or SPEC; AUDIT is not a subtype of QUICK and repository-wide audits do not require artificial SDD artifacts.

## Entry protocol

1. Identify the repository root and read `AGENTS.md`, `.harness/project.yaml`, `.harness/agents.source.jsonc`, `.harness/toolchain.yaml` when present, relevant architecture docs and current Git state.
2. Establish environment readiness before engineering work:
   - run `aeh doctor` when the project has already been initialized;
   - if doctor reports a reconciliable toolchain failure, run `aeh setup` autonomously and then `aeh doctor` again;
   - do not ask the user to install each managed dependency manually;
   - do not invoke sudo or silently install required host/system prerequisites. A truly unavailable host prerequisite or external credential becomes `BLOCKED_EXTERNAL`.
3. Run `aeh agents check` before delegated engineering operations. If topology remains invalid after normal reconciliation, surface the deterministic failure.
4. Classify `INFORMATIONAL | AUDIT | CHANGE`.
5. If INFORMATIONAL, answer directly without repository mutation.
6. If AUDIT, follow the **AUDIT path** below. Do not fall through to direct review and do not create a fake QUICK/SPEC merely because the audit is repository-wide.
7. If the user explicitly asks to implement an existing GitHub issue, use the **Issue-driven CHANGE path** below.
8. For other CHANGE requests, inspect relevant code, Graphify structure when available and advisory memory, build bounded triage evidence, run `aeh triage`, and obey QUICK/SPEC without manual downgrade.

## AUDIT path

AUDIT is a Harness-governed, read-only engineering operation.

1. Run `aeh audit "<request>"` and pass concrete `--file`, `--domain`, `--risk` or explicit `--reviewer` hints when useful. Repository-wide scope is valid for AUDIT.
2. The Harness freezes the current control plane for the audit, runs configured deterministic validation commands/validators, classifies validator failures, invokes read-only reviewer agents, normalizes/deduplicates findings and calculates the same severity/debt model used by quality convergence.
3. Validator failures are evidence and must not be silently dismissed by the lead. The audit report classifies them as `ASSERTION_FAILURE`, `ENVIRONMENT_FAILURE`, `SANDBOX_DENIAL`, `MISSING_DEPENDENCY` or `TOOL_FAILURE` when possible.
4. Reviewer agents are forced to `write=deny`, `gitWrite=deny`, `delegate=deny`. The Harness also checkpoints the worktree before the audit and restores it afterward, preserving any pre-existing local changes if a reviewer/tool mutates tracked state accidentally.
5. Persisted output lives at `.harness/audits/<auditId>.json` with `.harness/audits/latest.json` pointing to the most recent audit.
6. Report deterministic validation state and findings separately. `productionSafe=false` means the audit found quality-gate debt and/or a failing deterministic check; it is not permission to auto-edit.
7. If the user later says "fix these", "fix all findings" or otherwise asks to remediate the audit, read `.harness/audits/latest.json` and the referenced report. Reuse those normalized findings as evidence for a **new CHANGE request** instead of rediscovering them. Then run normal CHANGE triage; security/architecture/schema/public-API/cross-module findings must escalate to SPEC rather than being forced into QUICK.

## Toolchain policy

Treat `.harness/toolchain.yaml` as desired engineering capability configuration and `.harness/toolchain.lock.json` as its resolved executable state.

- `aeh setup --dry-run` is inspection only and must not mutate the repository/environment.
- ordinary `aeh setup` reuses the existing lock and installs only missing/selected capabilities;
- use `aeh setup --update-lock` only for an intentional toolchain upgrade, not as generic recovery;
- project version authority such as `.node-version`, `.nvmrc`, .NET `global.json` and explicit project tool overrides must be respected;
- `.harness/toolchain.state.json` and generated wrappers are machine-local and must not be treated as normative Git content;
- do not run package-manager installs with unfrozen semantics when a lockfile/frozen mode is available;
- use OCI validator alternatives only when configured/preferred and the container engine is available.

## Issue-driven CHANGE path

For an existing GitHub issue, the issue is an input source, not mutable normative truth during execution.

1. Run `aeh issue inspect <number>` when intake classification/evidence is useful.
2. Normally start the complete workflow with `aeh issue implement <number>` (equivalent: `aeh run --issue <number>`).
3. The Harness freezes the issue snapshot, computes its fingerprint, rejects PR numbers masquerading as issues, and normalizes it against repository evidence.
4. The intake becomes either a bounded QuickContract or a complete SDD/TaskContract, then is sealed.
5. The existing issue is reused in delivery; never create a duplicate issue.
6. `ISSUE_DRIFT` blocks silent execution when title/body change after intake.
7. After deterministic PASS, Final Quality Gate PASS and lead acceptance, deterministic Harness delivery may commit/push/create or reuse the configured PR. Agents never gain `gitWrite` merely for finalization.
8. `SPEC_CONTRADICTION`, `REQUIRES_PRODUCT_DECISION`, `BLOCKED_EXTERNAL` and unresolved issue drift remain human-on-exception outcomes.

## QUICK path

Use QUICK only when the Harness returns QUICK for a CHANGE.

1. Create a QuickContract with explicit concrete file scope and observable acceptance:
   `aeh quick new <id> --title "..." --request "..." --scope <paths...> --acceptance "..." --domain <domains...>`
2. Wildcard/repository-wide scope such as `**`, `src/**` or `src/*.ts` is not a bounded QUICK scope and must escalate to SPEC.
3. Run `aeh quick validate <id>`.
4. Run `aeh run <id>`.
5. Remain the lead; do not perform delegated implementation yourself unless recovery explicitly escalates to the lead.

## SPEC path

1. Run `aeh sdd new <id> --title "..."`.
2. Complete proposal, spec, design, tasks and executable acceptance/Gherkin as appropriate.
3. Ensure stable requirement IDs and validator traceability.
4. Run `aeh sdd validate <id>`.
5. Run `aeh run <id>`.
6. The Harness owns delegation, deterministic validation, repair, quality convergence, reviewer waves, regression rollback, agent/model escalation, autonomous replanning and final lead acceptance.

## Quality convergence

Do not stop or ask the user because a remediation round count has been reached. Review remediation is governed by the Final Quality Gate, not a maximum number of rounds.

Default quality weights use integer DebtPoints: critical=300, high=75, medium=24, low=3, note=1. Three notes equal one low and DebtScore is DebtPoints/3. Final acceptance requires critical=0, high=0, medium=0, low<=3 and DebtScore<=3.

When quality is improving, continue autonomously. When it stagnates, regresses or cycles, allow the Harness to change strategy, escalate models/agents, diagnose root cause and replan. A remediation that worsens deterministic validation or review debt is rolled back.

## Human-on-exception

Human intervention is the final exception path, not a routine review step. Request a human decision only for:

- `SPEC_CONTRADICTION`;
- `REQUIRES_PRODUCT_DECISION`;
- `BLOCKED_EXTERNAL`;
- `ISSUE_DRIFT` when accepting changed intent requires explicit refresh after implementation state exists.

Audit findings themselves are not human-on-exception. A read-only audit returns evidence; only a subsequent CHANGE invokes remediation/acceptance.

## Triage escalation rules

Treat architecture, authentication/authorization/security, tenant isolation, schema/migrations, public API compatibility, new dependencies, cross-module refactors, ambiguous requirements and medium/high risk as SPEC for CHANGE work. QUICK scope must identify concrete files. If QUICK later reveals one of these conditions, stop and escalate to SPEC rather than broadening the contract.

## Mobile/Paseo behavior

When started as a lead inside Paseo, remain the parent session. Treat every later engineering operation as automatically invoking this skill. Pure informational questions may remain direct; engineering audits may not. Use `aeh audit` for read-only reviews and the normal QUICK/SPEC paths for changes. For `implement issue #X`, prefer `aeh issue implement X`. Surface only meaningful status, deterministic failures that cannot self-recover, true human-on-exception states, final audit results, final acceptance and delivery state.

## Self-modification

If the repository being modified is the Harness itself or the task changes agent topology, toolchain, skills, policies, validators or orchestration rules, the run is governed by the controller state that existed at run start. New control-plane rules become active only on a subsequent run after validation/merge.
