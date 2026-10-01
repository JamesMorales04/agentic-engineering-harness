import type { HarnessProjectConfig } from "../core/types.js";
import { type OperationLivenessDeps, type OperationWakeDecision } from "./livenessV2.js";
export * from "./livenessV2.js";
export declare function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): Promise<OperationWakeDecision>;
export declare function monitorOperationLiveness(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): Promise<void>;
export declare function startOperationWatchdog(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): () => void;
