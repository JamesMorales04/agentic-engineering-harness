# Agentic Engineering Harness

AEH is an OSS-first control plane for governed software engineering with coding agents. It binds agent work to explicit user intent, frozen policy and scope, candidate identity, executable evidence, independent review, deterministic acceptance, and controlled delivery. No paid hosted service or paid license is mandatory.

**Core Architecture v2 is the current architecture.** The normative contract is [docs/CORE_ARCHITECTURE_V2.md](docs/CORE_ARCHITECTURE_V2.md); this README is the product entry point, not the full architecture specification.

## How AEH works

```text
human request
  -> INFORMATIONAL | AUDIT | CHANGE
  -> governed OperationRecord for engineering work
  -> frozen policy, authority, route, and assurance
  -> candidate identity + WorkGraph + compiled participants
  -> deterministic validation + independent Reviewer assessment
  -> AcceptanceOracle + ObjectiveCompletion
  -> ToolActionGate + delivery
  -> terminal resource reconciliation or explicit recovery
```

The decision path is hybrid: the Lead interprets user intent and product semantics; deterministic controller rules freeze scope and authority, verify evidence, decide acceptance, and gate effects. Model output cannot choose tools or grant authority, change frozen requirements, accept a candidate, or bypass a gate.

Requests use three entry classes:

- **INFORMATIONAL** answers or looks up repository information without creating an engineering operation.
- **AUDIT** performs governed, read-only engineering assessment with deterministic validators and independent reviewers.
- **CHANGE** routes a requested mutation through `NO_AGENT`, `DIRECT`, `DELEGATED`, or `FORMAL_SDD`. Assurance (`NONE`, `STANDARD`, `ELEVATED`, or `CRITICAL`) is decided separately from the route.

The Lead owns user intent, genuine product decisions, semantic ambiguity, and user-facing coordination. The Operation Supervisor owns bounded orchestration. Explorer discovers repository facts when needed; Planner decomposes non-trivial work; Spec Manager authors formal OpenSpec/SDD inputs; compiled Implementers execute assigned tasks; independent Reviewers assess evidence; compiled Repairers handle bounded remediation. Small read-only judgments use `SemanticAssessmentService` when a canonical participant is not needed.

Formal SDD begins with OpenSpec authoring by the Spec Manager. The deterministic compiler validates and seals the executable TaskContract. After freeze, that compiled contract and seal govern implementation. The Lead does not certify deterministic gates: the AcceptanceOracle evaluates candidate-bound evidence, and ObjectiveCompletion checks the operation's required participants, artifacts, lifecycle, and terminal identity.

The ToolActionGate checks authority and lifecycle before external effects such as pushes, pull requests, or other configured delivery actions. Terminal and recovery paths reconcile only resources proven to belong to the operation; live or unknown resources are preserved and reported.

## Start a project

Install AEH as a project development dependency, initialize its Harness files, and run the interactive entry point:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
npm exec aeh -- doctor
npm exec aeh -- start
```

`aeh start` creates a fresh Lead by default. Use `aeh start --resume` to explicitly resume a compatible managed Lead. Setup provisions the project-selected toolchain; there is no mutating npm `postinstall`.

The initialized project includes declarative Harness configuration, the `engineering-workflow` skill, managed assets, and OpenSpec authoring configuration. `aeh init`, `aeh setup`, and `aeh start` reconcile packaged managed assets. Untouched managed files can be upgraded; locally modified files are preserved as project overrides.

## Operations and evidence

Managed AUDIT, CHANGE, and RUN work can start as detached operations so the Lead can return promptly while the deterministic controller owns durable state. Use `aeh operation start`, `status`, `wait`, and `cancel` to control those operations. A local Paseo operation workspace groups sessions in the UI; it does not by itself create a Git branch or worktree.

The local Control Center presents operation, candidate, evidence, and human-decision state. It does not grant authority or replace controller checks. Context retrieval is controller-authorized, identity-bound, and budgeted; Graphify and memory provide advisory structural or historical context. Repository edits by Serena and model-written summaries do not control acceptance.

Isolation depends on the execution path and host: when Harness policy or a validator spec requires isolation, rootless bubblewrap isolates that validator or external tool; Podman/OCI worker paths are used when selected and provisioned. A required missing provider fails closed. No claim is made that every provider is installed on every host. See [docs/SECURITY.md](docs/SECURITY.md).

AEH self-hosting uses the same governed candidate and evidence model. The product cold-start trial should install a released package in a fresh environment and start it with `aeh start`; disposable self-modification fixtures keep campaign mutations out of the source checkout.

## Developing AEH itself

When the target is this AEH source checkout, build and use the checkout's own entry point:

```bash
npm ci
npm run build
npm run aeh -- start
# equivalent: node dist/main.js start
```

An external or global AEH invocation targeting an AEH checkout re-enters that checkout's `dist/main.js`. If the local build is missing, start fails closed with build instructions. Consumer repositories should pin AEH as a development dependency and use their project-local `npm exec aeh -- ...` binary.

## Further reading

- [Architecture and authority](docs/ARCHITECTURE.md)
- [Normative Core Architecture v2](docs/CORE_ARCHITECTURE_V2.md)
- [Paseo integration](docs/PASEO.md) and [Paseo-native boundaries](docs/PASEO_NATIVE.md)
- [SDD operating model](docs/SDD.md)
- [Publishing and release behavior](docs/PUBLISHING.md)
- [Certification](docs/CERTIFICATION.md), [security and isolation](docs/SECURITY.md), and [component maturity](docs/COMPONENT_MATURITY.md)
- [Context efficiency](docs/CONTEXT_EFFICIENCY.md), [memory](docs/MEMORY.md), and [observability](docs/OBSERVABILITY.md)
- [Roadmap history](ROADMAP.md) and [engineering evidence ledger](docs/ENGINEERING_LEDGER.md)

## License

Apache-2.0
