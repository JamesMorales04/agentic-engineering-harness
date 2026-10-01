import { type ExplorerOutput, type PlannerOutput } from "../agents/outputContracts.js";
import { type TaskRunResult } from "../core/run.js";
import { type ChangePreflightV1, type TriageDecision } from "../core/triage.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import { type DurableAgentEvidence } from "./changeHandoff.js";
import { type ChangeInputReference } from "./changeInputs.js";
import { type ChangeOperationPayload, type OperationRecordV2 } from "./state.js";
import { createSemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import { launchManagedPaseoAgent } from "../paseo/runtime.js";
import { type DecisionChoiceV1 } from "../security/humanDecision.js";
export interface ChangeOperationResult {
    taskId: string;
    route: ImplementationRoute;
    triageReasons: string[];
    run: TaskRunResult;
    specChange?: string;
}
export interface PreparedChangeOperation {
    triage: TriageDecision;
    semanticRuntime: Awaited<ReturnType<typeof createSemanticAssessmentRuntimeV1>>;
}
export declare function resolveChangePreflightV1(root: string, config: HarnessProjectConfig, payload: ChangeOperationPayload, options?: {
    launch?: typeof launchManagedPaseoAgent;
}): Promise<ChangePreflightV1>;
interface ProductChoiceSelectionV1 {
    requestId: string;
    decisionId: string;
    choiceId: string;
    choice: DecisionChoiceV1;
    reason: string;
}
/** Resolve route and assurance before the controller authorizes bootstrap effects. */
export declare function prepareChangeOperation(root: string, config: HarnessProjectConfig, operation: OperationRecordV2, payload: ChangeOperationPayload): Promise<PreparedChangeOperation>;
export declare function runChangeOperation(root: string, controlRoot: string, config: HarnessProjectConfig, operation: OperationRecordV2, payload: ChangeOperationPayload, prepared?: PreparedChangeOperation): Promise<ChangeOperationResult>;
/**
 * DETERMINISTIC spec-escalation policy advance. Durable explorer/planner evidence may escalate a
 * DELEGATED change to FORMAL_SDD with a higher assurance; that is an execution-semantics change, so
 * the operation execution revision advances, the superseded policy is cleared, and a policy with
 * the escalated route/assurance is recompiled for the current candidate and epoch. Repeating the
 * same escalation is idempotent (same semantics digest, identical policy).
 */
export declare function rebindEscalatedChangePolicy(input: {
    controlRoot: string;
    operationId: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    escalationEvidence: Record<string, unknown>;
}): Promise<OperationRecordV2>;
/**
 * DETERMINISTIC controller-authoring candidate advance (AEH-V2-0126). FORMAL_SDD persists the
 * validated Spec Manager content and compiles the sealed OpenSpec artifacts into the bound
 * candidate workspace after the candidate was frozen. Those controller-owned writes change the
 * workspace source digest, so the next participant launch (and the Planner's accepted result)
 * would be rejected `CANDIDATE_WORKSPACE_MISMATCH` against the stale binding. This advance binds
 * exactly one successor CandidateRevision for the authored transition, records the deterministic
 * ASSEMBLY lineage receipt for the authored change (the Spec Manager is the producing bounded
 * participant), and invalidates the frozen policy and participant execution bindings through the
 * canonical `bindOperationCandidate` path; the next launch recompiles the policy for the advanced
 * candidate. It is idempotent: an unchanged workspace digest never advances a revision.
 */
export declare function advanceCandidateForControllerAuthoring(input: {
    root: string;
    controlRoot: string;
    config: HarnessProjectConfig;
    operationId: string;
    taskId: string;
    changeName: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    contract?: TaskContract;
}): Promise<{
    advanced: boolean;
    revision: number;
    identityDigest: string;
}>;
export interface SpecEscalationConstraintV1 {
    constraint: "PLANNER_FORMALIZATION_NEED_REQUIRED";
    plannerFormalizationNeed: "REQUIRED";
    plannerFormalizationReason?: string;
    plannerFormalizationEvidenceRefs: string[];
}
/**
 * DETERMINISTIC post-discovery escalation constraint for the HYBRID route. The Planner owns the
 * typed semantic `formalizationNeed` judgment over its evidence (including durable Explorer
 * findings); this constraint escalates a DELEGATED route to FORMAL_SDD only when that judgment is
 * `REQUIRED`. Explorer finding statuses are discovery-quality facts (CONFIRMED/PARTIAL/
 * NOT_REPRODUCED/BLOCKED) — for example a PARTIAL finding may mean the Explorer could not execute a
 * validator in its read-only session — and are not by themselves a formalization need. Incomplete
 * discovery that needs formal authoring must surface through the Planner's typed judgment with its
 * reason and evidence refs, which are recorded as durable escalation provenance (AEH-V2-0110).
 */
export declare function specEscalationConstraintV1(plannerEvidence?: DurableAgentEvidence<PlannerOutput>): SpecEscalationConstraintV1 | undefined;
export declare function requiresSpecEscalation(plannerEvidence?: DurableAgentEvidence<PlannerOutput>): boolean;
export declare function formalizeEscalatedTriage(triage: TriageDecision): TriageDecision;
export declare function normalizeAgentProfile(profile?: string): string | undefined;
/** Deterministic Explorer prompt contract (AEH-V2-0125 regression surface). */
export declare function buildExplorerPrompt(operationId: string, payload: ChangeOperationPayload, inputs: ChangeInputReference[]): string;
/** Deterministic Planner prompt contract (AEH-V2-0125 regression surface). */
export declare function buildPlannerPrompt(operationId: string, contract: TaskContract, payload: ChangeOperationPayload, explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined, inputs: ChangeInputReference[]): string;
export declare function buildSpecManagerPrompt(payload: ChangeOperationPayload, changeName: string, explorerEvidence: DurableAgentEvidence<ExplorerOutput> | undefined, plannerEvidence: DurableAgentEvidence<PlannerOutput> | undefined, inputs: ChangeInputReference[], selectedChoice?: ProductChoiceSelectionV1): string;
export {};
