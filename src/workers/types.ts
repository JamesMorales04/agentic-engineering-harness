import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";

export interface WorkerExecutor {
  readonly name: string;
  doctor(root: string, config: HarnessProjectConfig): Promise<{ ok: boolean; message: string }>;
  start(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<WorkerSession>;
  repair(root: string, config: HarnessProjectConfig, contract: TaskContract, session: WorkerSession, packet: RepairPacket): Promise<WorkerSession>;
}
