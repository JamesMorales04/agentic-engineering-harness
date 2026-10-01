import type { AgentExecutionSelection, ResolvedRoute } from "./types.js";
import { type DedupedFindings } from "./findings.js";
import { type QualityState } from "./qualityConvergence.js";
import { type ExceptionDecision } from "./exceptionDetection.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1 } from "../candidates/assembler.js";
import type { CandidateAssuranceCompilationV1 } from "../architecture/candidateAssurance.js";
export type ReviewFinalState = "ACCEPTED" | "SPEC_CONTRADICTION" | "REQUIRES_PRODUCT_DECISION" | "BLOCKED_EXTERNAL" | "SYSTEM_FAILURE";
/**
 * A reviewer turn that did not produce reviewable evidence: the provider session stopped on an
 * approval/permission prompt, the runtime exited non-zero, the reviewer attempted a mutation, or
 * its structured output contract was invalid. None of these can be repaired by changing the
 * implementation, so they must terminalize as a typed SYSTEM_FAILURE instead of entering the
 * autonomous remediation loop as synthetic critical findings (AEH-V2-0119).
 */
export interface ReviewerRoundFailureV1 {
    reviewer: string;
    kind: "RUNTIME" | "CONTRACT" | "MUTATION";
    detail: string;
    sessionId?: string;
    exitCode?: number;
}
export interface ReviewRoundResult {
    findings: DedupedFindings;
    failures: ReviewerRoundFailureV1[];
}
export interface ReviewLifecycleResult {
    status: "PASS" | "FAIL";
    finalState: ReviewFinalState;
    humanRequired: boolean;
    rounds: number;
    report: ValidationReport;
    findings: DedupedFindings;
    checks: ValidationCheck[];
    sessions: WorkerSession[];
    qualityHistory: QualityState[];
    leadAccepted?: boolean;
    exception?: ExceptionDecision;
}
export declare function runReviewLifecycle(input: {
    root: string;
    stateRoot?: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    route: ResolvedRoute;
    reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>;
    leadSelection?: AgentExecutionSelection;
    repairerSelection?: AgentExecutionSelection;
    executionCatalog?: ExecutionCatalogV1;
    prepareRepairWorkspace?: (isolatedRoot: string) => Promise<void>;
    stageSelections?: Readonly<Record<string, AgentExecutionSelection | undefined>>;
    supervisorSelection?: AgentExecutionSelection;
    implementationSelection: AgentExecutionSelection;
    report: ValidationReport;
    candidateImpact?: CandidateImpactV1;
    candidateImpactAssessment?: CandidateImpactAssessmentRuntimeV1;
    candidateAssurance?: CandidateAssuranceCompilationV1;
    assuranceGateCheck?: ValidationCheck;
    recompileCandidateAssurance?: (impact: CandidateImpactV1 | undefined, report: ValidationReport) => Promise<{
        compilation?: CandidateAssuranceCompilationV1;
        validationChecks: ValidationCheck[];
        gateCheck: ValidationCheck;
    }>;
    revalidate: () => Promise<ValidationReport>;
}): Promise<ReviewLifecycleResult>;
/** Bounded autonomous remediation budget (deterministic execution policy, AEH-V2-0119). */
export declare function remediationBudgetRounds(config: HarnessProjectConfig): number;
export declare function remediationBudgetReached(rounds: number, config: HarnessProjectConfig): boolean;
/**
 * Replace a reviewer's superseded round checks with the current round's check. A report carries
 * checks across review/remediation rounds; an earlier failed round for a superseded candidate is
 * not the current candidate's review state and must not poison the merged report status once a
 * newer round produced the current evidence. Exactly one current check remains per reviewer.
 */
export declare function replaceSupersededReviewerChecksV1(checks: ValidationCheck[], round: number, reviewer: string, check: ValidationCheck): void;
