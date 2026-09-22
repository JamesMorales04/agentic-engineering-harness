import type { AgentExecutionSelection } from "../agents/types.js";
import type { WorkUnitOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import type { ExecutionAuthorityV1 } from "../security/executionLease.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { ExecutionBindingV2, SkillManifestV1, RoleInvocationPolicyV1 } from "../architecture/executionIdentity.js";
import type { ExecutionBlueprintV2 } from "../architecture/executionIdentity.js";

export interface DistributedDelegationJob {
  version: 2;
  id: string;
  parentTaskId: string;
  createdAt: string;
  repositoryUrl: string;
  baseRef: string;
  baseCandidate: CandidateRevisionV1;
  controllerSha256?: string;
  candidatePatch: string;
  task: WorkUnitOutput;
  contract: TaskContract;
  selection: AgentExecutionSelection;
  sandboxPolicySha256: string;
  executionAuthority: ExecutionAuthorityV1;
  executionBlueprint: ExecutionBlueprintV2;
  roleInvocationPolicy: RoleInvocationPolicyV1;
  skillManifest: SkillManifestV1;
  sessionPreparation: { contextManifest: Readonly<Record<string, unknown>>; contextManifestDigest: string; promptManifestDigest: string };
  config: HarnessProjectConfig;
  prompt: string;
}

export interface DistributedSessionReadyV1 {
  version: 1;
  jobId: string;
  workerId: string;
  leaseId: string;
  preparedAt: string;
  runtime: { runtimeId: string; provider: string; modelId: string; model: string; sessionId: string };
  contextManifestDigest: string;
  promptManifestDigest: string;
  sessionPreparation: "RUNTIME_MATERIALIZED";
}

export interface DistributedExecutionReleaseV1 {
  version: 1;
  jobId: string;
  workerId: string;
  leaseId: string;
  releasedAt: string;
  executionBinding: ExecutionBindingV2;
}

export interface DistributedDelegationResult {
  version: 2;
  jobId: string;
  workerId: string;
  startedAt: string;
  finishedAt: string;
  status: "PASS" | "FAIL";
  session: WorkerSession;
  changedFiles: string[];
  patch: string;
  observedCandidateSourceDigest?: string;
  message?: string;
}

export interface ClaimedJob { job: DistributedDelegationJob; leaseId: string; }
