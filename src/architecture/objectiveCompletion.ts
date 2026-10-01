import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { assertCandidateRevisionV1, candidateRevisionsEqual } from "../operations/v2Contracts.js";

export const OBJECTIVE_COMPLETION_VERSION = 1 as const;

export type ObjectiveEvidenceStatusV1 = "PASS" | "FAIL";
export type ObjectiveParticipantStatusV1 =
  | "REGISTERED"
  | "IDLE"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export interface ObjectiveCompletionIdentityV1 {
  operationId: string;
  candidate: CandidateRevisionV1;
  policyDigest: string;
  operationExecutionRevision: number;
  controllerEpoch: number;
}

export interface ObjectiveAssertionEvidenceV1 {
  assertionId: string;
  status: ObjectiveEvidenceStatusV1;
  identity: ObjectiveCompletionIdentityV1;
}

export interface ObjectiveCompletionInputV1 {
  version: 1;
  identity: ObjectiveCompletionIdentityV1;
  workspaceCandidate: CandidateRevisionV1;
  workGraph: { requiredWorkUnitIds: string[]; accountedWorkUnitIds: string[] };
  validation: { requiredAssertionIds: string[]; evidence: ObjectiveAssertionEvidenceV1[] };
  review: { requiredAssertionIds: string[]; evidence: ObjectiveAssertionEvidenceV1[] };
  acceptance: {
    disposition: "ACCEPTED" | "REJECTED";
    requiredAssertionIds: string[];
    coveredAssertionIds: string[];
    identity: ObjectiveCompletionIdentityV1;
  };
  certification: {
    required: boolean;
    disposition?: "PASS" | "FAIL";
    identity?: ObjectiveCompletionIdentityV1;
  };
  delivery: {
    required: boolean;
    disposition: "RECONCILED" | "NOT_REQUIRED" | "PENDING";
    identity?: ObjectiveCompletionIdentityV1;
  };
  findings: Array<{ candidate: CandidateRevisionV1; blocking: boolean }>;
  participants: Array<{ id: string; required: boolean; status: ObjectiveParticipantStatusV1 }>;
  terminalIdentity: ObjectiveCompletionIdentityV1;
}

export interface ObjectiveCompletionDecisionV1 {
  version: 1;
  complete: boolean;
  blockers: Array<{ code: string; message: string }>;
}

type ObjectiveCompletionBlockerV1 = { code: string; message: string };
type AssertionEvidenceGateKindV1 = "VALIDATION" | "REVIEW";

const participantStatuses: ReadonlySet<string> = new Set(["REGISTERED", "IDLE", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"]);
const inFlightParticipantStatuses: ReadonlySet<string> = new Set(["REGISTERED", "IDLE", "RUNNING"]);

function blocker(code: string, message: string): ObjectiveCompletionBlockerV1 {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identityMismatchFields(current: ObjectiveCompletionIdentityV1, other: unknown): string[] {
  if (!isRecord(other)) return ["identity"];
  const fields: string[] = [];
  if (other.operationId !== current.operationId) fields.push("operationId");
  if (!candidateRevisionsEqual(current.candidate, other.candidate as CandidateRevisionV1)) fields.push("candidate");
  if (other.policyDigest !== current.policyDigest) fields.push("policyDigest");
  if (other.operationExecutionRevision !== current.operationExecutionRevision) fields.push("operationExecutionRevision");
  if (other.controllerEpoch !== current.controllerEpoch) fields.push("controllerEpoch");
  return fields;
}

function decide(blockers: readonly ObjectiveCompletionBlockerV1[]): ObjectiveCompletionDecisionV1 {
  const unique = new Map<string, ObjectiveCompletionBlockerV1>();
  for (const entry of blockers) unique.set(`${entry.code}\u0000${entry.message}`, entry);
  const ordered = [...unique.values()].sort((left, right) =>
    left.code < right.code ? -1 : left.code > right.code ? 1 : left.message < right.message ? -1 : left.message > right.message ? 1 : 0
  );
  return { version: OBJECTIVE_COMPLETION_VERSION, complete: ordered.length === 0, blockers: ordered };
}

function validateObjectiveIdentity(value: unknown, blockers: ObjectiveCompletionBlockerV1[]): ObjectiveCompletionIdentityV1 {
  if (!isRecord(value)) {
    blockers.push(blocker("OBJECTIVE_IDENTITY_INVALID", "current objective identity must be an object."));
    return { operationId: "", policyDigest: "", operationExecutionRevision: 0, controllerEpoch: 0, candidate: undefined as unknown as CandidateRevisionV1 };
  }
  if (typeof value.operationId !== "string" || value.operationId.trim().length === 0) blockers.push(blocker("OPERATION_ID_INVALID", "objective operationId must be a non-empty string."));
  if (typeof value.policyDigest !== "string" || value.policyDigest.trim().length === 0) blockers.push(blocker("POLICY_DIGEST_INVALID", "objective policyDigest must be a non-empty string."));
  if (!isPositiveInteger(value.operationExecutionRevision)) blockers.push(blocker("EXECUTION_REVISION_INVALID", "objective operationExecutionRevision must be a positive integer."));
  if (!isNonNegativeSafeInteger(value.controllerEpoch)) blockers.push(blocker("CONTROLLER_EPOCH_INVALID", "objective controllerEpoch must be a non-negative safe integer."));
  try {
    assertCandidateRevisionV1(value.candidate);
  } catch {
    blockers.push(blocker("CANDIDATE_INVALID", "current objective candidate identity is not a valid CandidateRevisionV1."));
  }
  if (typeof value.operationId === "string" && isRecord(value.candidate) && typeof value.candidate.operationId === "string" && value.candidate.operationId !== value.operationId) {
    blockers.push(blocker("CANDIDATE_OPERATION_MISMATCH", "current objective candidate belongs to a different operation than the current objective identity."));
  }
  return value as unknown as ObjectiveCompletionIdentityV1;
}

function validateWorkspaceCandidate(value: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  let valid = true;
  try {
    assertCandidateRevisionV1(value);
  } catch {
    valid = false;
  }
  if (!valid) blockers.push(blocker("WORKSPACE_CANDIDATE_INVALID", "workspace candidate is not a valid CandidateRevisionV1."));
  if (!candidateRevisionsEqual(current.candidate, value as CandidateRevisionV1)) blockers.push(blocker("WORKSPACE_CANDIDATE_MISMATCH", "workspace candidate is not the current objective candidate revision."));
}

function evaluateWorkGraph(workGraph: unknown, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!isRecord(workGraph) || !Array.isArray(workGraph.requiredWorkUnitIds) || !Array.isArray(workGraph.accountedWorkUnitIds)) {
    blockers.push(blocker("WORK_GRAPH_INVALID", "workGraph must declare requiredWorkUnitIds and accountedWorkUnitIds arrays."));
    return;
  }
  const required = new Set<string>();
  for (const id of workGraph.requiredWorkUnitIds) {
    if (typeof id !== "string" || id.trim().length === 0) {
      blockers.push(blocker("WORK_UNIT_ID_INVALID", "work unit ids must be non-empty strings."));
      continue;
    }
    if (required.has(id)) blockers.push(blocker("WORK_UNIT_REQUIRED_DUPLICATE", `required work unit '${id}' is declared more than once.`));
    required.add(id);
  }
  const accounted = new Set<string>();
  for (const id of workGraph.accountedWorkUnitIds) {
    if (typeof id !== "string" || id.trim().length === 0) {
      blockers.push(blocker("WORK_UNIT_ID_INVALID", "work unit ids must be non-empty strings."));
      continue;
    }
    if (accounted.has(id)) blockers.push(blocker("WORK_UNIT_ACCOUNTED_DUPLICATE", `accounted work unit '${id}' is declared more than once.`));
    accounted.add(id);
  }
  for (const id of [...required].sort()) {
    if (!accounted.has(id)) blockers.push(blocker("WORK_UNIT_UNACCOUNTED", `required work unit '${id}' has no accounted work result.`));
  }
}

function evaluateAssertionEvidenceGate(kind: AssertionEvidenceGateKindV1, gate: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!isRecord(gate) || !Array.isArray(gate.requiredAssertionIds) || !Array.isArray(gate.evidence)) {
    blockers.push(blocker(`${kind}_GATE_INVALID`, `${kind.toLowerCase()} gate must declare requiredAssertionIds and evidence arrays.`));
    return;
  }
  const requiredIds = new Set<string>();
  for (const assertionId of gate.requiredAssertionIds) {
    if (typeof assertionId !== "string" || assertionId.trim().length === 0) {
      blockers.push(blocker(`${kind}_REQUIRED_ASSERTION_INVALID`, `${kind.toLowerCase()} required assertion ids must be non-empty strings.`));
      continue;
    }
    requiredIds.add(assertionId);
  }
  for (const assertionId of [...requiredIds].sort()) {
    const matches = gate.evidence.filter((item) => isRecord(item) && item.assertionId === assertionId);
    if (matches.length === 0) {
      blockers.push(blocker(`${kind}_EVIDENCE_MISSING`, `required ${kind.toLowerCase()} assertion '${assertionId}' has no evidence.`));
      continue;
    }
    if (matches.length > 1) {
      blockers.push(blocker(`${kind}_EVIDENCE_DUPLICATE`, `required ${kind.toLowerCase()} assertion '${assertionId}' has ${matches.length} evidence items; exactly one PASS item is required.`));
      continue;
    }
    const item = matches[0]!;
    if (item.status !== "PASS") {
      blockers.push(blocker(`${kind}_EVIDENCE_FAILED`, `required ${kind.toLowerCase()} assertion '${assertionId}' evidence status is '${String(item.status)}'; PASS is required.`));
      continue;
    }
    const mismatch = identityMismatchFields(current, item.identity);
    if (mismatch.length > 0) {
      blockers.push(blocker(`${kind}_EVIDENCE_STALE`, `required ${kind.toLowerCase()} assertion '${assertionId}' evidence is not bound to the current objective identity (${mismatch.join(", ")}).`));
    }
  }
}

function evaluateAcceptance(acceptance: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!isRecord(acceptance)) {
    blockers.push(blocker("ACCEPTANCE_INVALID", "acceptance record must be an object."));
    return;
  }
  if (acceptance.disposition !== "ACCEPTED") {
    blockers.push(blocker("ACCEPTANCE_NOT_ACCEPTED", `objective acceptance disposition must be ACCEPTED but was '${String(acceptance.disposition)}'.`));
  }
  const identityMismatch = identityMismatchFields(current, acceptance.identity);
  if (identityMismatch.length > 0) {
    blockers.push(blocker("ACCEPTANCE_IDENTITY_MISMATCH", `acceptance is not bound to the current objective identity (${identityMismatch.join(", ")}).`));
  }
  if (!Array.isArray(acceptance.requiredAssertionIds)) blockers.push(blocker("ACCEPTANCE_REQUIRED_INVALID", "acceptance requiredAssertionIds must be an array."));
  if (!Array.isArray(acceptance.coveredAssertionIds)) blockers.push(blocker("ACCEPTANCE_COVERED_INVALID", "acceptance coveredAssertionIds must be an array."));
  const required = new Set<string>();
  const seenRequired = new Set<string>();
  for (const assertionId of Array.isArray(acceptance.requiredAssertionIds) ? acceptance.requiredAssertionIds : []) {
    if (typeof assertionId !== "string" || assertionId.trim().length === 0) {
      blockers.push(blocker("ACCEPTANCE_REQUIRED_ASSERTION_INVALID", "acceptance required assertion ids must be non-empty strings."));
      continue;
    }
    if (seenRequired.has(assertionId)) blockers.push(blocker("ACCEPTANCE_REQUIRED_DUPLICATE", `acceptance required assertion '${assertionId}' is declared more than once.`));
    seenRequired.add(assertionId);
    required.add(assertionId);
  }
  const covered = new Set<string>();
  const seenCovered = new Set<string>();
  for (const assertionId of Array.isArray(acceptance.coveredAssertionIds) ? acceptance.coveredAssertionIds : []) {
    if (typeof assertionId !== "string" || assertionId.trim().length === 0) {
      blockers.push(blocker("ACCEPTANCE_COVERED_ASSERTION_INVALID", "acceptance covered assertion ids must be non-empty strings."));
      continue;
    }
    if (seenCovered.has(assertionId)) blockers.push(blocker("ACCEPTANCE_COVERED_DUPLICATE", `acceptance covered assertion '${assertionId}' is declared more than once.`));
    seenCovered.add(assertionId);
    covered.add(assertionId);
  }
  for (const assertionId of [...required].sort()) {
    if (!covered.has(assertionId)) blockers.push(blocker("ACCEPTANCE_COVERAGE_MISSING", `acceptance disposition does not cover required assertion '${assertionId}'.`));
  }
  for (const assertionId of [...covered].sort()) {
    if (!required.has(assertionId)) blockers.push(blocker("ACCEPTANCE_COVERAGE_ADDITIONAL", `acceptance disposition covers assertion '${assertionId}' which is not required.`));
  }
}

function evaluateCertification(certification: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!isRecord(certification) || typeof certification.required !== "boolean") {
    blockers.push(blocker("CERTIFICATION_INVALID", "certification must declare a boolean required flag."));
    return;
  }
  if (certification.required) {
    if (certification.disposition !== "PASS") {
      blockers.push(blocker("CERTIFICATION_REQUIRED_NOT_PASS", `required certification disposition must be PASS but was '${String(certification.disposition)}'.`));
    }
    const identityMismatch = identityMismatchFields(current, certification.identity);
    if (identityMismatch.length > 0) {
      blockers.push(blocker("CERTIFICATION_IDENTITY_MISMATCH", `certification is not bound to the current objective identity (${identityMismatch.join(", ")}).`));
    }
    return;
  }
  if (certification.disposition !== undefined) {
    blockers.push(blocker("CERTIFICATION_UNEXPECTED_DISPOSITION", `certification is not required but declares disposition '${String(certification.disposition)}'.`));
  }
  if (certification.identity !== undefined) {
    blockers.push(blocker("CERTIFICATION_UNEXPECTED_IDENTITY", "certification is not required but declares an identity."));
    const identityMismatch = identityMismatchFields(current, certification.identity);
    if (identityMismatch.length > 0) {
      blockers.push(blocker("CERTIFICATION_IDENTITY_MISMATCH", `certification is not bound to the current objective identity (${identityMismatch.join(", ")}).`));
    }
  }
}

function evaluateDelivery(delivery: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!isRecord(delivery) || typeof delivery.required !== "boolean") {
    blockers.push(blocker("DELIVERY_INVALID", "delivery must declare a boolean required flag."));
    return;
  }
  if (delivery.required) {
    if (delivery.disposition !== "RECONCILED") {
      blockers.push(blocker("DELIVERY_NOT_RECONCILED", `external delivery is required but disposition is '${String(delivery.disposition)}' rather than RECONCILED.`));
    }
    const identityMismatch = identityMismatchFields(current, delivery.identity);
    if (identityMismatch.length > 0) {
      blockers.push(blocker("DELIVERY_IDENTITY_MISMATCH", `delivery is not bound to the current objective identity (${identityMismatch.join(", ")}).`));
    }
    return;
  }
  if (delivery.disposition !== "NOT_REQUIRED") {
    blockers.push(blocker("DELIVERY_UNEXPECTED_DISPOSITION", `external delivery is not required but disposition is '${String(delivery.disposition)}' rather than NOT_REQUIRED.`));
  }
  if (delivery.identity !== undefined) {
    const identityMismatch = identityMismatchFields(current, delivery.identity);
    if (identityMismatch.length > 0) {
      blockers.push(blocker("DELIVERY_IDENTITY_MISMATCH", `delivery is not bound to the current objective identity (${identityMismatch.join(", ")}).`));
    }
  }
}

function evaluateFindings(findings: unknown, current: ObjectiveCompletionIdentityV1, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!Array.isArray(findings)) {
    blockers.push(blocker("FINDINGS_INVALID", "objective findings must be an array."));
    return;
  }
  for (const finding of findings) {
    if (!isRecord(finding) || finding.blocking !== true) continue;
    let valid = true;
    try {
      assertCandidateRevisionV1(finding.candidate);
    } catch {
      valid = false;
    }
    if (!valid) {
      blockers.push(blocker("FINDING_CANDIDATE_INVALID", "a blocking objective finding does not carry a valid candidate revision."));
      continue;
    }
    const bound = finding.candidate as CandidateRevisionV1;
    if (candidateRevisionsEqual(bound, current.candidate)) {
      blockers.push(blocker("BLOCKING_FINDING", `blocking finding applies to the current candidate '${bound.candidateId}'@r${bound.revision}.`));
    }
  }
}

function evaluateParticipants(participants: unknown, blockers: ObjectiveCompletionBlockerV1[]): void {
  if (!Array.isArray(participants)) {
    blockers.push(blocker("PARTICIPANTS_INVALID", "objective participants must be an array."));
    return;
  }
  for (const participant of participants) {
    if (!isRecord(participant)) {
      blockers.push(blocker("PARTICIPANT_INVALID", "objective participant entries must be objects."));
      continue;
    }
    if (participant.required !== true) continue;
    const status = participant.status;
    if (typeof status !== "string" || !participantStatuses.has(status)) {
      blockers.push(blocker("PARTICIPANT_STATUS_INVALID", `required participant '${String(participant.id)}' has unsupported status '${String(status)}'.`));
      continue;
    }
    if (inFlightParticipantStatuses.has(status)) {
      blockers.push(blocker("PARTICIPANT_INCOMPLETE", `required participant '${String(participant.id)}' is still ${status}.`));
    }
  }
}

export function evaluateObjectiveCompletionV1(input: ObjectiveCompletionInputV1): ObjectiveCompletionDecisionV1 {
  const blockers: ObjectiveCompletionBlockerV1[] = [];
  if (!isRecord(input)) return decide([blocker("INPUT_INVALID", "objective completion input must be an object.")]);
  if (input.version !== OBJECTIVE_COMPLETION_VERSION) {
    blockers.push(blocker("VERSION_UNSUPPORTED", `objective completion input version '${String(input.version)}' is not supported.`));
  }
  const current = validateObjectiveIdentity(input.identity, blockers);
  validateWorkspaceCandidate(input.workspaceCandidate, current, blockers);
  evaluateWorkGraph(input.workGraph, blockers);
  evaluateAssertionEvidenceGate("VALIDATION", input.validation, current, blockers);
  evaluateAssertionEvidenceGate("REVIEW", input.review, current, blockers);
  evaluateAcceptance(input.acceptance, current, blockers);
  evaluateCertification(input.certification, current, blockers);
  evaluateDelivery(input.delivery, current, blockers);
  evaluateFindings(input.findings, current, blockers);
  evaluateParticipants(input.participants, blockers);
  const terminalMismatch = identityMismatchFields(current, input.terminalIdentity);
  if (terminalMismatch.length > 0) {
    blockers.push(blocker("TERMINAL_IDENTITY_MISMATCH", `terminal identity does not match the current objective identity (${terminalMismatch.join(", ")}).`));
  }
  return decide(blockers);
}
