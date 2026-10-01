import { type OperationRecordV2 } from "./state.js";
export declare function supervisorInitializationProjection(operation: OperationRecordV2, generation: number): Record<string, unknown>;
export declare function supervisorConsolidationProjection(operation: OperationRecordV2): Record<string, unknown>;
export declare function supervisorHandoffProjection(operation: OperationRecordV2, generation: number, checkpointArtifact: string): Record<string, unknown>;
export declare function supervisorCheckpointProjection(operation: OperationRecordV2, contextRatio?: number): Record<string, unknown>;
export declare function compactDeterministicEvidence(value: unknown): unknown;
