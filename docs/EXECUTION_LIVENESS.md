# Execution liveness and recovery

AEH controls participant work with identity-bound progress evidence and separate
deadlines. A participant may run through many provider turns while it makes
verifiable progress. A provider turn timeout stops that turn; it does not by
itself terminalize the operation. The watchdog asks the operation Supervisor to
recover before escalating to the Lead.

## Authority path

```text
Participant → Operation Supervisor → Lead → Human Owner
```

Participants can continue within their frozen blueprint. The controller records
provider-turn and tool activity and renews a progress lease only from current,
identity-bound evidence. The Supervisor can renew or record a bounded recovery
decision through `aeh_supervisor_recovery_decide`. The Lead can renew within the
Owner-delegated hard envelope through `aeh_operation_recover_participant`.
Both operations require the exact participant binding and current activity
evidence. A changed candidate, policy, controller epoch, generation, or session
rejects the action.

The current participant recovery adapter applies continuation, exact compatible
same-session resume, one bounded same-session retry, skill retrieval, and
participant failure. Session rotation and WorkGraph changes (`REPLAN`, `SPLIT_WORK`,
`REASSIGN`) are durably requested by the Supervisor. The controller then fails
and cleans the parent operation, after which the Lead may start one explicit
linked child operation with inherited policy and the original hard deadline.
That child compiles a fresh participant plan and provider session. The controller
never starts the child on its own; the Lead must decide whether to proceed and
provide durable request causality.

Supervisor decisions and Operations Analyst findings are separate. The Analyst
uses `SemanticAssessmentServiceV1` for bounded semantic diagnosis and produces
an `ADVISORY_ONLY` artifact. Its output cannot renew a lease, select a tool,
change budgets or policy, accept a candidate, or alter delivery. A skill
projection is guidance only; the frozen ToolPack and execution binding remain
the source of tool authority.

`HUMAN_REQUIRED` is reserved for a concrete Owner decision or authority
boundary. A stall or uncertainty alone does not meet that condition. When the
Lead cannot continue within the frozen Owner boundary, the Lead receives the
exact boundary error and must obtain the Owner's decision before any policy
change.

## State and progress evidence

Participant state is persisted in `OperationRecord.participants[].executionLiveness`.
Meaningful progress is derived deterministically from controller observations:

| Level | Evidence | Lease effect |
| --- | --- | --- |
| HIGH | Source mutation, candidate revision, test or validation result, artifact, resolved blocker, accepted structured result | Can renew from the controller's verified event path |
| MEDIUM | New retrieval, non-redundant successful tool call, dependency discovery, executable WorkGraph advancement | Can renew from the controller's verified event path |
| LOW | Provider heartbeat, reasoning activity, equivalent tool call, repeated read | Recorded; never renews the lease |

Every event binds the operation, candidate, policy, controller epoch,
participant generation, role, phase, provider, model, and actual session. Paseo
timeline arguments are reduced to a digest and byte length. Repeated event IDs
are idempotent.

## Default limits and owners

Values below are defaults in `.harness/project.yaml`; project configuration is
frozen into each operation policy at start. They are independent limits, not a
single task timeout.

### Limit classes

- **SEMANTIC CONTRACT:** Planner WorkUnit objectives stay at or below 500 characters. The canonical WorkGraph schema, Planner/provider contract, prompt, and one bounded corrective pass share that rule; invalid output fails planning rather than widening the contract.
- **PROVIDER BOUNDARY:** the 30-minute provider-turn deadline bounds one provider call. Its timeout is recoverable evidence and does not itself fail the operation.
- **RESOURCE SAFETY:** the eight-hour root hard deadline, tool-specific deadlines, provider initialization/coordination deadlines, and cleanup receipts bound process and workspace lifetime. Expiry terminates and reconciles owned resources, then requires a distinct Owner request before a new execution root can replace work from the expired Owner turn.
- **ECONOMIC SAFETY:** frozen per-participant provider-turn ceilings and operation-wide tool/token/cost ceilings limit Owner-delegated spend. Supervisor and Lead renew only within their distinct authority; a provider-turn ceiling stalls that participant for recovery, while hard operation-wide tool/token/cost boundaries create an economic `HUMAN_REQUIRED` request.
- **PROGRESS / LIVENESS:** the 15-minute meaningful-progress lease and bounded watchdog wake budgets find stalls early; LOW heartbeats do not renew the lease.
- **IMPLEMENTATION ACCIDENT REMOVED:** `orchestration.worker.timeoutSeconds` used to conflate task lifetime with one worker timeout. It now fails with an explicit migration error; callers must configure execution liveness and operation economic policy instead.

| Limit | Default | Owner and purpose | At the limit | Recovery |
| --- | ---: | --- | --- | --- |
| Operation hard deadline | 8 hours | Deterministic controller; final resource and runaway fuse | Operation fails with a durable `OwnerContinuationBoundaryV1` and terminal cleanup reconciles owned resources | A linked child inherits the expired root deadline and is rejected; Lead starts remain blocked until an explicit Owner-authorized CLI start |
| Meaningful-progress lease / stall window | 15 minutes | Controller and Supervisor; detects inactivity before the hard fuse | `STALL_SUSPECTED`; Supervisor is woken even if the participant runtime still says active | Continue, resume, retry, replan, split, reassign, fail, or escalate within policy |
| Provider turn deadline | 30 minutes | Provider adapter; bounds one provider turn | Turn returns timeout evidence and the provider turn is stopped | Operation may continue in another bounded turn if policy and recovery allow |
| Default tool deadline | 30 minutes | Controller/tool owner; bounds an individual long tool call | Tool wait expires independently of participant liveness | Supervisor retries or reassigns within its retry budget |
| Supervisor initialization turn | 120 seconds | Supervisor bootstrap; cold-session readiness barrier | Initialization attempt fails closed | One bounded initialization retry, then controller escalation |
| Supervisor semantic turn | 300 seconds | Supervisor adapter; bounds one coordination response | Supervisor generation fails closed | A current compatible generation is rematerialized or Lead is woken |
| Initial provider-turn allowance | 8 turns per participant record | Frozen economic envelope | At 80%, Supervisor records and analyzes that participant's budget pressure without asking the Owner | Supervisor may renew that participant within its 12-turn delegation |
| Supervisor provider-turn ceiling | 12 turns per participant record | Owner-delegated Supervisor authority | Renewal is rejected above that participant's ceiling | Lead may renew that participant within the 16-turn hard envelope |
| Provider-turn hard envelope | 16 turns per participant record | Owner-delegated per-participant ceiling | Another turn for that participant is rejected and the participant stalls | Supervisor/Lead may request bounded rotation or WorkGraph recovery; a linked child gets a fresh participant identity under the same operation-wide token/cost/tool remainder and root hard deadline |
| No-progress renewals | 2 | Frozen liveness policy; prevents repeated lease extension on heartbeats | Further no-progress renewal is rejected | New HIGH/MEDIUM evidence or a materially different recovery action is required |
| Local retry / participant restart | 1 per participant generation / 2 | Frozen retry policy | Further retry or restart is rejected | Supervisor replans/reassigns or escalates |
| `npm ci` / project dependency setup | Tool deadline, 30-minute default | Toolchain controller; independent command resource bound | Process is terminated after streaming full output digests and bounded tails | Diagnose compiler/install/environment failure before an allowed retry |
| CLI operation wait | 30 minutes by default (`aeh operation wait --timeout` overrides the client wait) | CLI caller; bounds how long a foreground command polls | The CLI returns a wait-timeout error; the durable operation and controller continue | Query durable operation status or use an explicit cancellation; this is not a participant or operation deadline |
| Watchdog wake budget | 2 Supervisor opportunities, then 1 Lead wake per revision | Deterministic watchdog; prevents repeated coordination dispatch loops | Duplicate wakes are suppressed; the operation stays durable and its liveness/hard deadline still applies | A later revision or terminal result may trigger a new bounded wake |
| Configured validation command | 900 seconds by default unless the command/provider specifies another deadline | Controller-owned validator/tool adapter | Command is terminated and command diagnostics are persisted | Retry only through the bounded repair/recovery policy after diagnosing the failure |

Provider-turn count, token use, cost, and tool calls are recorded only when
evidence exists. An unreported value remains unknown. AEH does not treat unknown
provider usage as zero. There is no default USD cap; if an Owner configures a
hard cost ceiling, incomplete cost coverage cannot be represented as proof that
the ceiling was respected.

When a configured Owner hard token, cost, or tool-call boundary
is reached, the controller writes a candidate/policy/session-bound
`OwnerEconomicBoundaryRequirementV1`, enters `HUMAN_REQUIRED`, and stops the
bound Paseo session. The operation then terminalizes as failed with its evidence
preserved and owned resources reconciled. The Lead reports the exact boundary;
it cannot enlarge the ceiling. Continuing requires a fresh explicit Owner
authorization under a newly approved policy. A Lead cannot start any operation
while that boundary is waiting; the Owner must review/update policy and invoke a
new CLI-authorized operation naming the exact operation with
`--resolve-operation <operationId>`. The resulting `OperationOriginV1` records
the boundary digest it resolved. An unrelated CLI start does not clear this
boundary. For an economic boundary, the project must also change the specific
hard limit before the controller accepts that resolution. AEH does not silently
spawn a replacement or infer Owner consent from a new Lead turn.

Per-participant provider-turn exhaustion is different: it stalls the participant
and gives Supervisor/Lead a bounded opportunity to rotate, replan, split, or
reassign under policy. It does not create an economic Owner boundary. If the
independent operation hard deadline expires, the controller records an
`OwnerContinuationBoundaryV1`, fails and cleans the operation, and tells the
Lead to wait. A recovery callback is not a new task: linked recovery is rejected
after expiry, and all Lead-started operations remain blocked while the boundary
is unresolved. `userTurnId` in model-produced intent is descriptive and cannot
prove Owner authority. A fresh root requires an explicit Owner-authorized CLI
start naming the exact expired operation with `--resolve-operation
<operationId>`; that flag cannot be invoked from a managed Lead session. The
root origin records the exact boundary digest. The Lead start path
also checks active operation deadlines and durably expires overdue operations
before creating a new root, even if the watchdog has not run yet.

Cancelling an operation does not clear a pending Owner economic boundary.
Cancellation authorizes stopping and cleanup, not resetting the budget. The
boundary remains durable and blocks Lead starts until the Owner changes the
policy and explicitly authorizes a fresh operation.

The control plane blocks a linked child and any Lead-started root while that
Owner request is waiting. A recovery child binds a digest of
the terminal parent's economic-usage snapshot and receives only the remaining
configured operation-wide token, cost, and tool-call ceilings. Unknown or
exhausted parent usage rejects the linked child. Per-participant provider-turn
ceilings are applied to each fresh child participant as described below.

An ordinary failed operation also remains a pending task until a causally
linked recovery succeeds. A Lead cannot omit `continuation.operationId` to
create a new root with fresh budgets or deadline. If no bounded linked recovery
remains, the Lead reports the failure and waits. The Owner must name that exact
failed chain with `--resolve-operation <operationId>` to authorize a fresh
root; an unrelated CLI task does not reset its chain budget.

Paseo does not guarantee interim reasoning heartbeats on every SDK transport, so
AEH does not infer provider failure from silence alone. The meaningful-progress
window wakes the Supervisor while a turn runs; the separate provider-turn
deadline bounds a turn that never completes.

Provider-turn allowance and enforcement are **per durable participant record**:
each participant's counter is checked independently against the frozen initial,
Supervisor, and hard ceiling. Turns are summed only for operation reporting;
participants do not consume one shared turn pool. In
`OperationEfficiencySummaryV2`, `budgets.providerTurns.scope` is
`PER_PARTICIPANT`, the `*PerParticipant` fields show each frozen ceiling, and
the `*AggregateEquivalent` fields multiply that ceiling by the summary's
`participantCount`. `currentAllowanceAggregate` is the sum of current
participant allowances when all participant liveness records are available.
These aggregate-equivalent fields describe the captured participant population;
they do not create or enforce an operation-wide shared ceiling.

## Command and candidate diagnostics

Failed commands are stored under
`.harness/operations/<operation>/diagnostics/` before control returns. A
`CommandDiagnosticV1` records a redacted command, cwd/workspace identity,
candidate identity, exit status, full stdout/stderr digests, bounded diagnostic
tails, an environment key/value digest without secret values, tool version, and
timestamps. Process output is hashed as it streams; retaining diagnostics does
not require retaining the full command output in memory.

On terminal implementation or validation failure, the controller stores a
`CandidateForensicsV1` snapshot before resource cleanup. It captures changed
paths, diff/content digest coverage, validation references and diagnostics,
last participant activity, and the last successful tool call. Candidate
worktrees and other owned resources are still reconciled and removed.

## Efficiency and privacy

`OperationEfficiencySummaryV2` is an observational projection under
`.harness/telemetry/efficiency/operations/`. It includes usage coverage,
participant generations, activity before first mutation, tool outcomes and
causal retries, fragment-identity context reuse, workflow rounds, duration,
acceptance, and delivery. Provider durations and billed usage stay `null` when
they cannot be proven. This projection never changes routing, assurance,
acceptance, policy, budgets, or delivery.

Raw tool arguments and outputs are not persisted by default. Tool records keep
identity, attempt, server/provider, session, argument digest and byte length,
result byte length, duration, outcome, and only explicit retry links. Similar
arguments without a causal retry link are marked equivalent or unknown, not a
proven retry. Context token values are deterministic AEH estimates, not provider
billed tokens.
