import { spawn } from "node:child_process";
import { type OperationRecordV2 } from "./state.js";
export interface SpawnOperationMonitorOptions {
    nodeExecutable: string;
    entryFile: string;
    spawnProcess?: typeof spawn;
}
export declare function spawnOperationMonitor(root: string, operation: OperationRecordV2, options: SpawnOperationMonitorOptions): Promise<number | undefined>;
