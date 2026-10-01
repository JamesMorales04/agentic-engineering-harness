export type DurableWakeTarget = "lead" | "supervisor";
export type DurableWakeReason = "progress" | "blocked" | "stalled" | "terminal";
export interface OperationWakeBudget {
    version: 1;
    operationId: string;
    revision: number;
    supervisorAccepted: number;
    leadAccepted: number;
    terminalLeadAccepted: number;
    updatedAt: string;
    lastAcceptedAt?: string;
}
export declare function operationWakeBudgetFile(root: string, operationId: string): string;
export declare function loadOperationWakeBudget(root: string, operationId: string, revision: number): Promise<OperationWakeBudget>;
export declare function recordOperationWakeAccepted(root: string, operationId: string, revision: number, target: DurableWakeTarget, reason: DurableWakeReason): Promise<OperationWakeBudget>;
