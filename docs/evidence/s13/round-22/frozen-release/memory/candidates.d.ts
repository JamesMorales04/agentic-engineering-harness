import type { TaskContract, ValidationReport } from "../core/types.js";
import type { MemoryRecord } from "../providers/types.js";
export interface AcceptedOperationArtifacts {
    root: string;
    project: string;
    operationId?: string;
    contract: TaskContract;
    result: {
        taskId: string;
        status: string;
        attempts: number;
        report: ValidationReport;
        evidence?: {
            complete: boolean;
            requirements: number;
            sha256: string;
        };
        review?: {
            status: string;
            rounds: number;
            findings: number;
        };
    };
    runFile: string;
    reportFile?: string;
    evidenceFile?: string;
}
/** Build bounded, artifact-backed memory. No prompt or chain-of-thought is read. */
export declare function buildAcceptedOperationCandidates(input: AcceptedOperationArtifacts): Promise<MemoryRecord[]>;
