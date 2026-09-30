import type { HarnessProjectConfig, TaskContract } from "./types.js";
import { type TriageDecision, type TriageEvidence } from "./triage.js";
export interface CreateRoutedContractInput {
    title: string;
    request: string;
    scope: string[];
    acceptance?: string[];
    domains?: string[];
    risk?: "low" | "medium" | "high";
    flags?: TriageEvidence["flags"];
    profile?: string;
    requirements?: Array<{
        id: string;
        description?: string;
        validators?: string[];
    }>;
    routeDecision?: TriageDecision;
}
export declare function createRoutedContract(root: string, config: HarnessProjectConfig, taskId: string, input: CreateRoutedContractInput): Promise<{
    file: string;
    contract: TaskContract;
}>;
export declare function rejectLegacyTaskContract(value: unknown): never;
