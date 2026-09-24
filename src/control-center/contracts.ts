import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { KnowledgeSufficiencyStatusV1 } from "../knowledge/index.js";
import type { ProjectAvailabilityV1, ProjectHealthMetadataV1, ProjectIdentityV1 } from "../projects/index.js";
import type { RuntimeSnapshotV1 } from "../runtime/index.js";
import type { CapabilityLeaseV1 } from "../security/authorityV2.js";
import type { OperationStatus } from "../operations/state.js";
import type { BuildIdentityV1 } from "../build/identity.js";
import type { DecisionRequestV1 } from "../security/humanDecision.js";

export const CONTROL_CENTER_CONTRACT_VERSION = 1 as const;

export type ControlCenterResourceKindV1 =
  | "project"
  | "operation"
  | "participant"
  | "candidate"
  | "context"
  | "authority"
  | "evidence"
  | "services"
  | "knowledge"
  | "event";

export type ControlCenterResourceIdV1<K extends ControlCenterResourceKindV1 = ControlCenterResourceKindV1> = string & {
  readonly __controlCenterResourceKind: K;
  readonly __controlCenterContractVersion: typeof CONTROL_CENTER_CONTRACT_VERSION;
};

export type ControlCenterEventIdV1 = ControlCenterResourceIdV1<"event">;
export type ControlCenterProjectIdV1 = ControlCenterResourceIdV1<"project">;
export type ControlCenterOperationIdV1 = ControlCenterResourceIdV1<"operation">;
export type ControlCenterParticipantIdV1 = ControlCenterResourceIdV1<"participant">;
export type ControlCenterCandidateIdV1 = ControlCenterResourceIdV1<"candidate">;

export function controlCenterResourceId<K extends ControlCenterResourceKindV1>(kind: K, value: string): ControlCenterResourceIdV1<K> {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Control Center ${kind} identifier must not be empty.`);
  return normalized as ControlCenterResourceIdV1<K>;
}

export interface ControlCenterProjectProjectionV1 extends Pick<ProjectIdentityV1, "repositoryIdentity" | "displayName" | "configDigest" | "createdAt" | "updatedAt"> {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  projectId: ControlCenterProjectIdV1;
  availability: ProjectAvailabilityV1;
  health?: Pick<ProjectHealthMetadataV1, "status" | "healthUrl" | "registeredAt" | "lastCheckedAt">;
}

export type ControlCenterOperationKindV1 = "audit" | "run" | "change";
export type ControlCenterOperationStatusV1 = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ControlCenterDecisionRequestV1 extends Omit<DecisionRequestV1, "candidate"> {
  candidate: string;
}

export interface ControlCenterOperationProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  operationId: ControlCenterOperationIdV1;
  kind: ControlCenterOperationKindV1;
  status: ControlCenterOperationStatusV1;
  phase: string;
  revision?: number;
  projectId?: ControlCenterProjectIdV1;
  candidateId?: ControlCenterCandidateIdV1;
  candidateDigest?: string;
  participantCount: number;
  runningParticipantCount: number;
  completedParticipantCount: number;
  failedParticipantCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  decisionRequest?: ControlCenterDecisionRequestV1;
}

export interface ControlCenterParticipantProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  participantId: ControlCenterParticipantIdV1;
  operationId?: ControlCenterOperationIdV1;
  logicalAgent?: string;
  role?: string;
  phase?: string;
  status: "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED";
  specializations: string[];
  skills: string[];
  tools: string[];
  registeredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  resultArtifact?: string;
}

export interface ControlCenterOperationDetailProjectionV1 extends ControlCenterOperationProjectionV1 {
  payloadSummary: string;
  participants: ControlCenterParticipantProjectionV1[];
}

export interface ControlCenterCandidateProjectionV1 extends CandidateRevisionV1 {
  controlCenterId: ControlCenterCandidateIdV1;
}

export interface ControlCenterContextProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  operationId?: ControlCenterOperationIdV1;
  candidateDigest?: string;
  promptTokens?: number;
  completionTokens?: number;
  budgetTokens?: number;
  consumedTokens?: number;
  continuationCount: number;
  manifestDigest?: string;
  authorizedReferenceCount: number;
}

export interface ControlCenterAuthorityProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  operationId?: ControlCenterOperationIdV1;
  candidateDigest?: string;
  participantId?: ControlCenterParticipantIdV1;
  leases: Array<Pick<CapabilityLeaseV1, "version" | "leaseId" | "requestId" | "capability" | "issuedAt" | "expiresAt"> & {
    operationId: ControlCenterOperationIdV1;
    participantId: ControlCenterParticipantIdV1;
    candidateDigest: string;
  }>;
}

export type ControlCenterEvidenceTypeV1 = "run" | "requirement" | "task" | "file" | "check" | "finding" | "agent-session" | "commit" | "pull-request";

export interface ControlCenterEvidenceProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  evidenceId: ControlCenterResourceIdV1<"evidence">;
  type: ControlCenterEvidenceTypeV1;
  label: string;
  status?: "PASS" | "FAIL" | "WARN" | "PENDING";
  candidateDigest?: string;
  operationId?: ControlCenterOperationIdV1;
  source?: string;
}

export type ControlCenterServicesProjectionV1 = RuntimeSnapshotV1;

export interface ControlCenterKnowledgeProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  mode: "OFFLINE" | "DOCS_ONLY" | "TRUSTED_DISCOVERY";
  gate: "SUFFICIENT" | "GAP";
  status: KnowledgeSufficiencyStatusV1;
  cacheKey?: string;
  missingCompetencies: string[];
  sourcePackDigest?: string;
  trustedSourceCount: number;
  librarianRequired: boolean;
}

export interface ControlCenterQualityProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  status: "ready" | "converging" | "blocked" | "failed" | "unknown";
  rounds: number;
  findingCount: number;
  unresolvedFindingCount: number;
  candidateDigest?: string;
}

export interface ControlCenterCertificationProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  status: "not-started" | "in-progress" | "passed" | "failed" | "unknown";
  checks: number;
  passedChecks: number;
  failedChecks: number;
  candidateDigest?: string;
}

export interface ControlCenterSecurityProjectionV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  loopbackOnly: true;
  authenticated: true;
  csrfForMutations: true;
}

export interface ControlCenterEventDataV1 {
  operationId: ControlCenterOperationIdV1;
  revision: number;
  status: OperationStatus;
  phase: string;
  changed?: string[];
  details?: Record<string, unknown>;
}

export type ControlCenterEventTypeV1 =
  | "operation.created"
  | "operation.updated"
  | "operation.metadata"
  | "operation.terminal"
  | "operation.stage"
  | "operation.candidate.bound"
  | "operation.lead.bound"
  | "operation.participant.registered"
  | "operation.participant.updated"
  | "operation.participant.receipt"
  | "operation.supervisor.registered"
  | "operation.supervisor.updated"
  | "operation.controller.claimed"
  | "operation.controller.process-bound"
  | "operation.lead.acknowledged";

export interface ControlCenterEventV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  eventId: ControlCenterEventIdV1;
  type: ControlCenterEventTypeV1;
  at: string;
  data: ControlCenterEventDataV1;
}

export interface ControlCenterPairInputV1 { nonce: string; }
export interface ControlCenterPairedSessionV1 { version: typeof CONTROL_CENTER_CONTRACT_VERSION; csrfToken: string; }

export interface ControlCenterProjectSelectionV1 {
  projectId?: ControlCenterProjectIdV1;
  autoOpen: boolean;
}

export interface ControlCenterProjectHealthProjectionV1 {
  availability: ProjectAvailabilityV1;
  runtime: { status: "healthy" | "unhealthy" | "unreachable" | "unregistered" | "unavailable" };
  checkedAt: string;
  durationMs: number;
}

export interface ControlCenterActionResultV1 {
  accepted?: boolean;
  reason?: string;
  operationId?: string;
  status?: ControlCenterOperationStatusV1;
  phase?: string;
  revision?: number;
  candidateRevision?: number;
  decisionId?: string;
  requestId?: string;
  choiceId?: string;
}

export interface ControlCenterDecisionInputV1 {
  operationId: string;
  requestId: string;
  choiceId: string;
  reason?: string;
}

export interface ControlCenterSnapshotV1 {
  projects: ControlCenterProjectProjectionV1[];
  operations: ControlCenterOperationDetailProjectionV1[];
  participants: ControlCenterParticipantProjectionV1[];
  candidates: ControlCenterCandidateProjectionV1[];
  context: ControlCenterContextProjectionV1;
  authority: ControlCenterAuthorityProjectionV1;
  evidence: ControlCenterEvidenceProjectionV1[];
  services: ControlCenterServicesProjectionV1;
  knowledge: ControlCenterKnowledgeProjectionV1;
  quality: ControlCenterQualityProjectionV1;
  certification: ControlCenterCertificationProjectionV1;
}

export interface ControlCenterSnapshotInputV1 {
  projects?: ControlCenterProjectProjectionV1[];
  operations?: ControlCenterOperationDetailProjectionV1[];
  participants?: ControlCenterParticipantProjectionV1[];
  candidates?: ControlCenterCandidateProjectionV1[];
  context?: Partial<ControlCenterContextProjectionV1>;
  authority?: Partial<ControlCenterAuthorityProjectionV1>;
  evidence?: ControlCenterEvidenceProjectionV1[];
  services?: ControlCenterServicesProjectionV1;
  knowledge?: Partial<ControlCenterKnowledgeProjectionV1>;
  quality?: Partial<ControlCenterQualityProjectionV1> & { activeOperations?: number };
  certification?: Partial<ControlCenterCertificationProjectionV1>;
}

export interface ControlCenterResourceCollectionV1<K extends ControlCenterResourceKindV1, T> {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  resource: K;
  generatedAt: string;
  items: T[];
}

export interface ControlCenterResourceDetailV1<K extends ControlCenterResourceKindV1, T> {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  resource: K;
  generatedAt: string;
  item: T;
}

export interface ControlCenterOverviewV1 extends ControlCenterSnapshotV1 {
  version: typeof CONTROL_CENTER_CONTRACT_VERSION;
  generatedAt: string;
  buildIdentity: BuildIdentityV1;
  agents: ControlCenterParticipantProjectionV1[];
  permissions: ControlCenterAuthorityProjectionV1["leases"];
  security: ControlCenterSecurityProjectionV1;
  pairing: { mode: "single-use-pairing-session"; host: string };
  project?: ControlCenterProjectProjectionV1;
  projectSelection?: ControlCenterProjectSelectionV1;
  projectHealth?: ControlCenterProjectHealthProjectionV1;
}
