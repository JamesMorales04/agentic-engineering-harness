import { canonicalSerialize, sha256Utf8 } from "../core/digest.js";

export const V2_CONTRACT_VERSION = 1 as const;

export type CandidateRevisionV1 = {
  version: typeof V2_CONTRACT_VERSION;
  operationId: string;
  candidateId: string;
  projectId?: string;
  taskId?: string;
  revision: number;
  workspace?: string;
  worktree?: string;
  parentCandidateId?: string;
  sourceDigest: string;
  createdAt?: string;
  canonicalIdentity: string;
  identityDigest: string;
};

export type CandidateRevisionInputV1 = Pick<CandidateRevisionV1, "operationId" | "candidateId" | "revision" | "sourceDigest"> & Partial<Pick<CandidateRevisionV1, "projectId" | "taskId" | "workspace" | "worktree" | "parentCandidateId" | "createdAt">>;

export type RuntimeTerminalEvidenceV1 = {
  kind: "runtime-terminal";
  eventId: string;
  observedAt: string;
  terminal: true;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  exitCode: number | null;
};

export type ContractEvidenceV1 = {
  contractId: string;
  contractDigest: string;
  valid: true;
};

export type PersistedArtifactV1 = {
  artifactId: string;
  artifactDigest: string;
  persisted: true;
  persistedAt: string;
};

export type ProvenanceEvidenceV1 = {
  provenanceId: string;
  provenanceDigest: string;
  source: string;
  valid: true;
};

export type ParticipantReceiptV1 = {
  version: typeof V2_CONTRACT_VERSION;
  receiptId: string;
  operationId: string;
  participantId: string;
  sessionId?: string;
  attempt?: number;
  parentParticipantId?: string;
  supervisorGeneration?: number;
  role?: string;
  phase?: string;
  startedAt?: string;
  finishedAt?: string;
  outputContract?: string;
  outputDigest?: string;
  artifactRef?: string;
  candidate?: CandidateRevisionV1;
  candidateBinding?: CandidateRevisionV1;
  outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
  runtimeTerminal?: RuntimeTerminalEvidenceV1;
  runtimeTerminalEvidence?: RuntimeTerminalEvidenceV1;
  contract?: ContractEvidenceV1;
  artifact?: PersistedArtifactV1;
  persistedArtifact?: PersistedArtifactV1;
  provenance?: ProvenanceEvidenceV1;
  settled?: true;
  createdAt: string;
};

export type TerminalGateFailureCodeV1 =
  | "INVALID_RECEIPT"
  | "OPERATION_MISMATCH"
  | "CANDIDATE_MISMATCH"
  | "RUNTIME_TERMINAL_EVIDENCE_REQUIRED"
  | "CONTRACT_INVALID"
  | "PERSISTED_ARTIFACT_REQUIRED"
  | "PROVENANCE_INVALID";

export type TerminalGateDecisionV1 = {
  allowed: boolean;
  reasons: ReadonlyArray<{ code: TerminalGateFailureCodeV1; message: string }>;
};

export type TerminalGateContextV1 = {
  operationId?: string;
  candidate: CandidateRevisionV1;
  now?: string | Date;
};

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return sha256Utf8(value);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`V2_CONTRACT_INVALID: ${field} must be a non-empty string.`);
}

function validDigest(value: unknown, field: string): asserts value is string {
  requiredString(value, field);
  if (!DIGEST_PATTERN.test(value)) throw new Error(`V2_CONTRACT_INVALID: ${field} must be a lowercase SHA-256 digest.`);
}

function isoTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("V2_CONTRACT_INVALID: timestamp is not a valid instant.");
  return date.toISOString();
}

function candidateIdentity(input: CandidateRevisionInputV1): Record<string, unknown> {
  return {
    version: V2_CONTRACT_VERSION,
    operationId: input.operationId,
    candidateId: input.candidateId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    revision: input.revision,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.parentCandidateId ? { parentCandidateId: input.parentCandidateId } : {}),
    sourceDigest: input.sourceDigest,
    ...(input.createdAt ? { createdAt: isoTime(input.createdAt) } : {}),
  };
}

export function canonicalCandidateIdentity(input: CandidateRevisionInputV1): string {
  assertCandidateRevisionInputV1(input);
  return canonicalSerialize(candidateIdentity(input));
}

export function candidateIdentityDigest(input: CandidateRevisionInputV1): string {
  return sha256(canonicalCandidateIdentity(input));
}

export const canonicalCandidateDigest = candidateIdentityDigest;

export function createCandidateRevisionV1(input: CandidateRevisionInputV1): CandidateRevisionV1 {
  assertCandidateRevisionInputV1(input);
  const canonical = canonicalSerialize(candidateIdentity(input));
  return {
    ...input,
    version: V2_CONTRACT_VERSION,
    canonicalIdentity: canonical,
    identityDigest: sha256(canonical),
  };
}

export function assertCandidateRevisionInputV1(value: unknown): asserts value is CandidateRevisionInputV1 {
  if (!value || typeof value !== "object") throw new Error("V2_CONTRACT_INVALID: candidate input must be an object.");
  const input = value as Record<string, unknown>;
  requiredString(input.operationId, "candidate.operationId");
  requiredString(input.candidateId, "candidate.candidateId");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("V2_CONTRACT_INVALID: candidate.revision must be a non-negative integer.");
  validDigest(input.sourceDigest, "candidate.sourceDigest");
}

export function assertCandidateRevisionV1(value: unknown): asserts value is CandidateRevisionV1 {
  assertCandidateRevisionInputV1(value);
  const candidate = value as CandidateRevisionV1;
  if (candidate.version !== V2_CONTRACT_VERSION) throw new Error("V2_CONTRACT_INVALID: unsupported candidate version.");
  const supportedFields = new Set(["version", "operationId", "candidateId", "projectId", "taskId", "revision", "workspace", "worktree", "parentCandidateId", "sourceDigest", "createdAt", "canonicalIdentity", "identityDigest"]);
  const unsupportedFields = Object.keys(candidate).filter((field) => !supportedFields.has(field));
  if (unsupportedFields.length) throw new Error(`V2_CONTRACT_INVALID: unsupported CandidateRevision fields: ${unsupportedFields.sort().join(", ")}.`);
  const canonical = canonicalCandidateIdentity(candidate);
  if (candidate.canonicalIdentity !== canonical || candidate.identityDigest !== sha256(canonical)) throw new Error("V2_CONTRACT_INVALID: candidate canonical identity or digest is inconsistent.");
}

export function candidateRevisionsEqual(left: CandidateRevisionV1, right: CandidateRevisionV1): boolean {
  try {
    assertCandidateRevisionV1(left);
    assertCandidateRevisionV1(right);
  } catch {
    return false;
  }
  return left.identityDigest === right.identityDigest && left.canonicalIdentity === right.canonicalIdentity;
}

export function isStaleCandidateBinding(bound: CandidateRevisionV1, current: CandidateRevisionV1): boolean {
  return !candidateRevisionsEqual(bound, current);
}

export const isCandidateRevisionStale = isStaleCandidateBinding;

export function assertCurrentCandidateBinding(bound: CandidateRevisionV1, current: CandidateRevisionV1): void {
  assertCandidateRevisionV1(bound);
  assertCandidateRevisionV1(current);
  if (bound.operationId !== current.operationId) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate belongs to a different operation.");
  if (isStaleCandidateBinding(bound, current)) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate binding is stale.");
}

function terminalContext(value: CandidateRevisionV1 | TerminalGateContextV1): TerminalGateContextV1 {
  return "candidate" in value ? value : { candidate: value };
}

function isValidTimestamp(value: string, now: string): boolean {
  const timestamp = new Date(value).getTime();
  return !Number.isNaN(timestamp) && timestamp <= new Date(now).getTime();
}

export function evaluateTerminalGate(receipt: unknown, expected: CandidateRevisionV1 | TerminalGateContextV1): TerminalGateDecisionV1 {
  const failures: Array<{ code: TerminalGateFailureCodeV1; message: string }> = [];
  if (!receipt || typeof receipt !== "object") return { allowed: false, reasons: [{ code: "INVALID_RECEIPT", message: "participant receipt must be an object." }] };
  const value = receipt as ParticipantReceiptV1;
  let context: TerminalGateContextV1;
  try {
    context = terminalContext(expected);
    assertCandidateRevisionV1(context.candidate);
  } catch {
    return { allowed: false, reasons: [{ code: "CANDIDATE_MISMATCH", message: "terminal gate context has no valid current candidate." }] };
  }
  if (value.version !== V2_CONTRACT_VERSION || !value.receiptId || !value.participantId || !value.operationId) failures.push({ code: "INVALID_RECEIPT", message: "receipt identity is incomplete or uses an unsupported version." });
  if (context.operationId && value.operationId !== context.operationId) failures.push({ code: "OPERATION_MISMATCH", message: "receipt belongs to a different operation." });
  const boundCandidate = value.candidateBinding ?? value.candidate;
  if (!boundCandidate || !candidateRevisionsEqual(boundCandidate, context.candidate) || value.operationId !== context.candidate.operationId) failures.push({ code: "CANDIDATE_MISMATCH", message: "receipt is not bound to the current candidate revision." });

  const terminal = value.runtimeTerminalEvidence ?? value.runtimeTerminal;
  const now = isoTime(context.now ?? new Date());
  if (!terminal || terminal.kind !== "runtime-terminal" || terminal.terminal !== true || !terminal.eventId || !isValidTimestamp(terminal.observedAt, now) || terminal.status !== value.outcome) failures.push({ code: "RUNTIME_TERMINAL_EVIDENCE_REQUIRED", message: "completion requires matching, observed runtime terminal evidence." });
  if (!value.contract || value.contract.valid !== true || !value.contract.contractId || !DIGEST_PATTERN.test(value.contract.contractDigest)) failures.push({ code: "CONTRACT_INVALID", message: "a valid persisted contract evidence record is required." });
  const artifact = value.persistedArtifact ?? value.artifact;
  if (!artifact || artifact.persisted !== true || !artifact.artifactId || !DIGEST_PATTERN.test(artifact.artifactDigest) || !isValidTimestamp(artifact.persistedAt, now)) failures.push({ code: "PERSISTED_ARTIFACT_REQUIRED", message: "a persisted artifact with a valid digest is required before completion." });
  if (!value.provenance || value.provenance.valid !== true || !value.provenance.provenanceId || !value.provenance.source || !DIGEST_PATTERN.test(value.provenance.provenanceDigest)) failures.push({ code: "PROVENANCE_INVALID", message: "valid provenance evidence is required before completion." });
  return { allowed: failures.length === 0, reasons: failures };
}

export const evaluateTerminalGateV1 = evaluateTerminalGate;

export function assertParticipantReceiptV1(value: unknown): asserts value is ParticipantReceiptV1 {
  const decision = evaluateTerminalGate(value, {
    candidate: (value as ParticipantReceiptV1 | undefined)?.candidateBinding ?? (value as ParticipantReceiptV1 | undefined)?.candidate as CandidateRevisionV1,
    operationId: (value as ParticipantReceiptV1 | undefined)?.operationId,
  });
  if (!decision.allowed) throw new Error(`V2_RECEIPT_REJECTED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
}
