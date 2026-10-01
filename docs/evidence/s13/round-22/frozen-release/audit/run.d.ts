import type { ResolvedAgentTopology } from "../agents/types.js";
import { type NormalizedFinding } from "../agents/outputContracts.js";
import { type QualityGateResult, type SeverityCounts } from "../agents/qualityConvergence.js";
import type { HarnessProjectConfig, TaskRisk, ValidationCheck, WorkerSession } from "../core/types.js";
import type { IntentDecisionV1 } from "./intentDecision.js";
export type AuditFailureClass = "NONE" | "ASSERTION_FAILURE" | "ENVIRONMENT_FAILURE" | "SANDBOX_DENIAL" | "MISSING_DEPENDENCY" | "TOOL_FAILURE";
export type AuditStatus = "CLEAN" | "FINDINGS" | "DEGRADED";
export interface AuditRequest {
    request: string;
    files?: string[];
    domains?: string[];
    risk?: TaskRisk;
    reviewers?: string[];
    auditId?: string;
    intentDecision?: IntentDecisionV1;
}
export interface AuditValidationCheck extends ValidationCheck {
    failureClass: AuditFailureClass;
}
export interface AuditReport {
    version: 1;
    auditId: string;
    intent: "audit";
    intentDecision?: IntentDecisionV1;
    request: string;
    status: AuditStatus;
    startedAt: string;
    finishedAt: string;
    repository: {
        root: string;
        commit?: string;
        baseRef: string;
        dirtyPaths: string[];
    };
    reviewers: string[];
    validationChecks: AuditValidationCheck[];
    findings: NormalizedFinding[];
    counts: SeverityCounts;
    debtPoints: number;
    debtScore: number;
    qualityGate: QualityGateResult;
    productionSafe: boolean;
    sessions: WorkerSession[];
    restoredPaths: string[];
    controlPlaneSha256?: string;
    supervisor?: {
        generation: number;
        consolidationArtifact: string;
        summary: string;
        conflicts: number;
        missingEvidence: string[];
    };
}
export declare function runAudit(root: string, config: HarnessProjectConfig, input: AuditRequest): Promise<AuditReport>;
export declare function loadAuditReport(root: string, auditId: string): Promise<AuditReport>;
export declare function classifyValidationCheck(check: ValidationCheck): AuditValidationCheck;
export declare function classifyAuditFailure(check: ValidationCheck): AuditFailureClass;
export declare function selectAuditReviewers(topology: ResolvedAgentTopology, input: AuditRequest): string[];
