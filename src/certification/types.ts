import type { UsageMetrics } from "../core/types.js";

export type CertificationState = "ACCEPTED" | "REPAIR_REQUIRED" | "HUMAN_REQUIRED" | "PARTIAL" | "BLOCKED" | "NOT_TESTED";
export type CertificationLifecycleState = "CREATED" | "PREFLIGHT" | "ACTING" | "CANDIDATE_READY" | "ORACLE_RUNNING" | "ASSURANCE_EVALUATING" | "REPAIRING" | "ESCALATING" | "COMPLETED";
export type CertificationCheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
export type CertificationActorRole = "actor" | "reviewer" | "repair";
export type CertificationCapability = "informational" | "audit" | "quick-change" | "repair" | "context-handoff";
export type CertificationLaneStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED" | "INSUFFICIENT";
export type CertificationOverallStatus = "PASS" | "PARTIAL" | "FAIL" | "BLOCKED" | "NOT_TESTED";

/** The revision under test. It is deliberately independent of any agent runtime. */
export interface CandidateRevision {
  version: 1;
  id: string;
  root: string;
  artifactPath?: string;
  baseRef?: string;
  sourceDigest?: string;
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
