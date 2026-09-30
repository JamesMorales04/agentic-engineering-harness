import type { AgentExecutionSelection } from "../agents/types.js";
import type { RepairPacket, TaskContract } from "../core/types.js";
export declare function buildWorkerPrompt(contract: TaskContract, selection?: AgentExecutionSelection): string;
export declare function buildRepairPrompt(packet: RepairPacket): string;
