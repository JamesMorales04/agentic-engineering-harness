# Durable operation supervision

AEH separates the user-facing conversation from operation-local semantic work and deterministic lifecycle authority.

## Responsibility hierarchy

```text
User
  |
AEH Lead                         user / portfolio plane
  |
  +-- Operation A Supervisor     one semantic operation context
  |      +-- planner
  |      +-- implementers
  |      +-- reviewers
  |      `-- oracle / remediation
  |
  +-- Operation B Supervisor
  |      `-- ...
  |
  `-- Operation C Supervisor

Deterministic controller + OperationRecord run across the hierarchy.
```

The lead owns user intent, priorities, cross-operation dependencies, true exception decisions and final user-facing acceptance. The lead should not multiplex every child-agent timeline.

The operation supervisor owns semantic coordination and consolidation for one operation. It may merge semantically duplicate findings, identify conflicts and request bounded follow-up, but it cannot overrule deterministic state, validation or normative artifacts.

The controller owns lifecycle, stage transitions, participant state, seals, validators, rollback, quality gates, delivery and terminalization. `OperationRecord` is the durable source of lifecycle truth.

## OperationRecord v2

Every detached operation has `.harness/operations/<id>.json` with:

- `revision` and `lastProgressAt`;
- `lead` binding/generation/acknowledged revision;
- supervisor generations (`ACTIVE`, `DRAINING`, `ARCHIVED`);
- stage state;
- bounded participants and parent supervisor generation;
- compact progress counts;
- wake/delivery metadata;
- final result pointers.

Large content is externalized:

```text
.harness/operations/<id>/
  events.ndjson
  agents/*.json
  consolidations/*.json
  supervisors/*.json
```

The three durable layers have different meanings:

- OperationRecord: current state snapshot.
- events.ndjson: how the operation reached that state.
- AuditReport/RunResult/agent/consolidation artifacts: evidence and final products.

Agent conversation history is not required to reconstruct an operation.

## Revision and acknowledgement

Meaningful durable progress increments `revision`. A lead wake being accepted by Paseo is not considered consumption of the result. The currently bound lead must read `aeh_operation_status`, which acknowledges that exact durable revision.

This distinction prevents the failure mode:

```text
operation terminal
  -> prompt accepted by Paseo
  -> lead turn/provider/UI fails before result is read
  -> operation appears delivered forever
```

The detached monitor continues until the terminal revision is acknowledged, and re-wakes the lead after the configured interval when necessary.

## Layered liveness

AEH deliberately does not depend on one messaging channel:

1. Paseo parent/child notifications are a fast lifecycle signal.
2. Terminal completion send uses bounded retry.
3. A detached non-LLM monitor observes durable state after the controller can exit.

The monitor wakes on:

- unseen meaningful progress after the quiet interval;
- blocked state;
- lack of durable progress beyond the stall threshold;
- terminal state not acknowledged by the current lead.

A stall targets the operation supervisor first. Missing/busy/unreachable supervisor recovery escalates to the lead.

Healthy non-terminal progress wakes are internal. They should not generate chat noise.

## Supervisor context generations

Supervisors are proactively replaced rather than compacted as their canonical Paseo context approaches the configured handoff threshold.

```text
generation N ACTIVE
  -> durable supervisor checkpoint
  -> generation N DRAINING
  -> generation N+1 ACTIVE
```

No live child is reparented. Children already running under generation N remain there. New children use N+1. Once every child tied to N is terminal, AEH archives N. An archive failure remains visible instead of being represented as success.

The new generation recovers from OperationRecord + supervisor checkpoint + relevant artifacts, not transcript replay.

Lead rotation follows the same durability principle: active operations and completion targets are rebound to the new lead generation.

## Paseo parentage

For managed Paseo execution, AEH supplies the active supervisor as the top-level `parent` create option for bounded operation agents. The supervisor itself may be parented to the current lead.

Parentage is useful for UI hierarchy, lifecycle notification and operation-local ownership. It is not workflow authority. OperationRecord remains authoritative because parent relationships/runtime processes can be archived, replaced or lost independently of durable execution state.

## Workspace isolation and concurrent operations

A lead may own multiple concurrent operations. The compact project portfolio is stored at `.harness/operations/portfolio.json` and is available through `aeh_operation_portfolio` / `aeh operation portfolio`.

AUDIT is read-only and may use a local orchestration workspace.

RUN/CHANGE are mutating and must execute in an isolated worktree unless an explicit existing delivery workspace already owns isolation. AEH fails closed rather than running concurrent mutating operations against the same checkout.

Operations store both the repository control root and the isolated execution root. `AEH_CONTROL_ROOT` ensures every child updates the same durable OperationRecord even when executing from another worktree.

## Workflow mapping

### AUDIT

```text
Operation created
  -> supervisor materialized
  -> reviewers parented to supervisor
  -> deterministic validation evidence
  -> reviewer artifacts
  -> supervisor semantic consolidation
  -> exact source-finding provenance validation
  -> deterministic dedupe / quality gate
  -> AuditReport
  -> terminal revision
  -> lead acknowledgement
```

### CHANGE / SPEC

CHANGE begins before discovery so explorer/planner/spec-manager cannot become orphan conversational branches.

```text
CHANGE Operation
  -> discovery/planning evidence when required
  -> deterministic QUICK/SPEC triage
  -> QuickContract OR OpenSpec authoring + deterministic compile
  -> seal
  -> implementation
  -> validation
  -> review/remediation/oracle/replan
  -> delivery
  -> terminal state
```

SPEC manager authors OpenSpec inside the existing operation and must not start another AEH workflow. Deterministic AEH compilation/sealing remains normative.

### QUICK

A single-worker QUICK can remain cheap and deterministic. A supervisor is materialized lazily when reviewer fan-out, semantic consolidation, remediation/escalation or another operation-local coordination requirement appears.

### Prepared RUN

A prepared task enters the same supervised state machine. SPEC/complex RUN materializes supervision before planner waves. QUICK follows the lazy policy above.

## Managed-operation final acceptance

The review lifecycle must not create a hidden second orchestrator and treat it as the user-facing lead. After deterministic quality acceptance in a managed operation, terminal durable state returns to the actual lead bound in OperationRecord. That lead performs final user-facing semantic acceptance.

Synchronous compatibility execution outside a managed operation may retain the legacy orchestrator-acceptance path.

## Concurrency policy

Configuration may bound:

- active operations per lead/project;
- active agents project-wide;
- agents per operation;
- provider-specific concurrent agents.

Capacity exhaustion queues/rejects new work rather than sacrificing isolation or deterministic semantics.

## Failure containment

An operation supervisor failure affects one operation, not the entire lead portfolio. A supervisor can rotate without replacing the lead, and a lead can rotate without discarding active operations. Durable state therefore limits the blast radius of provider/model/context/runtime failure.

The design rule is:

> LLMs own semantics; deterministic state owns facts; no single agent or message is required to reconstruct or continue the workflow.
