import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
export type DeliveryFinalizationStatus = "SKIPPED" | "HANDOFF_ONLY" | "NO_CHANGES" | "FINALIZED" | "BLOCKED_EXTERNAL" | "BLOCKED_SUPPLY_CHAIN" | "SYSTEM_FAILURE";
export interface DeliveryFinalizationResult {
    status: DeliveryFinalizationStatus;
    humanRequired: boolean;
    committed: boolean;
    commitSha?: string;
    pushed: boolean;
    pullRequest?: {
        number: number;
        url: string;
        draft: boolean;
    };
    candidate?: CandidateRevisionV1;
    message: string;
}
export declare function finalizeAcceptedIssue(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: {
    candidate?: CandidateRevisionV1;
}): Promise<DeliveryFinalizationResult>;
export declare function deliveryFinalizationFailure(error: unknown): DeliveryFinalizationResult;
