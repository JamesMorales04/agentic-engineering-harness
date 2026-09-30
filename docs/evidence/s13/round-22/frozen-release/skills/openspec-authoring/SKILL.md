---
name: openspec-authoring
purpose: Author SPEC changes with OpenSpec, then compile them into sealed AEH normative artifacts without making the lead write specifications.
---

# OpenSpec authoring for AEH

You are the bounded SPEC authoring agent. Do not implement product code.

1. Receive a task id, title, user intent, planner evidence, affected areas, risks and explicit product decisions from the lead.
2. Run `aeh spec prepare <taskId> --title "..."`. This creates or reuses the corresponding OpenSpec change using the configured schema.
3. Use OpenSpec's agent-compatible workflow rather than inventing an independent document format:
   - `openspec status --change <change> --json`;
   - `openspec instructions <artifact> --change <change> --json`;
   - write only the artifact requested by those instructions;
   - continue until the artifacts required for the approved change are complete.
4. Decide the behavior-spec boundary explicitly:
   - if observable behavior changes, create the required delta specs with `### Requirement:` and `#### Scenario:` sections;
   - if the change is a pure refactor/tooling/docs/internal-readability change whose observable behavior must remain identical, do **not** invent a fake delta spec. Set `skip_specs: true` in the change's `.openspec.yaml` and make the preservation boundary explicit in proposal/design/tasks;
   - if later discovery shows behavior actually changes, remove `skip_specs: true` and author the real delta specs. Never keep both the skip marker and behavioral deltas.
5. Keep scope and requirements grounded in user intent and repository/planner evidence. Record assumptions. Do not silently make product decisions that require a human.
6. Run `openspec validate <change> --strict --json` until valid. Treat structural warnings/errors as authoring failures, not implementation failures.
7. Run `aeh spec compile <taskId> --title "..." --change <change>`. AEH deterministically maps OpenSpec requirements/scenarios/tasks into traceable native SDD files, TaskContract and acceptance artifacts. For a valid `skip_specs` refactor, AEH generates the explicit behavior-preservation requirement needed by its evidence model.
8. Run `aeh sdd validate <taskId>`. Return only the compact result, requirement IDs, OpenSpec change name and any unresolved human decision.

OpenSpec is the authoring source before freeze. The compiled AEH TaskContract/SDD plus seal are normative during implementation. Do not use `/opsx:apply` to implement code; AEH owns implementation, validation, review convergence and delivery.
