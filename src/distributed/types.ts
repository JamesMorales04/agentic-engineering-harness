import type { AgentExecutionSelection } from "../agents/types.js";
import type { DelegationTask } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";

export interface DistributedDelegationJob {
  version: 1;
  id: string;
  parentTaskId: string;
  createdAt: string;
  repositoryUrl: string;
  baseRef: string;
  controllerSha256?: string;
  task: DelegationTask;
  contract: TaskContract;
  selection: AgentExecutionSelection;
  config: HarnessProjectConfig;
  prompt: string;
}

export interface DistributedDelegationResult {
  version: 1;
  jobId: string;
  workerId: string;
  startedAt: string;
  finishedAt: string;
  status: "PASS" | "FAIL";
  session: WorkerSession;
  changedFiles: string[];
  patch: string;
  message?: string;
}

export interface ClaimedJob { job: DistributedDelegationJob; leaseId: string; }
