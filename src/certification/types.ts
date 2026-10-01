import type { UsageMetrics } from "../core/types.js";
import type { BuildIdentityV1 } from "../build/identity.js";

export type CertificationState = "ACCEPTED" | "REPAIR_REQUIRED" | "HUMAN_REQUIRED" | "PARTIAL" | "BLOCKED" | "NOT_TESTED";
export type CertificationLifecycleState = "CREATED" | "PREFLIGHT" | "ACTING" | "CANDIDATE_READY" | "ORACLE_RUNNING" | "ASSURANCE_EVALUATING" | "REPAIRING" | "ESCALATING" | "COMPLETED";
export type CertificationCheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
export type CertificationActorRole = "actor" | "reviewer" | "repair";
export type CertificationCapability = "startup" | "informational" | "audit" | "change" | "direct-change" | "delegated-change" | "formal-sdd" | "multi-worker" | "cancel" | "recovery" | "product-repair" | "certification-repair" | "repair" | "context-handoff" | "permission-delegation" | "issue-driven" | "delivery" | "distributed-execution" | "project-home" | "multi-project" | "control-center" | "authority";
export interface CertificationCapabilityRequirement {
  capability: CertificationCapability;
  deterministicContract: string;
  modelJourney: string;
  requiredEvidence: string[];
}

export const CERTIFICATION_CAPABILITY_MATRIX: readonly CertificationCapabilityRequirement[] = [
  { capability: "startup", deterministicContract: "install/init/setup/doctor and runtime identity", modelJourney: "start a fresh packed consumer", requiredEvidence: ["install", "doctor", "startup"] },
  { capability: "informational", deterministicContract: "bounded read-only answer with no operation artifact", modelJourney: "resolve an informational turn", requiredEvidence: ["intent", "answer"] },
  { capability: "audit", deterministicContract: "read-only audit report and validator evidence", modelJourney: "start and complete an audit journey", requiredEvidence: ["audit-report", "findings"] },
  { capability: "change", deterministicContract: "candidate-bound change contract and terminal receipt", modelJourney: "route, execute, validate and deliver a change", requiredEvidence: ["candidate-revision", "participant-receipt", "validation"] },
  { capability: "direct-change", deterministicContract: "one bounded implementer and assurance-specific validation", modelJourney: "complete a small direct change", requiredEvidence: ["direct-route", "candidate-revision", "validation"] },
  { capability: "delegated-change", deterministicContract: "FeatureCapsule and bounded planner/worker coordination", modelJourney: "complete a multi-file delegated change", requiredEvidence: ["feature-capsule", "delegation", "review"] },
  { capability: "formal-sdd", deterministicContract: "OpenSpec/SDD consistency and sealed TaskContract", modelJourney: "complete a formal SDD feature", requiredEvidence: ["openspec", "task-contract", "traceability"] },
  { capability: "multi-worker", deterministicContract: "dependency-aware waves and barrier validation", modelJourney: "coordinate multiple implementers", requiredEvidence: ["task-dag", "wave-barrier"] },
  { capability: "cancel", deterministicContract: "idempotent cancellation and drained descendants", modelJourney: "cancel a running operation", requiredEvidence: ["cancel-request", "terminal-state"] },
  { capability: "recovery", deterministicContract: "restart/recovery preserves operation identity and evidence", modelJourney: "recover after a controlled interruption", requiredEvidence: ["recovery-event", "operation-state"] },
  { capability: "product-repair", deterministicContract: "bounded product repair cannot widen frozen scope", modelJourney: "repair a failing product candidate", requiredEvidence: ["repair-packet", "scope-check"] },
  { capability: "certification-repair", deterministicContract: "external certification repair is re-oracled and cannot self-accept", modelJourney: "repair a disposable certification fixture", requiredEvidence: ["failure-packet", "oracle-recheck"] },
  { capability: "repair", deterministicContract: "bounded repair attempts cannot self-accept", modelJourney: "repair a failing candidate and re-run the oracle", requiredEvidence: ["failure-packet", "oracle-recheck"] },
  { capability: "context-handoff", deterministicContract: "authorized context refs and continuation binding", modelJourney: "continue work across sessions", requiredEvidence: ["context-ref", "continuation"] },
  { capability: "permission-delegation", deterministicContract: "monotonic child capability leases", modelJourney: "request and deny an authority escalation", requiredEvidence: ["parent-lease", "decision"] },
  { capability: "issue-driven", deterministicContract: "frozen issue snapshot and drift gate", modelJourney: "import and execute an issue-derived task", requiredEvidence: ["issue-snapshot", "drift-check"] },
  { capability: "delivery", deterministicContract: "accepted candidate delivery identity and provenance", modelJourney: "deliver an accepted candidate", requiredEvidence: ["delivery-record", "provenance"] },
  { capability: "distributed-execution", deterministicContract: "leased queue execution and worker evidence", modelJourney: "run a distributed worker journey", requiredEvidence: ["lease", "worker-receipt"] },
  { capability: "project-home", deterministicContract: "registry identity and moved-project health state", modelJourney: "select a project from AEH Home", requiredEvidence: ["project-id", "health"] },
  { capability: "multi-project", deterministicContract: "same-name projects remain isolated by repository identity", modelJourney: "select between two registered projects", requiredEvidence: ["repository-identity", "project-selection"] },
  { capability: "control-center", deterministicContract: "loopback token/CSRF protected control surface", modelJourney: "observe and request a human decision", requiredEvidence: ["overview", "decision"] },
  { capability: "authority", deterministicContract: "monotonic capabilities and external human decisions", modelJourney: "approve or reject a gated action", requiredEvidence: ["lease", "human-decision"] }
];
export type CertificationLaneStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED" | "INSUFFICIENT";
export type CertificationOverallStatus = "PASS" | "PARTIAL" | "FAIL" | "BLOCKED" | "NOT_TESTED";

/** The revision under test. It is deliberately independent of any agent runtime. */
export interface CandidateRevision {
  version: 1;
  id: string;
  candidateRevisionId?: string;
  projectId?: string;
  operationId?: string;
  taskId?: string;
  revision?: number;
  root: string;
  workspace?: string;
  worktree?: string;
  parentCandidateId?: string;
  artifactPath?: string;
  baseRef?: string;
  sourceDigest?: string;
  treeDigest?: string;
  packedArtifactDigest?: string;
  createdAt?: string;
  metadata?: Record<string, string>;
}

export interface CertificationBudget {
  maxAttempts: number;
  maxDurationMs: number;
  maxCostUsd?: number;
  maxTotalTokens?: number;
  maxOutputBytes?: number;
  requireUsageForTokenBudget?: boolean;
}

export interface CertificationRepairPolicy {
  enabled: boolean;
  maxAttempts: number;
  humanOnExhaustion: boolean;
}

export interface CertificationReviewPolicy {
  enabled: boolean;
  required: boolean;
  humanOnFailure: boolean;
}

export interface CertificationAssurancePolicy {
  requireDeterministicOracle: boolean;
  requireIndependentOracle: boolean;
  allowRequiredSkippedChecks: boolean;
}

export interface CertificationSecurityPolicy {
  allowRecursiveCertification: boolean;
  allowNetwork: boolean;
  environmentAllowlist: string[];
  credentialEnvAllowlist: string[];
  maxOutputBytes: number;
  requireNetworkIsolation?: boolean;
}

export interface CertificationPolicy {
  version: 1;
  id: string;
  assurance: CertificationAssurancePolicy;
  budget: CertificationBudget;
  repair: CertificationRepairPolicy;
  review: CertificationReviewPolicy;
  security: CertificationSecurityPolicy;
}

export interface CertificationCheck {
  id: string;
  category?: string;
  status: CertificationCheckStatus;
  required: boolean;
  message: string;
  durationMs?: number;
  evidence?: Record<string, unknown>;
}

export interface CertificationFailure {
  id: string;
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CertificationOracleResult {
  version: 1;
  oracleId: string;
  deterministic: true;
  status: "PASS" | "FAIL";
  checks: CertificationCheck[];
  failures: CertificationFailure[];
  evidence: Record<string, unknown>;
  generatedAt: string;
}

export interface CertificationOracleContext {
  candidate: CandidateRevision;
  policy: CertificationPolicy;
  attempt: number;
  signal?: AbortSignal;
  actor?: AgentProviderResult;
}

export interface CertificationOracle {
  readonly id: string;
  readonly independent?: boolean;
  prepare?(context: CertificationOracleContext): Promise<void>;
  dispose?(): Promise<void>;
  evaluate(context: CertificationOracleContext): Promise<CertificationOracleResult>;
}

export interface AgentProviderRequest {
  version: 1;
  requestId: string;
  role: CertificationActorRole;
  prompt: string;
  cwd: string;
  command: string;
  args: string[];
  environment?: Record<string, string>;
  environmentAllowlist?: string[];
  credentialEnvAllowlist?: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
}

export interface ProviderEvent {
  at: string;
  type: "stdout" | "stderr" | "json" | "started" | "finished" | "timeout" | "error";
  data?: unknown;
}

export interface AgentProviderResult {
  version: 1;
  provider: string;
  requestId: string;
  role: CertificationActorRole;
  status: "COMPLETED" | "FAILED" | "TIMED_OUT" | "OUTPUT_LIMIT";
  exitCode: number;
  signal?: string;
  stdout: string;
  stderr: string;
  events: ProviderEvent[];
  structuredOutput?: unknown;
  usage: UsageMetrics;
  usageKnown: boolean;
  durationMs: number;
  outputTruncated: boolean;
  executionEvidence?: ProviderExecutionEvidence;
}

export interface ProviderExecutionEvidence {
  started: boolean;
  provider: string;
  command: string;
  requestedModel?: string;
  effectiveModel?: string;
  requestedReasoningEffort?: string;
  effectiveReasoningEffort?: string;
  capabilitySource?: string;
  sessionId?: string;
  processExitCode?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface CertificationRepairRequest {
  create(attempt: number, failure: CertificationFailure[], candidate: CandidateRevision): AgentProviderRequest;
}

export interface CertificationReviewRequest {
  create(candidate: CandidateRevision, oracle: CertificationOracleResult): AgentProviderRequest;
}

export interface CertificationRequest {
  candidate: CandidateRevision;
  policy: CertificationPolicy;
  actor?: AgentProviderRequest;
  repair?: CertificationRepairRequest;
  reviewer?: CertificationReviewRequest;
  capability?: CertificationCapability;
  requireModelE2E?: boolean;
  requireModelEvidence?: boolean;
}

export interface CertificationAttempt {
  attempt: number;
  role: CertificationActorRole | "oracle";
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  usage?: UsageMetrics;
  message?: string;
}

export interface CertificationFailurePacket {
  version: 1;
  certificationId: string;
  candidateId: string;
  createdAt: string;
  reason: "ORACLE_FAILURE" | "PROVIDER_FAILURE" | "BUDGET_EXHAUSTED" | "REVIEW_FAILURE" | "SAFETY_FAILURE";
  failures: CertificationFailure[];
  repairAttempt: number;
  deterministic: true;
}

export interface CertificationReport {
  version: 1;
  buildIdentity: BuildIdentityV1;
  certificationId: string;
  candidate: CandidateRevision;
  policyId: string;
  state: CertificationState;
  lifecycle: CertificationLifecycleState;
  accepted: false | true;
  assurance: "DETERMINISTIC" | "DETERMINISTIC_WITH_EXTERNAL_REVIEW" | "INSUFFICIENT";
  oracle: CertificationOracleResult;
  reviewer?: AgentProviderResult;
  providerResults: AgentProviderResult[];
  attempts: CertificationAttempt[];
  failurePacket?: CertificationFailurePacket;
  budget: CertificationBudgetSnapshot;
  startedAt: string;
  finishedAt: string;
  capability?: CertificationCapabilityResult;
  networkPolicy: CertificationNetworkPolicy;
  persistedReport?: string;
}

export interface CertificationCapabilityResult {
  capability: CertificationCapability;
  contract: CertificationLaneResult;
  modelE2E: CertificationLaneResult;
  overall: CertificationOverallStatus;
  requiredModelE2E: boolean;
}

export interface CertificationLaneResult {
  status: CertificationLaneStatus;
  evidence: Record<string, unknown>;
}

export interface CertificationNetworkPolicy {
  requested: "ALLOW" | "DENY";
  enforced: boolean;
  enforcement: "provider-allowed" | "unavailable" | "not-required";
}

export interface CertificationBudgetSnapshot {
  attempts: number;
  durationMs: number;
  usage: UsageMetrics;
  remaining: {
    attempts: number;
    durationMs: number;
    costUsd?: number;
    totalTokens?: number;
  };
  usageKnown: boolean;
}
