import type { SeverityCounts } from "../agents/qualityConvergence.js";
import type { PlannerOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, RunMetrics, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "./types.js";
import { type DeliveryFinalizationResult } from "../delivery/finalize.js";
import { type SemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import { type CandidateAssuranceCompilationV1 } from "../architecture/candidateAssurance.js";
import { type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import type { CandidateImpactV1 } from "../candidates/assembler.js";
import { type AcceptanceOracleDispositionV1, type EvidenceBundleV1 } from "../architecture/acceptanceOracle.js";
import { evaluateObjectiveCompletionV1, type ObjectiveCompletionInputV1 } from "../architecture/objectiveCompletion.js";
export interface CandidateAssuranceEvaluationV1 {
    compilation?: CandidateAssuranceCompilationV1;
    validationChecks: ValidationCheck[];
    gateCheck: ValidationCheck;
}
export interface TaskRunResult {
    taskId: string;
    status: "PASS" | "FAIL";
    attempts: number;
    worker: WorkerSession;
    report: ValidationReport;
    metrics: RunMetrics;
    routing?: {
        profile?: string;
        ruleIds: string[];
        agent: string;
        runtime: string;
        model: string;
        nativeAgent?: string;
        reviewers: string[];
        implementationRoute?: string;
        assurance?: string;
    };
    planning?: {
        used: boolean;
        workUnits: number;
        waves: number;
        distributed: boolean;
        graphUsed?: boolean;
        compilerDigest?: string;
    };
    controlPlane?: {
        sha256: string;
        gitCommit?: string;
        drifted: boolean;
        changed: string[];
        missing: string[];
        added: string[];
    };
    evidence?: {
        sha256: string;
        complete: boolean;
        requirements: number;
        reasons: string[];
    };
    candidateAssurance?: CandidateAssuranceEvaluationV1;
    acceptanceOracle?: AcceptanceOracleDispositionV1;
    acceptanceOracleArtifact?: string;
    evidenceBundle?: EvidenceBundleV1;
    objectiveCompletion?: ObjectiveCompletionInputV1;
    objectiveCompletionDecision?: ReturnType<typeof evaluateObjectiveCompletionV1>;
    review?: {
        status: "PASS" | "FAIL";
        finalState: string;
        humanRequired: boolean;
        rounds: number;
        findings: number;
        debtScore: number;
        debtPoints: number;
        counts: SeverityCounts;
        convergence: string;
        leadAccepted?: boolean;
        reviewerSessions: number;
    };
    delivery?: DeliveryFinalizationResult;
}
export declare function runTask(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: {
    profile?: string;
    planning?: PlannerOutput;
    semanticRuntime?: SemanticAssessmentRuntimeV1;
}): Promise<TaskRunResult>;
export { objectiveParticipantAccountingV1 } from "../operations/participantAccounting.js";
export declare function runCandidateImpactValidations(input: {
    root: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    report: ValidationReport;
    impact: CandidateImpactV1;
    compilation: CandidateAssuranceCompilationV1;
    resolution: ValidationResolutionV1;
    /** Defaults to the current impact requirements; callers may include resolved base requirements. */
    requirements?: readonly import("../architecture/validationRequirements.js").ValidationRequirementV1[];
}): Promise<ValidationCheck[]>;
/**
 * Bounded deterministic failure detail for a failed validation report. A FAILED operation must
 * carry the owning failing checks in its own durable record so the terminal cause is diagnosable
 * without the disposable fixture (AEH-V2-0118); report messages are truncated, never interpreted.
 */
export declare function validationFailureDetail(report: ValidationReport, limit?: number): string;
export declare function operationFailureDetail(result: Pick<TaskRunResult, "status" | "report" | "review">): string;
