import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import type { WorkerExecutor } from "./types.js";
export declare class PodmanWorkerExecutor implements WorkerExecutor {
    readonly name = "podman";
    doctor(root: string, config: HarnessProjectConfig): Promise<{
        ok: boolean;
        message: string;
    }>;
    start(root: string, config: HarnessProjectConfig, contract: TaskContract, selection?: AgentExecutionSelection): Promise<WorkerSession>;
    repair(root: string, config: HarnessProjectConfig, contract: TaskContract, session: WorkerSession, packet: RepairPacket, selection?: AgentExecutionSelection): Promise<WorkerSession>;
}
