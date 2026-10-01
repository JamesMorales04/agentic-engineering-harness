# Architecture

AEH is a control plane between people, coding agents, repositories, and delivery systems. Its goal is to make engineering work auditable and bounded: semantic interpretation proposes meaning, while frozen contracts, deterministic policy, evidence, and lifecycle gates decide what may execute and what may be accepted.

The normative architecture is [Core Architecture v2](CORE_ARCHITECTURE_V2.md). Current certification evidence belongs in [STATUS](CORE_ARCHITECTURE_V2_STATUS.md), [CONFORMANCE](CORE_ARCHITECTURE_V2_CONFORMANCE.md), and the dated [Engineering Ledger](ENGINEERING_LEDGER.md).

## Authority and intent

The human retains product authority. The Lead preserves user intent, resolves genuine product ambiguity, and coordinates the user-facing conversation. For managed conversations it emits a typed `IntentDecisionV1`; the decision describes intent but grants no permission. The controller validates that structure and enforces the frozen policy, contract, lifecycle, and effect gates. It does not reinterpret the original sentence with a second keyword classifier.

Engineering requests enter as:

| Class | Meaning | Controller behavior |
| --- | --- | --- |
| `INFORMATIONAL` | Explanation or lookup with no engineering assessment or mutation | Bounded read-only answer; no engineering operation |
| `AUDIT` | Review, validation, or other read-only engineering assessment | Governed operation with deterministic checks and independent reviewers |
| `CHANGE` | Implementation, repair, configuration, or another repository mutation | Governed route and assurance, frozen work, validation, review, acceptance, and delivery |

Change route and assurance are separate decisions. Routes are `NO_AGENT`, `DIRECT`, `DELEGATED`, and `FORMAL_SDD`; assurance levels are `NONE`, `STANDARD`, `ELEVATED`, and `CRITICAL`. Typed semantic judgments are checked against deterministic policy and evidence before they affect a route or plan.

## Roles and work ownership

Canonical roles own distinct work:

- **Lead/Director:** user intent, product semantics, ambiguity, and user-facing coordination.
- **Operation Supervisor:** bounded orchestration, progress, and recovery coordination for a durable operation.
- **Explorer:** repository discovery when required by the compiled route.
- **Librarian:** external/versioned knowledge after a deterministic knowledge gate reports a gap.
- **Planner:** non-trivial decomposition into a WorkGraph.
- **Spec Manager:** proposal/spec/design/task authoring for `FORMAL_SDD`.
- **Implementer:** assigned repository changes under a frozen execution blueprint.
- **Reviewer:** independent evidence and quality assessment.
- **Repairer:** bounded changes after a failed gate.

Small, structured, evidence-bound read-only judgments use `SemanticAssessmentService` when an existing canonical participant cannot produce the result without meaningful extra cost or context. Semantic Assessment is a capability, not an authority-bearing participant. Model output cannot select a concrete agent, add tools, widen scope, accept a candidate, or certify a result.

The deterministic compiler maps the validated WorkGraph to a minimal `ParticipantPlan` and frozen `ExecutionBlueprint`s. Worker runtimes execute those blueprints; they do not choose their own roles, skills, tools, or authority. Paseo manages sessions and workspaces, while the AEH controller owns operation state, policy, and lifecycle decisions.

## Contracts and candidate identity

For `FORMAL_SDD`, OpenSpec is the authoring source before freeze. The Spec Manager authors the proposal, specs, design, and tasks. Deterministic validation and compilation produce stable requirement IDs, assertions, verification requirements, the AEH SDD, and the TaskContract seal. After sealing, the compiled artifacts and seal are normative; OpenSpec remains provenance and is not reinterpreted during implementation.

The controller assembles each candidate revision and binds it to source, operation, policy, and execution identity. WorkGraph dependencies, claims, task scope, participant plans, and wave barriers are validated deterministically. Repairs or new patches advance candidate identity and invalidate evidence bound to an earlier candidate.

## Validation, review, and acceptance

AEH resolves validation capabilities rather than treating any one language ecosystem as the boundary. Project-native tests, BDD, integration environments, contract tests, browser checks, security tools, and architecture checks produce normalized, candidate-bound evidence. Required missing providers fail closed. Provider-lane contracts are not proof that every provider is installed on every host.

Independent Reviewers assess the candidate and evidence. Their semantic findings contribute to review convergence, but their verdict is not deterministic certification. The **AcceptanceOracle** makes the deterministic acceptance disposition by checking frozen assertions against exact candidate-bound validation and review evidence. **ObjectiveCompletion** then verifies the operation's required assignments, evidence, lifecycle, delivery state, and terminal identity. The Lead retains final semantic authority over genuine product decisions but cannot override a failed deterministic gate.

The **ToolActionGate** checks authority, candidate, policy, and lifecycle before delivery effects. `delivery.github.allowedActions` is a closed project allowlist required when GitHub delivery is enabled; `enabled: true` does not imply issue creation or any other action. Accepted issue-derived work uses the issue handoff. Accepted no-Issue CHANGE work may create/use a local branch, commit, push, and create/update a PR through the same gate. The human authorization, frozen project allowlist, and current controller/action authority must all match. Merge, force push, branch/repository deletion, and credential mutation are unsupported actions. Terminalization settles every still-running stage with the terminal outcome and records that stage update in the terminal event. Operation-owned sessions, workspaces, processes, and staging resources are reconciled at terminal or recovery boundaries only when durable ownership is proven; active or unknown resources are preserved and reported.

## Control Center and runtime boundary

Paseo is the reference session, provider, and workspace adapter. It does not own AEH product semantics or acceptance. Managed AUDIT, CHANGE, and RUN work can start as durable detached operations; a worker is a real compiled participant, not a fake controller agent. Operation-local Paseo workspaces group sessions and do not imply a Git branch or worktree.

The local Control Center presents operation, candidate, evidence, and human-decision state. Human decisions are consumed only when they match the exact current operation and candidate contract. The surface cannot grant capabilities, edit a frozen contract, or bypass controller gates.

## Isolation and security

When the project isolation policy or a validator spec requires isolation for a validator or external tool, AEH executes it through the rootless bubblewrap (`bwrap`) provider with a minimal read-only host root, explicit toolchain binds, a scoped workspace, a cleared environment, and network denial by default. A missing required provider blocks execution; the command is not run unsandboxed and is not silently reported as passing.

Podman/OCI worker and integration-provider paths are separate capabilities used where configured and available. Their availability is host-dependent; the presence of the bwrap validator path does not certify that Podman or an OCI runtime exists. See [Security and Isolation](SECURITY.md) for the implemented boundaries and evidence.

## Context and advisory knowledge

`ContextBudgetGateway` retrieves, authorizes, selects, budgets, projects, and delivers a versioned context envelope. Retrieval is bound to operation, candidate, participant, policy, session, allowed references, and budget. Required verbatim material is not truncated; raw evidence remains behind an authorized retrieval gateway.

Graphify contributes structural repository context, Serena provides bounded semantic repository retrieval, and Engram provides historical memory. These providers are advisory context, not policy or authority. Headroom compresses only eligible AEH-marked fragments and does not own contracts, structured results, operation state, or validation.

## Measurement and provenance

AEH records machine-readable validation, review, acceptance, delivery, and resource-reconciliation evidence. Telemetry and engineering evals are observational; they cannot grant authority or alter routing or acceptance. Provenance binds the relevant frozen controller, contract, candidate, output, and supply-chain artifacts. Signing or a hosted collector is not assumed unless configured and verified.
