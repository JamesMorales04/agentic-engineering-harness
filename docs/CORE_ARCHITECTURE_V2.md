# Core Architecture v2

**Authority:** This is the sole normative target for Core Architecture v2. It defines what AEH must do. Current implementation state and evidence belong in [Core Architecture v2 Status](CORE_ARCHITECTURE_V2_STATUS.md); claim-to-evidence boundaries belong in [Core Architecture v2 Conformance](CORE_ARCHITECTURE_V2_CONFORMANCE.md); incidents and historical findings belong in the [Engineering Ledger](ENGINEERING_LEDGER.md). Those documents do not amend this target. ROADMAP.md and version documents record product evolution history; they do not define Core-v2 target architecture or current implementation status. Mermaid diagrams are normative visual projections of the surrounding architecture. Prose/contracts remain the semantic authority; diagrams add no lifecycle transition, authority grant, dependency, or behavior. Update prose and diagrams together when architecture changes.

## 1. Product operating model

AEH is a governed autonomous software-engineering control plane. It accepts an engineering outcome and governs the path from intent through requirements, knowledge, specialized participants, isolated implementation, candidate assembly, evidence, acceptance, delivery, and recovery.

People own intent, genuine product choices, exceptional authorization, and final visibility. Models contribute bounded semantic judgments. Deterministic infrastructure owns identity, authority, lifecycle, evidence integrity, policy enforcement, and external effects. Every source change enters an operation through a validated ChangeSet assembled into a new CandidateRevision.

The development checkout of AEH is developed by the external controller, shell, TypeScript, and deterministic commands. AEH does not govern changes to its own development checkout.

### 1.1 Request classes

Every conversational turn is classified as one of these four request classes:

- **INFORMATIONAL:** explain or look up information from bounded, authorized, read-only context. It does not create an engineering OperationRecord.
- **AUDIT:** an engineering review, validation, bug discovery, or other assessment may create a governed read-only operation. When an audit operation is created, freeze its policy and snapshot, run required checks and read-only review, report findings, and stop. Remediation requires a separate CHANGE.
- **CHANGE:** create a governed mutation operation. The user describes the outcome; AEH derives and runs the workflow permitted by policy and evidence.
- **STATUS / CONTROL:** inspect conversation state or a durable operation, or submit a typed pause, resume, cancel, decision, or permitted retry command. A status query does not create an engineering operation. A control command acts on the relevant conversation or durable operation.

A request to run a prepared contract is an internal continuation of CHANGE, not a fifth conversational class or a route around CHANGE.

### 1.2 Route and assurance

CHANGE selects two independent dimensions:

| Dimension | Values | Meaning |
| --- | --- | --- |
| ImplementationRoute | NO_AGENT, DIRECT, DELEGATED, FORMAL_SDD | How implementation responsibility and coordination are organized. |
| Assurance | NONE, STANDARD, ELEVATED, CRITICAL | Minimum strength of validation, review, acceptance, and evidence. |

Route is not an authorization grant. Assurance is not a route. Semantic assessment may recommend either dimension, while deterministic policy applies hard constraints and minimums. Example outcomes are not universal routing rules.

### 1.3 Canonical workflow

A governed CHANGE follows this target sequence:

HumanTurn
→ Semantic Lead
→ IntentDecision and request class
→ independent route and assurance resolution
→ ResolvedOperationPolicy
→ formalization when required
→ WorkGraph and resource claims
→ KnowledgeGate
→ Librarian and accepted knowledge where needed
→ operation-local SkillTrust and SkillManifest
→ deterministic ParticipantPlan compilation
→ ExecutionBlueprint
→ participant-specific ContextManifest and PromptManifest
→ controller-fenced authority and capability leases
→ runtime/session materialization
→ isolated participant execution
→ StructuredResult and ChangeSet
→ provenance gate
→ CandidateAssembler and CandidateRevision
→ actual CandidateImpact
→ assurance recompilation
→ validation
→ independent review and quality convergence
→ bounded repair, replan, or oracle diagnosis as required
→ acceptance resolution
→ AcceptanceOracle and policy-required certification evidence
→ delivery authorization
→ ActionIntent and ToolActionGate
→ external effect and ActionReceipt or reconciliation
→ Completion Gate
→ COMPLETED


~~~mermaid
flowchart TD
    user([User]) --> turn["HumanTurn"]
    turn --> lead["Semantic Lead"]
    lead --> intent["IntentDecision"]
    intent --> request{"Request class"}

    request -->|INFORMATIONAL| infoContext["Bounded read-only context"]
    infoContext --> infoAnswer["Answer"]
    infoAnswer --> infoDone(["INFORMATIONAL_DONE<br/>No OperationRecord"])

    request -->|AUDIT, if operation created| auditPolicy["Freeze read-only audit policy and snapshot"]
    auditPolicy --> auditPlan["Audit planning"]
    auditPlan --> auditRun["Checks and read-only execution"]
    auditRun --> auditReview["Independent read-only review"]
    auditReview --> auditDone(["AUDIT_DONE<br/>No remediation"])

    request -->|STATUS / CONTROL| inspect["Inspect conversation or durable operation"]
    inspect --> control["Apply typed control through its owner"]
    control --> response["Conversation response"]

    request -->|CHANGE| route["Route + Assurance"]
    route --> policy["ResolvedOperationPolicy"]
    policy -->|Genuine unresolved product choice or authorization| humanDecision
    policy --> formal{"FORMAL_SDD required?"}
    formal -->|Yes| spec["Formalization and seal"]
    formal -->|No| workGraph["WorkGraph"]
    spec --> workGraph

    workGraph --> knowledge["KnowledgeGate"]
    knowledge -->|Current competency or policy-valid cache| readyKnowledge["Knowledge requirement satisfied"]
    knowledge -->|KnowledgeGap| librarian["Librarian when required"]
    librarian --> sources["Approved, version-aware sources"]
    sources --> pack["KnowledgePack"]
    pack -->|Claims re-enter KnowledgeGate| knowledge
    pack -->|Optional procedure proposal| skillCandidate["SkillCandidate"]
    skillCandidate --> trust["SkillTrustGate"]
    trust -->|Accepted under policy| acceptedSkill["AcceptedEphemeralSkill"]
    trust -->|Rejected; competency still sufficient| compiler
    trust -->|Rejected; required competency unmet| blocked
    acceptedSkill --> manifest["SkillManifest"]
    readyKnowledge --> compiler["ParticipantCompiler"]
    manifest --> compiler

    compiler --> plan["ParticipantPlan"]
    plan --> blueprint["ExecutionBlueprint"]
    blueprint --> context["ContextManifest + PromptManifest"]
    context --> authority["Controller-fenced authority + Capability Leases"]
    authority --> session["Paseo/session materialization"]
    session --> participants["Isolated participants"]
    participants --> result["StructuredResult / ChangeSet"]
    result --> provenance["Result provenance gate"]
    provenance --> assembler["CandidateAssembler"]
    assembler --> candidate["CandidateRevision"]
    candidate --> impact["Actual CandidateImpact"]
    impact --> recompilation["Assurance / Review / Validation / Acceptance recompilation"]
    recompilation --> validation["Validation"]
    validation --> review["Independent Review"]
    review --> quality{"Quality Convergence"}

    quality -->|Ready for acceptance| assertion["AcceptanceAssertion"]
    quality -->|Candidate defect| repairer["Repairer"]
    repairer --> repairSet["ChangeSet"]
    repairSet --> assembler
    quality -->|Decomposition change| replan["Replan"]
    replan --> workGraph
    quality -->|Bounded diagnosis| diagnosis["Oracle Diagnosis"]
    diagnosis -->|Repair| repairer
    diagnosis -->|Replan| replan
    diagnosis -->|Genuine unresolved decision| humanDecision["HumanDecision"]
    diagnosis -->|No safe automatic continuation| blocked["BLOCKED"]

    assertion --> verification["VerificationRequirement"]
    verification --> resolver["OracleResolver"]
    resolver --> evidence["EvidenceBundle"]
    evidence --> oracle["AcceptanceOracle"]
    oracle -->|Acceptance finding requiring repair| acceptRepair["Acceptance repair"]
    acceptRepair --> repairer
    oracle -->|Genuine unresolved decision| humanDecision
    oracle -->|Accepted| certGate["Policy-required certification evidence<br/>(where required; current for this candidate)"]
    certGate --> deliveryReady["DeliveryReady"]

    deliveryReady -->|Authorized effect requested| actionIntent["ActionIntent"]
    actionIntent --> actionGate["ToolActionGate"]
    actionGate --> effect["External effect"]
    effect --> outcome{"Outcome known?"}
    outcome -->|Yes| receipt["ActionReceipt"]
    outcome -->|Uncertain| reconciliation["Reconciliation"]
    reconciliation -->|Observed and reconciled| reconciledReceipt["Reconciled receipt"]
    reconciliation -->|Still unknown| blocked
    receipt --> completion["CompletionGate"]
    reconciledReceipt --> completion
    deliveryReady -->|No external effect requested| completion
    completion --> completed(["COMPLETED"])

    humanDecision --> continuation["Controller validates durable continuation"]
    continuation --> resumeTarget["Saved continuation target<br/>(varies by suspension record)"]
    resumeTarget -.-> activeStage["Operation resumes at recorded stage<br/>(varies; not a fixed state)"]
~~~


AUDIT uses an immutable read-only policy and snapshot, then planning, execution, independent review, and an audit report. It has no remediation transition. INFORMATIONAL uses bounded context resolution and an answer turn; it does not create an OperationRecord. STATUS / CONTROL queries or controls existing conversation and operation state through the applicable owner.

The controller owns and persists every operation transition. A model judgment cannot skip a gate or advance candidate truth.

### 1.4 Contract evolution

When a new architecture, contract, schema, configuration model, CLI surface, runtime path, or internal API supersedes an existing one, preserve useful semantics, migrate current production consumers, update schemas/templates/fixtures/tests/documentation, and delete the superseded implementation and compatibility branches. Do not add aliases, adapters, dual-read/dual-write behavior, deprecated paths, or fallback behavior as a precaution. Backward compatibility requires a concrete externally approved need, an identified compatibility surface, an intended lifetime, and a removal condition. Stale architecture fails with an explicit unsupported-version or migration error.


## 2. Decision-mechanism policy

For every meaningful classification, inference, routing, selection, diagnosis, or decision, the mechanism is explicitly classified as DETERMINISTIC, MODEL, or HYBRID.


~~~mermaid
flowchart LR
    evidence["Bounded evidence"] --> gateway["SemanticAssessmentServiceV1<br/>controller-side typed gateway"]
    gateway --> topology["Resolve AEH Semantic Assessor<br/>AgentTopology + semantic capability policy"]
    topology --> paseo["Paseo-managed agent/session"]
    paseo --> model["MODEL"]
    model --> structured["Typed structured assessment"]
    structured --> check["DETERMINISTIC<br/>schema, evidence, binding,<br/>policy, provenance and cache checks"]
    check --> judgment["Validated semantic judgment"]

    facts["Observable facts + policy"] --> constraints["DETERMINISTIC<br/>constraints and authority checks"]
    judgment --> hybrid["HYBRID<br/>judgment constrained by evidence/policy"]
    constraints --> hybrid
    hybrid --> controller["Controller"]
    controller --> gates["Deterministic lifecycle, authority,<br/>candidate, and effect gates"]
~~~

The MODEL path contributes semantic judgment only. It has no direct edge to authority, capability leases, candidate truth, or external side effects; those remain behind deterministic controller gates.


- **DETERMINISTIC** applies to mechanically observable, stable, reproducible, or safety-critical facts and controls.
- **MODEL** supplies open-ended semantic interpretation from bounded evidence.
- **HYBRID** combines semantic interpretation with deterministic identity, evidence, policy, authority, or lifecycle checks.

Model reasoning is a capability, not authority. Small, structured, evidence-bound, read-only judgments use `SemanticAssessmentServiceV1` when an existing canonical participant cannot provide the result without meaningful additional cost or context. Its one general AEH-managed agent responsibility is **Semantic Assessor**. AgentTopology plus semantic capability policy resolve the concrete model/profile; Paseo runs that agent and supplies actual session identity as execution provenance. The Semantic Assessor is an AEH Agent, not automatically a WorkGraph Participant. Every AEH Participant is an AEH Agent, but an AEH Agent need not be a Participant. Operation- or candidate-scoped assessment binds to current evidence without creating WorkUnit ownership, ChangeSet authority, or mutation capability. The assessment agent is read-only and assessment-only; it has no repository or Git writes, candidate mutation, external effects, arbitrary shell, delegation, acceptance authority, policy mutation, or capability granting. A bounded controller read may supply receipted repository/candidate evidence; the agent does not receive direct repository tools.

`SemanticAssessmentV1` is the canonical stored result. Its supported assessment types are `INTENT`, `ROUTE`, `STACK`, `ISSUE`, `FAILURE`, `CANDIDATE_IMPACT`, and `VALIDATION_NEED`. It preserves assessment type; resolved AEH agent/profile and actual Paseo runtime/session identity; applicable repository/candidate binding; evidence references, receipts, and digest; policy revision; typed judgment and unknowns; assessment digest; and cache identity/freshness. Deterministic checks reject invalid schema, provenance, binding, evidence, policy, stale, or replayed results. A judgment is data and cannot grant authority. If an assessment is unavailable or invalid, the surface fails closed or retains its explicit deterministic minimum; it never silently falls back to superseded heuristics or weakens assurance, review, validation, acceptance, policy, or authority.

Full participants are used for durable assignment, work ownership, tools, authority, substantial context, or multi-turn coordination. Do not grow regex or keyword expert systems to avoid bounded semantic assessment, and do not create micro-roles for small classifications.

| Decision surface | Mechanism | Model responsibility | Deterministic responsibility and failure boundary |
| --- | --- | --- | --- |
| Intent | HYBRID | Interpret whether the turn asks for information, audit, change, or control and what outcome is requested. | Validate typed decision, request binding, explicit CLI intent, and route constraints. Ambiguous material intent pauses for bounded clarification. |
| Route | HYBRID | Assess semantic complexity, coordination, scope meaning, and formalization need. | Apply hard route constraints and compile an allowed route. Invalid routes are rejected. |
| Assurance | HYBRID | Identify semantic risks that may strengthen assurance. | Compute policy minimums from observable facts and enforce non-weakening floors. Missing or invalid assessment cannot lower a minimum. |
| Stack | HYBRID | Determine languages, frameworks, package managers, databases, toolchains, test frameworks, migration mechanisms, build systems, versions, relevant project skill roots, and unknowns from bounded repository/candidate evidence; select relevant supplied evidence. | Bind repository/project and candidate identity; authorize bounded reads only from the Git-tracked and non-ignored untracked file set represented by the repository digest, or a stricter generic boundary; verify read receipts, normalized relative paths, content digests, result schema, profile/model/session provenance, policy revision, budget, assessment digest, cache identity/freshness, and staleness. Deterministically validate proposed project skill roots as existing directories inside the bound repository/candidate; the paths are descriptive data and do not select or grant skills or capabilities. Deterministic Core validates evidence and consequences using generic filesystem/path rules; it does not infer stack meaning from technology-specific detectors or content/path rules. Unknown facts remain unknown. |
| Issue | HYBRID | Interpret requested scope and meaning. | Preserve raw issue snapshot, source identity, and authorization boundary. Issue text is not authority. |
| Work decomposition | HYBRID | Propose WorkUnits, dependencies, competencies, risk, and resource claims. | Validate requirement coverage, scope, DAG, claims, budgets, and scheduling conflicts. Models cannot select identities or tools. |
| Knowledge sufficiency | HYBRID | Identify competencies and semantic knowledge gaps. | Validate freshness, provenance, version, source policy, and claim coverage. Stale, conflicting, or unsupported packs do not satisfy a gap. |
| Candidate identity | DETERMINISTIC | None. | Hash and bind candidate, workspace, revision, lineage, and ChangeSets. Reject drift, replay, or unproven identity. |
| Candidate impact | HYBRID | Interpret actual diff and repository evidence for typed impact dimensions. | Bind assessment to current candidate and recompile minimum assurance, review, validation, and acceptance requirements. Missing assessment cannot weaken a requirement. |
| Failure | HYBRID | Classify meaning and likely cause from bounded failure evidence. | Record process/test facts and constrain recovery, retries, budgets, and transitions. Diagnosis cannot authorize repair. |
| Validation need | HYBRID | State what property must be demonstrated and why. | Resolve an approved validator/provider/action and validate result identity. Missing required evidence blocks. |
| Review | HYBRID | Independent reviewers provide semantic findings. | Enforce reviewer identity, read-only scope, candidate binding, required dimensions, and quality gates. Agreement cannot override failed deterministic evidence. |
| Quality convergence | HYBRID | Interpret findings and remediation meaning. | Enforce counts, thresholds, cycles, stagnation, budgets, and progression. Exhaustion enters typed recovery or suspension. |
| Acceptance | HYBRID | Interpret requirement meaning and provide bounded semantic evidence. | Check assertions, required evidence, provenance, candidate identity, oracle result, and policy. Missing required evidence prevents acceptance. |
| Context projection | HYBRID | Optionally compress eligible projectable fragments. | Protect normative and authority content, enforce budgets, and verify manifests. Such content is never lossily compressed. |
| Delivery | HYBRID plan; DETERMINISTIC authorization and effect | Interpret the requested external outcome. | Authorize each exact action, bind it to candidate and epoch, persist intent and receipt, and reconcile uncertain outcomes. Unknown non-idempotent outcomes are not retried blindly. |
| Certification | DETERMINISTIC gate over provider evidence | A real model/provider may execute a capability lane and return evidence. | Apply frozen policy and independent oracle to candidate-bound receipts. Fixtures cannot certify real providers. |

Production Core-v2 STACK uses candidate/repository-bound, read-only evidence receipts from the Git-tracked and non-ignored untracked repository file set (or a stricter generic subset), Semantic Assessor selection of relevant evidence, a typed `SemanticStackJudgmentV1`, and deterministic post-validation before projecting a `ProjectStackProfile`. Proposed project skill roots must be normalized, existing directories inside the bound root; they remain descriptive data and grant no skills or capabilities. Technology meaning is not inferred from deterministic detectors. `DETERMINISTIC_FAST_PATH`, `fastPath`, `StackDetectorRegistryV1`, `DEFAULT_STACK_DETECTORS_V1`, `createDefaultStackDetectorRegistry()`, technology-specific detector implementations, `inferProjectStackProfile()`, `languageOrder`, and `deriveObjectiveMetadata()` are superseded and absent from production code; there is no compatibility fallback.

Candidate truth, controller fencing, capabilities, leases, policy enforcement, lifecycle transitions, digests, result provenance, and external-effect authority are deterministic.

## 3. Authority and policy

### 3.1 Authority model

- **Human:** ultimate product authority and source of genuine product choices and exceptional authorizations.
- **Lead agent (normally Codex):** preserves intent, orchestrates bounded participants, resolves true ambiguity, and performs final semantic acceptance.
- **Canonical AEH Agent responsibilities:** Lead/Director, Operation Supervisor, Explorer, Librarian, Planner, Spec Manager, Implementer, Reviewer, Repairer, Oracle, and Semantic Assessor. Semantic Assessor is one general assessment-only responsibility; there are no assessment-specific agent classes.
- **Canonical WorkGraph Participant roles:** Lead/Director, Operation Supervisor, Explorer, Librarian, Planner, Spec Manager, Implementer, Reviewer, and Repairer. Semantic Assessor is an AEH Agent responsibility but is excluded from this Participant role set and cannot receive WorkUnit ownership or ChangeSet authority by default.
- **Deterministic Controller:** infrastructure, not an LLM role. It owns state, identity, leases, gates, transitions, and external effects.
- **Deterministic Harness:** gate authority for everything testable programmatically.
- **Memory/Graphify:** advisory historical and structural context only.

Specializations, skills, tools, capabilities, and authority are compiled for a role. Technology and domain differences are not permanent agent classes. Worker runtimes execute a frozen ExecutionBlueprint; they do not choose their role, skills, tools, or authority.

The Lead delegates repository discovery to Explorer only when the route/compiler requires discovery; external/versioned research to Librarian only after KnowledgeGate reports a gap; non-trivial decomposition to Planner; formal requirement authoring to Spec Manager only for FORMAL_SDD; and implementation, review, and repair to compiled Implementer, Reviewer, and Repairer blueprints. Deterministic validation, toolchain setup, environment checks, and delivery are infrastructure responsibilities, not permanent semantic roles.

### 3.2 ResolvedOperationPolicy and role ceilings

ResolvedOperationPolicy freezes operation semantics: intent, route, minimum assurance, project and operation identity, candidate, policy versions/digests, validation/review/delivery policies, knowledge/context policies, allowed external effects, and human-decision requirements. It is evidence and configuration, not an authority token.

RoleInvocationPolicy binds one canonical role's ceiling to assigned WorkUnits, scope, competencies, ToolPack, resource claims, output contract, and role-specific constraints. Policy and role ceilings are compiled deterministically. Model output cannot choose, weaken, or widen them.

Capability leases and controller tokens remain separate authority. An execution binding may identify applicable controller-issued authority evidence but never grants that authority. ToolActionGate checks the current candidate, operation, epoch, actor, scope, policy, and lease before every sensitive action.

### 3.3 Human decisions

HumanDecision is durable, typed, versioned, scoped, attributable, expiry-aware, and replay-safe. Product choice and action authorization are distinct kinds:

- A product choice may create a new requirement/policy revision and invalidate dependent plans. It grants no unrelated capability.
- An action authorization binds to an exact operation, candidate, action, and effect.

Every DecisionRequest states the unresolved issue, authoritative evidence, what AEH tried, why repository/spec/policy cannot decide, bounded choices and consequences where possible, work that can continue in parallel, and the state that resumes afterward.

## 4. Formalization, work, and participants

### 4.1 Formalization

FORMAL_SDD uses OpenSpec as the preferred authoring source before freeze. The compiled Spec Manager role validates proposal, specifications, design, and tasks. A deterministic compiler generates native artifacts and requirement-validator traceability. After compilation/sealing, compiled artifacts and seal are normative during implementation. OpenSpec source remains authoring provenance and may not be silently reinterpreted mid-run. OpenSpec apply commands do not own product implementation; the deterministic controller does.

Only a legitimate scoped HumanDecision can resolve a product requirement contradiction by creating a new requirement version and seal. Replanning changes task decomposition, not sealed product requirements.

### 4.2 WorkGraph and resource claims

A WorkGraph is a validated DAG of WorkUnits derived from frozen requirements. A unit declares scope, dependencies, competencies, risk, output contract, budget, and logical resource claims. Claims can express SHARED_READ, EXCLUSIVE_WRITE, or ORDERED_SEQUENCE. Deterministic validation checks requirement coverage, DAG integrity, scope, budgets, claims, and scheduling conflicts before execution.

The scheduler may co-schedule only compatible units. A model may propose the graph and claims, but cannot select concrete worker identities, tools, or authority. Candidate assembly re-checks claims before combining sibling ChangeSets.

### 4.3 Roles, specializations, skills, and tools

A role is an authority and responsibility class. A specialization is a bounded domain tag. A skill is a procedure or knowledge capability. A ToolPack bounds the execution surface.

ParticipantCompiler derives a minimal ParticipantPlan from WorkGraph, policy, role ceilings, competencies, specializations, accepted skills, tool catalog, budgets, and scope. Model output cannot invent concrete identities or widen the plan. Skills cannot widen RoleProfile capabilities. Reviewer is read-only. Repairer receives bounded findings and produces a ChangeSet.

## 5. Knowledge and ephemeral skills

The knowledge lifecycle is:

WorkUnit competencies
→ KnowledgeGate
→ trusted current competency, policy-valid cache hit, or KnowledgeGap
→ read-only Librarian research when needed
→ untrusted KnowledgePack
→ optional untrusted SkillCandidate
→ deterministic SkillTrustGate
→ AcceptedEphemeralSkill
→ operation-local SkillRegistry and SkillManifest
→ ParticipantCompiler



~~~mermaid
flowchart TD
    competencies["WorkUnit competencies"] --> gate["KnowledgeGate"]
    gate -->|Already sufficient| current["Trusted current competency"]
    gate -->|Freshness and source policy pass| cache["Policy-valid cache"]
    gate -->|KnowledgeGap| librarian["Librarian<br/>read-only research; no trust authority"]

    librarian --> sources["Approved, version-aware sources"]
    sources --> pack["KnowledgePack"]
    pack -->|Claims and provenance are checked| gate
    pack -->|Optional procedure proposal| candidate["SkillCandidate"]
    candidate --> trust["SkillTrustGate"]
    trust -->|Accepted under policy| skill["AcceptedEphemeralSkill"]
    skill --> registry["Operation SkillRegistry"]
    registry --> manifest["SkillManifest"]
    current --> compiler["ParticipantCompiler"]
    cache --> compiler
    gate -->|Sufficient after evidence checks| compiler
    manifest --> compiler
    compiler --> prompt["Actual authorized prompt/context"]

    packNote["KnowledgePack = evidence, not authority"]
    candidateNote["SkillCandidate = proposal, not trusted skill"]
    skillNote["Skill = procedure, not authority"]
    pack -.-> packNote
    candidate -.-> candidateNote
    skill -.-> skillNote
    subgraph postLifecycle["Outside the active operation lifecycle"]
        postOperation["Persistent promotion is post-operation only<br/>and requires governed adoption"]
    end
    manifest -. "post-operation only" .-> postOperation
~~~

The diagram's detached notes are trust-boundary statements, not transitions. Persistent skill promotion requires post-operation independent evaluation and governed adoption.

Librarian is a bounded, read-only knowledge participant. It can find approved, version-matched sources and return source-linked claims and an optional procedure proposal. It cannot grant trust, network access, tools, source mutation, or policy changes.

KnowledgePack is research evidence, not instruction. SkillCandidate is a proposal, not authority. SkillTrustGate is deterministic policy outside the proposing model. It verifies source allowlists, version/freshness policy, pack and content digests, competency coverage, and provenance. Every procedure step links to supporting pack evidence. If grounding needs semantic interpretation, a separate evidence-bound assessment may contribute data; the deterministic gate makes the trust decision.

AcceptedEphemeralSkill is operation-scoped by default, competency-bound, pack/source-policy/trust-decision/content-digest-bound, versioned, and unable to widen authority. Persistent promotion is post-operation only and requires independent evaluation and explicit governed adoption.

The exact accepted procedure text is retained in SkillManifest and delivered verbatim only to the assigned authorized participant. The manifest binds skill ID, exact procedure digest, competency, kind, source-pack digest, trust-decision digest, lifetime/scope, and provenance. ParticipantPlan binds the manifest; ExecutionBinding binds the exact delivered manifest revision; the authorized prompt receives its procedure. Passing only a skill ID is insufficient. A content or digest mismatch invalidates the plan and binding and requires recompilation.

A cache satisfies a knowledge gap only under the operation's frozen KnowledgeFreshnessPolicy: source-policy revision, required version, repository/candidate binding where applicable, and deterministic age bound. Without freshness policy, a cache entry cannot satisfy the gap.

## 6. Execution identity and result provenance

Execution identity is split into three contracts:

1. **ExecutionBlueprint:** static intended execution identity. It binds project, operation execution revision, candidate revision/digest, controller epoch, policy digest, WorkGraph and ParticipantPlan digests, catalog, participant roles/specializations, SkillManifest digests, ToolPacks, resource claims, validation resolution, and output contracts.
2. **ExecutionBinding:** per-participant generation and launch identity. It binds the blueprint/policy digest, participant identity/generation, actual runtime/model/session, delivered ContextManifest/PromptManifest digests, and applicable controller-issued lease identities.
3. **StructuredResultProvenance:** binds the emitted result and ChangeSet to the complete blueprint and binding and is checked against durable current operation state.


~~~mermaid
flowchart TD
    policy["ResolvedOperationPolicy"] --> blueprint["ExecutionBlueprint"]
    workGraph["WorkGraph"] --> blueprint
    participantPlan["ParticipantPlan"] --> blueprint
    skillManifest["SkillManifest"] --> blueprint
    catalog["ExecutionCatalog"] --> blueprint
    candidate["CandidateRevision"] --> blueprint

    blueprint --> binding["ExecutionBinding"]
    generation["Participant generation"] --> binding
    runtime["Runtime / model / session"] --> binding
    context["ContextManifest"] --> binding
    prompt["PromptManifest"] --> binding
    leaseRef["Lease references<br/>(identity evidence only)"] --> binding

    blueprint --> provenance["StructuredResultProvenance"]
    binding --> provenance
    result["Emitted StructuredResult / ChangeSet"] --> provenance
    provenance --> resultGate["Result Provenance Gate"]
    durable["Current durable operation identity"] --> resultGate

    lease["CapabilityLease + controller fencing<br/>(authority)"] --> authorityGate["Deterministic authority check"]
    binding -. "execution identity only" .-> launch["Permitted execution"]
    authorityGate --> launch
    binding -.-> identityNote["Execution identity = evidence/configuration<br/>not authority"]
~~~

Execution identity is evidence/configuration. CapabilityLease and controller fencing are authority and remain separate. Lease references inside ExecutionBinding identify applicable authority evidence; the controller independently checks the actual current lease and epoch.


An obsolete identity version fails with an explicit unsupported-version or migration error. There is no dual-read compatibility path. Candidate assembly invalidates bindings and results for the previous candidate. Controller takeover invalidates old-epoch writers and leases.

The append-only record revision advances on every durable event. operationExecutionRevision advances only when execution semantics change. Routine stage events therefore do not invalidate every active blueprint.

## 7. Progressive context and Paseo identity

Each assignment compiles context requirements into a ContextManifest. The runtime projects only needed evidence, using structural topology, semantic repository context, advisory historical memory, authoritative Librarian KnowledgePacks, operation-local SkillManifests, and exact verbatim projections for normative artifacts.

Context references are JIT-addressable and require controller-issued authorization bound to participant, operation, candidate, and session. Delivered fragments, source provenance, retrieval receipts, budget, and prompt content produce ContextManifest and PromptManifest digests.

TaskContracts, sealed requirements, authority envelopes, output schemas, policy identity, and acceptance assertions remain verbatim. Headroom or semantic compression applies only to explicitly COMPRESSIBLE fragments. Context or prompt changes create a different execution binding.

A Paseo session is reusable only when its durable binding exactly matches operation, participant, generation, candidate, blueprint, policy, context/prompt, and controller epoch. Any mismatch requires session rotation or a new session. A live provider session alone does not prove semantic execution identity.

## 8. Candidate truth and assurance

### 8.1 Candidate truth and assembly

CandidateRevision is the sole current source truth for an operation. Participants return immutable StructuredResults and, for source mutation, ChangeSets based on the candidate they observed. The controller validates scope, candidate identity, patch digest, participant binding, and resource conflicts before CandidateAssembler creates revision N+1.

Parallel siblings keep their observed base. Rebase creates a derived ChangeSet and preserves source history. Failed assembly leaves the bound candidate unchanged. Repair uses the same model. Validation, review, acceptance, and delivery evidence bind to the candidate digest.

Source changes are permitted only in isolated EXECUTING or REPAIRING work. They become candidate truth only in ASSEMBLING. A participant's claim that it is done does not advance a candidate.

### 8.2 CandidateImpact and assurance recompilation

CandidateImpact is assessed only after CandidateAssembler establishes the actual candidate. Deterministic patch/path/repository facts combine with bounded semantic interpretation to identify typed dimensions such as security, authentication/authorization, public API, migration/schema, dependency/supply chain, UI/browser, architecture, concurrency, and operations.

CandidateImpact can only strengthen policy minimums. It recompiles required assurance, independent reviewers and dimensions, validation requirements, acceptance assertions, and evidence strength. A requirement for independent review must result in an actual independent reviewer assignment. Missing or invalid impact assessment cannot weaken requirements; unresolved high-risk impact blocks acceptance.

## 9. Validation, review, repair, and acceptance

### 9.1 Validation

Each ValidationRequirement names the property, scope, evidence needed, and requirement/acceptance references. A deterministic resolver selects approved project scripts, validators, and providers. Results are machine-readable, reproducible, and bound to the current candidate and provider execution.

PASS means only that the resolved validation requirements passed. Missing required tools/providers block; they do not silently become SKIP. Validation does not imply review or semantic acceptance.

### 9.2 Review and quality convergence

Review requirements compile from route, assurance, CandidateImpact, and policy. Reviewers are independent, read-only participants and return typed engineering findings. Policy may require provider diversity; model agreement alone has no authority.

The deterministic Quality Gate enforces findings, severity counts, thresholds, regression, cycle, stagnation, and attempt budgets. Repair follows typed recovery. After a new candidate, affected validation and review run again.

### 9.3 Repair, replan, and oracle diagnosis

Repairer receives a bounded finding packet and returns a ChangeSet from an isolated scope. It cannot bind a candidate directly, alter frozen requirements, or accept its own result. Assembly creates the repair candidate. Impact, validation, review, and acceptance requirements are then reevaluated for that candidate.

Planner may revise task decomposition while preserving sealed requirements. Obsolete assignments are fenced and invalidated. Oracle diagnosis interprets bounded evidence gaps or failures and may propose a bounded repair, replan, human question, or retry; it cannot self-accept or mutate source.

Recovery is typed, bounded by policy, and candidate-aware. Deterministic controls enforce retries, budgets, stagnation, state progression, cancellation, and evidence invalidation. Ordinary test or participant failure alone is not a reason to ask a human.

### 9.4 Acceptance and certification boundaries

The acceptance chain is:

Requirement
→ AcceptanceAssertion
→ VerificationRequirement
→ deterministic OracleResolver
→ candidate-bound EvidenceBundle
→ AcceptanceOracle
→ policy disposition

- **AcceptanceAssertion:** observable truth implied by a requirement.
- **VerificationRequirement:** evidence kind and strength needed to establish it.
- **OracleResolver:** deterministically selects an approved mechanism such as unit/property, integration, API/CLI/browser E2E, visual, semantic, external, or human evidence.
- **EvidenceBundle:** candidate-bound evidence with provenance, freshness, and execution identity.
- **AcceptanceOracle:** checks assertion coverage, evidence sufficiency, policy, and identity. Semantic assessments may help interpret assertions; the controller-controlled evidence gate decides disposition.
- **Lead semantic-acceptance record:** candidate-bound and independent of the implementation actor. It may be bounded semantic evidence but cannot override missing or failed required oracle evidence.
- **CertificationCore:** evaluates frozen capability/provider certification policy and issues a certification disposition. It does not accept a production change operation. When policy requires certification, its report is one required evidence item for AcceptanceOracle.


~~~mermaid
flowchart TD
    requirement["Requirement"] --> assertion["AcceptanceAssertion"]
    assertion --> verification["VerificationRequirement"]
    verification --> resolver["OracleResolver"]

    resolver --> unit["Unit / property"]
    resolver --> integration["Integration"]
    resolver --> api["API / CLI E2E"]
    resolver --> browser["Browser"]
    resolver --> visual["Visual"]
    resolver --> semantic["Semantic"]
    resolver --> external["External"]
    resolver --> human["Human evidence"]

    unit --> bundle["Candidate-bound EvidenceBundle"]
    integration --> bundle
    api --> bundle
    browser --> bundle
    visual --> bundle
    semantic --> bundle
    external --> bundle
    human --> bundle

    lead["Lead semantic evidence<br/>(where required)"] --> bundle
    review["Independent review evidence<br/>(where required)"] --> bundle
    cert["CertificationCore evidence<br/>(where policy requires)"] --> bundle

    bundle --> oracle["AcceptanceOracle"]
    oracle --> disposition{"Policy disposition"}
    disposition -->|Sufficient current evidence| accepted["Accepted for this candidate"]
    disposition -->|Gap, failure, or recovery| recovery["Typed recovery or suspension"]
~~~

Lead semantic evidence, independent review, and CertificationCore evidence are inputs to the EvidenceBundle only where the resolved requirements/policy require them. None independently grants product acceptance; the AcceptanceOracle evaluates the complete candidate-bound evidence set.


Validation PASS, reviewer agreement, participant completion, or Lead opinion alone cannot satisfy acceptance.

## 10. Operation and conversation state

### 10.1 ConversationTurnState

ConversationTurnState describes one interaction turn. It is separate from OperationSemanticState and is not stored as an operation state. Conversation records may persist independently.

The conversation state can include:

RECEIVED → CLASSIFYING → CONTEXT_RESOLUTION → ANSWERING → INFORMATIONAL_DONE

It can also enter CLARIFICATION_REQUIRED, OPERATION_REQUESTED, STATUS_CONTROL, or RESPONSE_COMPLETE as appropriate. INFORMATIONAL ends with its answer and creates no engineering OperationRecord. AUDIT or CHANGE may hand off from the conversation turn to a governed operation. STATUS / CONTROL may query conversation state or act on a durable operation without creating a new engineering operation.


~~~mermaid
stateDiagram-v2
    [*] --> RECEIVED
    RECEIVED --> CLASSIFYING
    CLASSIFYING --> CLARIFICATION_REQUIRED: material intent is ambiguous
    CLARIFICATION_REQUIRED --> CLASSIFYING: clarified turn

    CLASSIFYING --> CONTEXT_RESOLUTION: INFORMATIONAL
    CONTEXT_RESOLUTION --> ANSWERING
    ANSWERING --> INFORMATIONAL_DONE
    INFORMATIONAL_DONE --> [*]

    CLASSIFYING --> OPERATION_REQUESTED: governed AUDIT or CHANGE operation is created
    OPERATION_REQUESTED --> RESPONSE_COMPLETE: controller accepts handoff
    CLASSIFYING --> STATUS_CONTROL: inspect or control conversation/operation
    STATUS_CONTROL --> RESPONSE_COMPLETE
    RESPONSE_COMPLETE --> [*]
~~~

INFORMATIONAL terminates within ConversationTurnState and creates no OperationRecord. AUDIT/CHANGE handoff and STATUS_CONTROL remain distinct from operation lifecycle states.


### 10.2 OperationSemanticState

OperationSemanticState describes the one semantic state of a durable governed operation; UI status labels are projections of it. It does not contain IDLE/CONVERSATION, INTERPRETING_INTENT, CONTEXT_RESOLUTION, ANSWERING, INFORMATIONAL_DONE, or a status-query state.

The semantic operation lifecycle is:

- **AUDIT:** AUDIT_POLICY_FROZEN → AUDIT_PLANNING → AUDIT_EXECUTING → AUDIT_REVIEWING → AUDIT_DONE or typed suspension.
- **CHANGE:** OPERATION_CREATED → POLICY_RESOLUTION → POLICY_FROZEN → optional FORMALIZING → PLANNING → KNOWLEDGE_RESOLUTION → PARTICIPANT_COMPILATION → EXECUTION_FROZEN → READY_FOR_EXECUTION → EXECUTING → RESULT_RECONCILIATION → ASSEMBLING → IMPACT_ASSESSMENT → ASSURANCE_RECOMPILATION → VALIDATING → REVIEWING → QUALITY_CONVERGENCE → ACCEPTING or typed recovery → ACCEPTED → DELIVERY_READY → DELIVERING/RECONCILING as needed → COMPLETION_GATE → COMPLETED.
- **Recovery states:** REPAIRING, REPLANNING, ORACLE_DIAGNOSIS, HUMAN_REQUIRED, BLOCKED, and PAUSED. HUMAN_REQUIRED, BLOCKED, and PAUSED are resumable.
- **Terminal states:** AUDIT_DONE, COMPLETED, FAILED, and CANCELLED. RECONCILING is active and is never delivery completion.

| State or state group | Owner and durable artifacts | Mutation boundary and transition rule |
| --- | --- | --- |
| AUDIT_POLICY_FROZEN, AUDIT_PLANNING | Controller/Lead; frozen read-only audit policy, snapshot, plan, evidence requirements. | Freeze evidence scope; no product-source writes. Plan checks and reviewers; revalidate plan if stale. |
| AUDIT_EXECUTING, AUDIT_REVIEWING | Controller and read-only participants; check receipts and normalized independent findings. | Read and validate evidence only; no remediation. Reject stale evidence/reviews. |
| AUDIT_DONE | Controller; audit report and evidence bundle. | Close the audit; no product mutation. |
| OPERATION_CREATED, POLICY_RESOLUTION | Controller/Lead; operation ID, project, initial candidate/snapshot, HumanTurn, route/assurance evidence, unresolved decisions. | Create record and resolve inputs; no participant source writes. Proceed only to frozen policy, human request, or blocker. |
| POLICY_FROZEN, FORMALIZING | Controller and, when required, Spec Manager; immutable policy digest or formal artifacts/seal. | Participants cannot edit frozen policy. Formalize before seal; after seal, report contradictions rather than reinterpret artifacts. |
| PLANNING, KNOWLEDGE_RESOLUTION | Planner/Librarian under controller; WorkGraph, claims, KnowledgeGaps, KnowledgePacks, source receipts, trust results. | Propose and validate decomposition; research approved sources and register accepted skills only. No code, authority, or policy mutation. |
| PARTICIPANT_COMPILATION, EXECUTION_FROZEN | Controller/compiler; ParticipantPlan, SkillManifests, ToolPacks, budgets, resource claims, blueprint, role policies, bindings, manifest digests. | Compile deterministically. Any changed input requires recompilation; no participant may edit the frozen contracts. |
| READY_FOR_EXECUTION | Controller; current lease and materialization readiness receipts. | Mint scoped leases and materialize/rotate sessions only after checking current epoch and identity; no source mutation yet. |
| EXECUTING | Controller/participant; execution binding, process/session receipts, StructuredResults and ChangeSets. | Participant may edit only its isolated assigned scope under lease. Candidate remains C0; candidate cannot be changed directly. |
| RESULT_RECONCILIATION | Controller; parsed result, output contract, provenance and ChangeSet checks. | Accept or reject immutable results; no candidate bind or source edit. Reject stale or replayed output. |
| ASSEMBLING | Controller/CandidateAssembler; ChangeSet lineage and assembly receipt. | Integrate valid ChangeSets and record derived rebases; no history rewrite. Success alone creates C+1; failure leaves C0 unchanged. |
| IMPACT_ASSESSMENT, ASSURANCE_RECOMPILATION | Controller with bounded Lead/Oracle assessment; actual diff evidence, CandidateImpact, compiled review/validation/acceptance requirements. | Bind impact to current candidate; only strengthen requirements. Recompile when impact changes. |
| VALIDATING, REVIEWING | Controller and validators/reviewers; current candidate-bound reports, provider receipts, independent findings. | Validators and reviewers add evidence only. No source edit or acceptance; discard stale evidence. |
| QUALITY_CONVERGENCE, ACCEPTING | Controller with independent Lead/Oracle evidence; findings, counters, assertions, requirements, EvidenceBundle, disposition. | Enforce deterministic thresholds and evidence sufficiency. Missing required evidence cannot be overridden by model or reviewer opinion. |
| REPAIRING, REPLANNING, ORACLE_DIAGNOSIS | Controller with Repairer/Planner/Oracle; bounded finding packet, isolated ChangeSet, revised WorkGraph or typed diagnosis. | Repair returns a ChangeSet; assembly creates the next candidate. Replanning preserves sealed requirements and fences obsolete assignments. Diagnosis cannot self-accept or mutate source. |
| HUMAN_REQUIRED, BLOCKED, PAUSED | Controller; complete DecisionRequest/decision or blocker/retry data, saved resume state, and drain/fence receipts as applicable. | Resume only after scoped decision or dependency proof and revalidation. Pause drains/fences active writers; no implicit capability grant. |
| ACCEPTED, DELIVERY_READY | Controller; current AcceptanceOracle disposition, authorized effect list, completion requirements. | Acceptance is candidate-specific. Candidate change invalidates it. Prepare only named delivery effects; no effect is implied by acceptance. |
| DELIVERING, RECONCILING | Controller/ToolActionGate; ActionIntent, external observations, ActionReceipt or reconciled receipt. | Execute only exact authorized effects. Inspect uncertain outcomes; never blindly repeat a potentially non-idempotent effect. |
| COMPLETION_GATE, COMPLETED | Controller; current candidate, graph accounting, evidence and receipt set, terminal completion receipt. | Evaluate objective DoD only. Complete only with compatible candidate, policy, and execution identities and no required active participant. |
| FAILED, CANCELLED | Controller; exhausted recovery evidence or cancellation event, generation fences, cleanup/reconciliation receipts. | FAILED closes only after safe recovery is exhausted. CANCELLED is terminal only after writers are fenced and uncertain effects reconciled. |

C0 denotes the last assembled candidate bound to the current work; C+1 is created only by successful assembly. The controller owns every transition and persists the artifacts needed by that state. Only isolated EXECUTING or REPAIRING permits participant source changes; only ASSEMBLING advances candidate truth. Crashes reload the operation record and outbox, revalidate artifact identity, and resume from the last durable state. A potentially completed external effect enters RECONCILING.


Each durable HUMAN_REQUIRED, BLOCKED, or PAUSED suspension carries a continuation record with its continuation/resume target, suspension reason, current candidate identity, operationExecutionRevision, policy identity, and required revalidation. The controller resumes only after validating that continuation against current durable operation state. The target is the saved operation state to continue from and varies by interruption; no fixed return state is implied. The exact source schema is deferred to implementation.

Rows in the OperationSemanticState table that group multiple names are documentation compression only. Every grouped name remains a distinct semantic state with its own transition meaning. Diagram junctions, controller revalidation steps, and continuation-target references are notation only, not OperationSemanticState values.

~~~mermaid
stateDiagram-v2
    [*] --> AUDIT_POLICY_FROZEN: AUDIT
    AUDIT_POLICY_FROZEN --> AUDIT_PLANNING
    AUDIT_PLANNING --> AUDIT_EXECUTING
    AUDIT_EXECUTING --> AUDIT_REVIEWING
    AUDIT_REVIEWING --> AUDIT_DONE
    AUDIT_DONE --> [*]

    [*] --> OPERATION_CREATED: CHANGE
    OPERATION_CREATED --> POLICY_RESOLUTION
    POLICY_RESOLUTION --> POLICY_FROZEN
    POLICY_FROZEN --> FORMALIZING: FORMAL_SDD
    POLICY_FROZEN --> PLANNING: no formalization required
    FORMALIZING --> PLANNING
    PLANNING --> KNOWLEDGE_RESOLUTION
    KNOWLEDGE_RESOLUTION --> PARTICIPANT_COMPILATION
    PARTICIPANT_COMPILATION --> EXECUTION_FROZEN
    EXECUTION_FROZEN --> READY_FOR_EXECUTION
    READY_FOR_EXECUTION --> EXECUTING
    EXECUTING --> RESULT_RECONCILIATION
    RESULT_RECONCILIATION --> ASSEMBLING: valid result/ChangeSet
    RESULT_RECONCILIATION --> READY_FOR_EXECUTION: bounded retry with new generation
    RESULT_RECONCILIATION --> REPLANNING: invalid or unusable result
    ASSEMBLING --> IMPACT_ASSESSMENT: candidate assembled
    ASSEMBLING --> REPLANNING: assembly conflict
    IMPACT_ASSESSMENT --> ASSURANCE_RECOMPILATION
    ASSURANCE_RECOMPILATION --> VALIDATING
    VALIDATING --> REVIEWING
    REVIEWING --> QUALITY_CONVERGENCE

    QUALITY_CONVERGENCE --> ACCEPTING: convergence permits acceptance
    QUALITY_CONVERGENCE --> REPAIRING: bounded repair
    QUALITY_CONVERGENCE --> REPLANNING: decomposition change
    QUALITY_CONVERGENCE --> ORACLE_DIAGNOSIS: diagnosis required
    REPAIRING --> RESULT_RECONCILIATION: Repairer result
    REPLANNING --> KNOWLEDGE_RESOLUTION: knowledge must be refreshed
    REPLANNING --> PARTICIPANT_COMPILATION: plan can reuse current knowledge
    ORACLE_DIAGNOSIS --> REPAIRING: repair
    ORACLE_DIAGNOSIS --> REPLANNING: replan
    ORACLE_DIAGNOSIS --> ACCEPTING: evidence gap resolved
    ORACLE_DIAGNOSIS --> HUMAN_REQUIRED: genuine decision needed
    ORACLE_DIAGNOSIS --> BLOCKED: dependency unavailable

    ACCEPTING --> ACCEPTED: oracle disposition accepts current candidate
    ACCEPTING --> REPAIRING: acceptance finding
    ACCEPTING --> ORACLE_DIAGNOSIS: evidence gap or failure
    ACCEPTED --> DELIVERY_READY
    DELIVERY_READY --> DELIVERING: authorized effect requested
    DELIVERY_READY --> COMPLETION_GATE: no external effect requested
    DELIVERING --> COMPLETION_GATE: effects receipted
    DELIVERING --> RECONCILING: effect outcome uncertain
    RECONCILING --> COMPLETION_GATE: exact effect reconciled
    RECONCILING --> DELIVERY_READY: no effect occurred and retry is policy-authorized
    RECONCILING --> HUMAN_REQUIRED: external state needs a person
    RECONCILING --> BLOCKED: external state remains unknown
    COMPLETION_GATE --> COMPLETED: objective DoD satisfied
    COMPLETION_GATE --> BLOCKED: required evidence or dependency missing
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELLED --> [*]

    state "Any active nonterminal state (diagram junction only)" as ACTIVE
    ACTIVE --> HUMAN_REQUIRED: true human decision required
    ACTIVE --> BLOCKED: external/system dependency blocks progress
    ACTIVE --> PAUSED: explicit pause after safe drain
    ACTIVE --> FAILED: recovery exhausted
    ACTIVE --> CANCELLED: cancellation after fencing/reconciliation

    HUMAN_REQUIRED --> REVALIDATE: decision supplied
    BLOCKED --> REVALIDATE: dependency proven available
    PAUSED --> REVALIDATE: explicit resume
    HUMAN_REQUIRED --> CANCELLED: cancel after fencing/reconciliation
    BLOCKED --> CANCELLED: cancel after fencing/reconciliation
    PAUSED --> CANCELLED: cancel after fencing/reconciliation
    BLOCKED --> FAILED: recovery exhausted
    state "Controller revalidates continuation" as REVALIDATE
    REVALIDATE --> RESUME_TARGET
    state "Saved continuation target (reference, not a state value)" as RESUME_TARGET
~~~

The diagram's ACTIVE node is a visual junction for the prose rule that an active nonterminal operation may suspend; it is not a persisted state. HUMAN_REQUIRED, BLOCKED, and PAUSED all resume through the same revalidation path to their recorded, potentially different continuation targets.


Pause drains and fences workers before PAUSED. Resume reloads state and revalidates identity. Cancellation fences workers and revokes leases; if an external effect may have happened, cancellation passes through RECONCILING. Cancellation is terminal only after active writers are fenced and uncertain effects are reconciled.

### 10.3 Participant state machine

The controller owns participant transitions; a participant message cannot set authoritative state.

CREATED → BOUND → STARTING → RUNNING → SETTLING → SETTLED

A participant may instead reach FAILED, CANCELLED, or STALE.


~~~mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> BOUND
    BOUND --> STARTING
    STARTING --> RUNNING
    RUNNING --> SETTLING
    SETTLING --> SETTLED
    CREATED --> FAILED
    BOUND --> FAILED
    STARTING --> FAILED
    RUNNING --> FAILED
    SETTLING --> FAILED
    CREATED --> CANCELLED
    BOUND --> CANCELLED
    STARTING --> CANCELLED
    RUNNING --> CANCELLED
    SETTLING --> CANCELLED
    CREATED --> STALE
    BOUND --> STALE
    STARTING --> STALE
    RUNNING --> STALE
    SETTLING --> STALE
    SETTLED --> STALE
    SETTLED --> [*]
    FAILED --> [*]
    CANCELLED --> [*]
    STALE --> [*]

    note right of SETTLED
      Participant SETTLED != WorkUnit accepted
      Participant SETTLED != Candidate accepted
      Participant SETTLED != Operation completed
    end note
~~~

SETTLED means only that the controller accepted the participant artifact/result as provenance-valid. WorkUnit acceptance, candidate acceptance, and operation completion are separate gates.


- CREATED: assignment compiled; no session or lease.
- BOUND: participant, generation, candidate, blueprint, role, skill/context/prompt manifests, output contract, and resource claims are bound.
- STARTING: capability lease is checked and runtime/session materialized.
- RUNNING: isolated work executes within assigned scope.
- SETTLING: provider is quiesced; result, process receipt, and output contract are parsed and checked.
- SETTLED: controller accepts the artifact/result as provenance-valid. This does not imply operation acceptance.
- FAILED: process or contract failed; recovery may create a new generation.
- CANCELLED: controller fenced and stopped the generation.
- STALE: candidate, policy, blueprint, epoch, or generation changed; output cannot be accepted or reused.

## 11. Human interaction and delivery

AEH continues autonomously when repository evidence, frozen requirements, and policy derive the answer. It asks a human for a true product choice, contradiction, external blocker needing a person, authorization, policy confirmation, or policy-required irreversible/high-impact action.

Delivery begins only after the current candidate passes validation, required review, acceptance, and policy-required certification. Acceptance does not imply an external effect. Requested and authorized effects are enumerated in frozen policy.

Every sensitive effect persists ActionIntent, passes ToolActionGate, executes against the bound candidate and authority, then persists ActionReceipt. A crash after the effect but before receipt enters RECONCILING. The controller checks observable external state and records a reconciled receipt. It never blindly repeats a potentially non-idempotent effect. Unknown state ends in BLOCKED or HUMAN_REQUIRED according to policy.

## 12. Objective Definition of Done

- **INFORMATIONAL_DONE:** an answer is produced from bounded read-only context; no change operation was created.
- **AUDIT_DONE:** frozen read-only audit ran required checks/review and persisted current-snapshot findings/evidence; no remediation occurred.
- **WORKUNIT_DONE:** current participant generation, valid output contract and provenance, required result artifact, candidate-bound ChangeSet where applicable, and focused evidence.
- **WAVE_DONE:** required siblings accounted for; resource claims respected; ChangeSets reconciled; candidate assembled; validation barrier passed or typed recovery entered.
- **IMPLEMENTATION_DONE:** WorkGraph accounted for and current candidate contains accepted implementation ChangeSets. This is not product acceptance.
- **VALIDATION_DONE:** every resolved ValidationRequirement has current candidate-bound evidence.
- **REVIEW_DONE:** every required ReviewDimension has independent current evidence and Quality Gate permits progression.
- **ACCEPTANCE_DONE:** every required AcceptanceAssertion has sufficient current evidence; required oracle paths finished; AcceptanceOracle disposition and policy-required certification permit acceptance.
- **DELIVERY_DONE:** each requested and authorized external effect has an ActionReceipt or safe reconciled equivalent; no unknown effect is assumed.
- **OPERATION_COMPLETED:** one known current Candidate with matching workspace; WorkGraph accounted for; current required validation, review, acceptance, and certification evidence; delivery reconciled; no blocking current-candidate finding; no required participant active; terminal evidence shares compatible candidate, policy, and execution identities.

## 13. Control Center semantic model

Control Center is a semantic projection of authoritative operation state. It cannot accept a decision or state transition on its own. Every control goes through the controller and current identity checks.

Home shows registered projects, health, active operations, human-required operations, and recent outcomes. Project view shows conversation; operation intent, route, assurance, state, and controller; WorkGraph and resource claims; knowledge gaps, packs, and active ephemeral skills; participant role, specialization, session, and generation; candidate revisions, lineage, and impact; validation requirements/evidence; review dimensions, findings, and convergence; acceptance assertions, oracles, and certification; HumanDecisions and blockers; delivery intents, receipts, and reconciliation; and provenance history.

Users see semantic progress and can inspect underlying evidence. Human-decision requests and controls use typed contracts and are validated by the authoritative server/controller.

## 14. Learning boundary

Memory, telemetry, logs, and evals are observations. They are not learning or authority.

Post-v2 learning may produce a versioned learning candidate from observations, followed by evaluation, independent review/trust, and recommendation or explicit governed adoption. Learned state cannot implicitly change authority, policy, acceptance criteria, tools, or canonical skills. Persistent skill promotion uses successful operation evidence and independent evaluation after the operation; it cannot change the authority of the operation that produced the candidate.

## 15. Certification

Deterministic contract evidence and real-provider evidence are separate lanes. CertificationCore applies a frozen policy to a freshly packed candidate, provider startup/execution receipts, deterministic oracle checks, and required independent review. A fake provider or fixture may prove a deterministic contract; it cannot produce PROVIDER_CERTIFIED.

The capability matrix explicitly covers, where claimed: Codex/model semantic assessment, OpenCode worker, Paseo, rootless Podman/OCI, Serena, Librarian research, integration environments, Pact/OpenAPI, Playwright/browser, security/SAST, supply chain, and delivery/reconciliation. SBOM/SLSA/in-toto/Cosign and provider receipts are candidate/build-bound. No paid hosted dependency is mandatory.

## 16. Self-hosting gate

Self-hosting readiness is a deterministic composite gate, not an executor. AEH cannot govern its actual development checkout until the gate passes.

The gate requires versioned evidence for candidate truth; controller fencing; capability authority; policy freeze; execution identity and provenance; SkillManifest and context; Paseo session identity; impact-driven assurance; validation; independent review; acceptance/oracle; repair/replan; human exception handling; delivery reconciliation; runtime recovery; sandbox/security; supply chain; real-provider certification; and adversarial/fault injection.

The final disposable self-modification campaign proves that the source checkout remains untouched, the packed candidate controls only the disposable fixture, all candidate and repair mutations stay inside it, side effects reconcile, and cleanup succeeds. A deterministic gate aggregates evidence; no model can declare readiness.

Cross-run learning, persistent promotion of operation-local skills, and automatic learned changes to policy, authority, acceptance criteria, tools, or canonical skills remain governed post-v2 proposals. Real-provider certification and self-hosting are Core-v2 readiness gates.
