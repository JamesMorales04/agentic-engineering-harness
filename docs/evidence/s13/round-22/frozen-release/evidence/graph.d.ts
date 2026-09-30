import type { NormalizedFinding, PlannerOutput } from "../agents/outputContracts.js";
import type { DeliveryFinalizationResult } from "../delivery/finalize.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CandidateWorkspaceIdentityEvidenceV1 } from "../candidates/identity.js";
export type EvidenceNodeType = "run" | "requirement" | "task" | "file" | "check" | "finding" | "agent-session" | "commit" | "pull-request";
export interface EvidenceNode {
    id: string;
    type: EvidenceNodeType;
    label: string;
    data?: Record<string, unknown>;
}
export interface EvidenceEdge {
    from: string;
    to: string;
    type: "contains" | "implemented-by" | "changed" | "validated-by" | "reported-by" | "located-in" | "produced" | "finalized-as" | "delivered-by";
}
export interface RequirementCoverage {
    requirementId: string;
    implementation: boolean;
    validation: boolean;
    requiredCapabilities: string[];
    passingValidators: string[];
    missingValidators: string[];
    files: string[];
    tasks: string[];
    complete: boolean;
}
export interface RequirementEvidenceGraph {
    version: 1;
    taskId: string;
    createdAt: string;
    candidate?: CandidateRevisionV1;
    candidateWorkspaceIdentity?: CandidateWorkspaceIdentityEvidenceV1;
    nodes: EvidenceNode[];
    edges: EvidenceEdge[];
    requirements: RequirementCoverage[];
    complete: boolean;
    reasons: string[];
    sha256: string;
}
export declare function buildRequirementEvidenceGraph(input: {
    root: string;
    stateRoot?: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    report: ValidationReport;
    plan?: PlannerOutput;
    findings?: NormalizedFinding[];
    sessions?: WorkerSession[];
    delivery?: DeliveryFinalizationResult;
}): Promise<RequirementEvidenceGraph>;
export declare function evidenceValidationCheck(graph: RequirementEvidenceGraph, config: HarnessProjectConfig): ValidationCheck;
