export type OperationArtifactKind = "agent" | "consolidation" | "supervisor-checkpoint";
export interface OperationArtifactEnvelope<T = unknown> {
    version: 1;
    operationId: string;
    kind: OperationArtifactKind;
    key: string;
    createdAt: string;
    payload: T;
}
export declare function persistOperationAgentArtifact<T>(root: string, operationId: string, key: string, payload: T): Promise<string>;
export declare function persistOperationConsolidation<T>(root: string, operationId: string, key: string, payload: T): Promise<string>;
export declare function persistSupervisorCheckpoint<T>(root: string, operationId: string, generation: number, payload: T): Promise<string>;
export declare function loadOperationArtifact<T = unknown>(root: string, relativePath: string): Promise<OperationArtifactEnvelope<T>>;
