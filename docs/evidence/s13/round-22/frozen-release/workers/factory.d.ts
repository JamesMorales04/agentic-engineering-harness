import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig } from "../core/types.js";
import type { WorkerExecutor } from "./types.js";
export declare function createWorkerExecutor(config: HarnessProjectConfig, selection?: AgentExecutionSelection): WorkerExecutor;
