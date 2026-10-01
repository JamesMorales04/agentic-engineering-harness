import type { HarnessProjectConfig, RepairPacket, ValidationReport } from "./types.js";
import type { FailureType } from "../agents/types.js";
export declare function createRepairPacket(report: ValidationReport, attempt: number, context?: {
    failureType?: FailureType;
    failedAgent?: string;
    recoveryAction?: string;
}): RepairPacket;
export declare function writeRepairPacket(root: string, config: HarnessProjectConfig, packet: RepairPacket): Promise<string>;
