import type { HarnessProjectConfig } from "../core/types.js";
import type { OperationRecordV2, OperationStatus } from "./state.js";
export interface OperationPortfolioEntry {
    operationId: string;
    kind: string;
    status: OperationStatus;
    phase: string;
    workspaceId?: string;
    supervisorAgentId?: string;
    supervisorGeneration?: number;
    revision: number;
    acknowledgedRevision: number;
    priority: number;
    updatedAt: string;
}
export interface OperationPortfolio {
    version: 1;
    project: string;
    leadAgentId?: string;
    leadGeneration: number;
    updatedAt: string;
    operations: Record<string, OperationPortfolioEntry>;
}
export interface OperationConcurrencyPolicy {
    maxActiveOperations: number;
    maxActiveAgents: number;
    maxAgentsPerOperation: number;
    maxProviderAgents: Record<string, number>;
}
export declare function operationPortfolioFile(root: string): string;
export declare function loadOperationPortfolio(root: string, project?: string): Promise<OperationPortfolio>;
export declare function syncOperationPortfolio(root: string, project: string, operation: OperationRecordV2): Promise<OperationPortfolio>;
export declare function bindPortfolioLead(root: string, project: string, agentId: string, generation?: number): Promise<OperationPortfolio>;
export declare function operationConcurrencyPolicy(config: HarnessProjectConfig): OperationConcurrencyPolicy;
export declare function assertOperationCapacity(root: string, config: HarnessProjectConfig, requestedPriority?: number): Promise<void>;
