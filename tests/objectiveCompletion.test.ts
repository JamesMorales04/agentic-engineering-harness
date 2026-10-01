import { describe, expect, it } from "vitest";
import type {
  ObjectiveAssertionEvidenceV1,
  ObjectiveCompletionIdentityV1,
  ObjectiveCompletionInputV1,
  ObjectiveParticipantStatusV1
} from "../src/architecture/objectiveCompletion.js";
import { evaluateObjectiveCompletionV1 } from "../src/architecture/objectiveCompletion.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { sha256Canonical } from "../src/core/digest.js";

const OPERATION_ID = "OP-S6";
const POLICY_DIGEST = sha256Canonical("frozen-s6-policy");
const EXECUTION_REVISION = 7;
const CONTROLLER_EPOCH = 2;

function candidate(overrides: { operationId?: string; candidateId?: string; revision?: number; sourceDigest?: string } = {}): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId: OPERATION_ID,
    candidateId: `candidate:${OPERATION_ID}:r3`,
    projectId: "project-s6",
    taskId: "TASK-S6",
    revision: 3,
    sourceDigest: sha256Canonical("s6-candidate-source"),
    ...overrides
  });
}

function identity(overrides: Partial<ObjectiveCompletionIdentityV1> = {}): ObjectiveCompletionIdentityV1 {
  return {
    operationId: OPERATION_ID,
    candidate: candidate(),
    policyDigest: POLICY_DIGEST,
    operationExecutionRevision: EXECUTION_REVISION,
    controllerEpoch: CONTROLLER_EPOCH,
    ...overrides
  };
}

function evidence(assertionId: string, current: ObjectiveCompletionIdentityV1, status: "PASS" | "FAIL" = "PASS"): ObjectiveAssertionEvidenceV1 {
  return { assertionId, status, identity: current };
}

function baseInput(): ObjectiveCompletionInputV1 {
  const current = identity();
  return {
    version: 1,
    identity: current,
    workspaceCandidate: candidate(),
    workGraph: { requiredWorkUnitIds: ["WU-1", "WU-2"], accountedWorkUnitIds: ["WU-1", "WU-2"] },
    validation: { requiredAssertionIds: ["ASSERT-V1"], evidence: [evidence("ASSERT-V1", current)] },
    review: { requiredAssertionIds: ["ASSERT-R1"], evidence: [evidence("ASSERT-R1", current)] },
    acceptance: { disposition: "ACCEPTED", requiredAssertionIds: ["ASSERT-A1"], coveredAssertionIds: ["ASSERT-A1"], identity: current },
    certification: { required: false },
    delivery: { required: false, disposition: "NOT_REQUIRED" },
    findings: [],
    participants: [
      { id: "implementer", required: true, status: "COMPLETED" },
      { id: "observer", required: false, status: "RUNNING" }
    ],
    terminalIdentity: current
  };
}

function buildInput(patch: (draft: ObjectiveCompletionInputV1) => void): ObjectiveCompletionInputV1 {
  const draft = baseInput();
  patch(draft);
  return draft;
}

function blockerCodes(input: ObjectiveCompletionInputV1): string[] {
  return evaluateObjectiveCompletionV1(input).blockers.map((entry) => entry.code);
}

describe("evaluateObjectiveCompletionV1", () => {
  describe("complete objective snapshots", () => {
    it("returns a complete decision for a fully reconciled objective", () => {
      expect(evaluateObjectiveCompletionV1(buildInput(() => {}))).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("accepts empty required work, validation, review, and acceptance sets", () => {
      const input = buildInput((draft) => {
        draft.workGraph = { requiredWorkUnitIds: [], accountedWorkUnitIds: [] };
        draft.validation = { requiredAssertionIds: [], evidence: [] };
        draft.review = { requiredAssertionIds: [], evidence: [] };
        draft.acceptance = { disposition: "ACCEPTED", requiredAssertionIds: [], coveredAssertionIds: [], identity: draft.identity };
        draft.participants = [];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("accepts non-required work units once every required unit is accounted", () => {
      const input = buildInput((draft) => {
        draft.workGraph.accountedWorkUnitIds = ["WU-1", "WU-2", "WU-EXTRA"];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("does not let non-required evidence expand the gate", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [
          evidence("ASSERT-V1", draft.identity),
          evidence("ASSERT-EXTRA", identity({ controllerEpoch: 1 }), "FAIL")
        ];
        draft.review.evidence = [
          evidence("ASSERT-R1", draft.identity),
          evidence("ASSERT-R1-EXTRA", identity({ policyDigest: sha256Canonical("other-policy") }), "FAIL")
        ];
      });
      expect(evaluateObjectiveCompletionV1(input)).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("accepts required certification and external delivery bound to the current identity", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: true, disposition: "PASS", identity: draft.identity };
        draft.delivery = { required: true, disposition: "RECONCILED", identity: draft.identity };
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("accepts controllerEpoch zero as a valid current objective epoch", () => {
      const zeroEpoch = identity({ controllerEpoch: 0 });
      const input = buildInput((draft) => {
        draft.identity = zeroEpoch;
        draft.validation.evidence = [evidence("ASSERT-V1", zeroEpoch)];
        draft.review.evidence = [evidence("ASSERT-R1", zeroEpoch)];
        draft.acceptance.identity = zeroEpoch;
        draft.terminalIdentity = zeroEpoch;
      });
      expect(evaluateObjectiveCompletionV1(input)).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("accepts controllerEpoch zero across certification, delivery, and every evidence gate", () => {
      const zeroEpoch = identity({ controllerEpoch: 0 });
      const input = buildInput((draft) => {
        draft.identity = zeroEpoch;
        draft.validation.evidence = [evidence("ASSERT-V1", zeroEpoch)];
        draft.review.evidence = [evidence("ASSERT-R1", zeroEpoch)];
        draft.acceptance.identity = zeroEpoch;
        draft.certification = { required: true, disposition: "PASS", identity: zeroEpoch };
        draft.delivery = { required: true, disposition: "RECONCILED", identity: zeroEpoch };
        draft.terminalIdentity = zeroEpoch;
      });
      expect(evaluateObjectiveCompletionV1(input)).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("is deterministic, deduplicated, sorted, and side-effect free", () => {
      const input = buildInput((draft) => {
        draft.participants = [{ id: "implementer", required: true, status: "RUNNING" }];
        draft.validation.evidence = [];
        draft.delivery = { required: true, disposition: "PENDING" };
        draft.terminalIdentity = identity({ controllerEpoch: 1 });
      });
      const snapshot = JSON.parse(JSON.stringify(input)) as ObjectiveCompletionInputV1;
      const first = evaluateObjectiveCompletionV1(input);
      const second = evaluateObjectiveCompletionV1(input);
      expect(first).toEqual(second);
      expect(first.complete).toBe(false);
      const codes = first.blockers.map((entry) => entry.code);
      expect(codes).toEqual([...codes].sort());
      expect(new Set(first.blockers.map((entry) => `${entry.code}\u0000${entry.message}`)).size).toBe(first.blockers.length);
      expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    });
  });

  describe("objective identity validation", () => {
    it("rejects a non-object input", () => {
      const decision = evaluateObjectiveCompletionV1(null as unknown as ObjectiveCompletionInputV1);
      expect(decision.complete).toBe(false);
      expect(decision.blockers.map((entry) => entry.code)).toEqual(["INPUT_INVALID"]);
    });

    it("blocks an unsupported input version", () => {
      const input = buildInput((draft) => {
        (draft as { version: number }).version = 2;
      });
      expect(blockerCodes(input)).toContain("VERSION_UNSUPPORTED");
    });

    it("blocks an empty operation identity", () => {
      const input = buildInput((draft) => {
        draft.identity.operationId = "";
      });
      expect(blockerCodes(input)).toContain("OPERATION_ID_INVALID");
    });

    it("blocks an empty policy identity", () => {
      const input = buildInput((draft) => {
        draft.identity.policyDigest = "";
      });
      expect(blockerCodes(input)).toContain("POLICY_DIGEST_INVALID");
    });

    it("blocks a zero or negative operation execution revision", () => {
      for (const revision of [0, -1]) {
        const input = buildInput((draft) => {
          draft.identity.operationExecutionRevision = revision;
        });
        expect(blockerCodes(input)).toContain("EXECUTION_REVISION_INVALID");
      }
    });

    it("blocks a negative, fractional, unsafe, or non-numeric controller epoch", () => {
      for (const epoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "2", undefined]) {
        const input = buildInput((draft) => {
          draft.identity.controllerEpoch = epoch as number;
        });
        expect(blockerCodes(input)).toContain("CONTROLLER_EPOCH_INVALID");
      }
    });

    it("blocks a tampered current candidate identity", () => {
      const input = buildInput((draft) => {
        draft.identity.candidate = { ...candidate(), identityDigest: sha256Canonical("tampered") };
      });
      const codes = blockerCodes(input);
      expect(codes).toContain("CANDIDATE_INVALID");
      expect(codes).toContain("WORKSPACE_CANDIDATE_MISMATCH");
    });

    it("blocks a current candidate bound to a different operation", () => {
      const input = buildInput((draft) => {
        draft.identity.candidate = candidate({ operationId: "OP-OTHER", candidateId: "candidate:OP-OTHER:r3" });
      });
      expect(blockerCodes(input)).toContain("CANDIDATE_OPERATION_MISMATCH");
    });

    it("blocks a workspace candidate with a different revision", () => {
      const input = buildInput((draft) => {
        draft.workspaceCandidate = candidate({ revision: 4 });
      });
      expect(blockerCodes(input)).toContain("WORKSPACE_CANDIDATE_MISMATCH");
    });

    it("blocks a workspace candidate with a different source digest", () => {
      const input = buildInput((draft) => {
        draft.workspaceCandidate = candidate({ sourceDigest: sha256Canonical("other-s6-candidate-source") });
      });
      expect(blockerCodes(input)).toContain("WORKSPACE_CANDIDATE_MISMATCH");
    });

    it("blocks an invalid workspace candidate record", () => {
      const input = buildInput((draft) => {
        draft.workspaceCandidate = { bogus: true } as unknown as CandidateRevisionV1;
      });
      const codes = blockerCodes(input);
      expect(codes).toContain("WORKSPACE_CANDIDATE_INVALID");
      expect(codes).toContain("WORKSPACE_CANDIDATE_MISMATCH");
    });
  });

  describe("work graph accounting", () => {
    it("blocks a required work unit with no accounted result", () => {
      const input = buildInput((draft) => {
        draft.workGraph.accountedWorkUnitIds = ["WU-1"];
      });
      expect(blockerCodes(input)).toContain("WORK_UNIT_UNACCOUNTED");
    });

    it("blocks duplicate required work unit ids", () => {
      const input = buildInput((draft) => {
        draft.workGraph.requiredWorkUnitIds = ["WU-1", "WU-1", "WU-2"];
      });
      expect(blockerCodes(input)).toContain("WORK_UNIT_REQUIRED_DUPLICATE");
    });

    it("blocks duplicate accounted work unit ids", () => {
      const input = buildInput((draft) => {
        draft.workGraph.accountedWorkUnitIds = ["WU-1", "WU-1", "WU-2"];
      });
      expect(blockerCodes(input)).toContain("WORK_UNIT_ACCOUNTED_DUPLICATE");
    });
  });

  describe("validation evidence", () => {
    it("blocks a required validation assertion with no evidence", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_MISSING");
    });

    it("blocks a duplicated validation evidence item", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", draft.identity), evidence("ASSERT-V1", draft.identity)];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_DUPLICATE");
    });

    it("blocks failed validation evidence", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", draft.identity, "FAIL")];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_FAILED");
    });

    it("blocks validation evidence bound to a stale candidate", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", identity({ candidate: candidate({ revision: 2 }) }))];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_STALE");
    });

    it("blocks validation evidence bound to a stale policy digest", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", identity({ policyDigest: sha256Canonical("old-policy") }))];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_STALE");
    });

    it("blocks validation evidence bound to a stale operation execution revision", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", identity({ operationExecutionRevision: EXECUTION_REVISION - 1 }))];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_STALE");
    });

    it("blocks validation evidence bound to a different operation", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", identity({ operationId: "OP-OTHER" }))];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_STALE");
    });

    it("rejects validation evidence from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.validation.evidence = [evidence("ASSERT-V1", identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }))];
      });
      expect(blockerCodes(input)).toContain("VALIDATION_EVIDENCE_STALE");
    });
  });

  describe("review evidence", () => {
    it("blocks a required review assertion with no evidence", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_MISSING");
    });

    it("blocks a duplicated review evidence item", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", draft.identity), evidence("ASSERT-R1", identity({ controllerEpoch: 1 }))];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_DUPLICATE");
    });

    it("blocks failed review evidence", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", draft.identity, "FAIL")];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_FAILED");
    });

    it("blocks review evidence bound to a stale candidate", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", identity({ candidate: candidate({ revision: 2 }) }))];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_STALE");
    });

    it("blocks review evidence bound to a stale policy digest", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", identity({ policyDigest: sha256Canonical("old-policy") }))];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_STALE");
    });

    it("blocks review evidence bound to a stale operation execution revision", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", identity({ operationExecutionRevision: EXECUTION_REVISION - 1 }))];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_STALE");
    });

    it("rejects review evidence from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.review.evidence = [evidence("ASSERT-R1", identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }))];
      });
      expect(blockerCodes(input)).toContain("REVIEW_EVIDENCE_STALE");
    });
  });

  describe("acceptance disposition and coverage", () => {
    it("blocks a rejected acceptance disposition", () => {
      const input = buildInput((draft) => {
        draft.acceptance.disposition = "REJECTED";
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_NOT_ACCEPTED");
    });

    it("blocks acceptance from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.acceptance.identity = identity({ controllerEpoch: CONTROLLER_EPOCH - 1 });
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_IDENTITY_MISMATCH");
    });

    it("blocks acceptance bound to a stale policy digest", () => {
      const input = buildInput((draft) => {
        draft.acceptance.identity = identity({ policyDigest: sha256Canonical("old-policy") });
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_IDENTITY_MISMATCH");
    });

    it("blocks duplicate required acceptance assertion ids", () => {
      const input = buildInput((draft) => {
        draft.acceptance.requiredAssertionIds = ["ASSERT-A1", "ASSERT-A1"];
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_REQUIRED_DUPLICATE");
    });

    it("blocks acceptance with missing required assertion coverage", () => {
      const input = buildInput((draft) => {
        draft.acceptance.requiredAssertionIds = ["ASSERT-A1", "ASSERT-A2"];
      });
      const decision = evaluateObjectiveCompletionV1(input);
      expect(decision.complete).toBe(false);
      expect(decision.blockers.map((entry) => entry.code)).toContain("ACCEPTANCE_COVERAGE_MISSING");
      expect(decision.blockers.some((entry) => entry.message.includes("ASSERT-A2"))).toBe(true);
    });

    it("blocks acceptance with additional covered assertion ids", () => {
      const input = buildInput((draft) => {
        draft.acceptance.coveredAssertionIds = ["ASSERT-A1", "ASSERT-A2"];
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_COVERAGE_ADDITIONAL");
    });

    it("blocks duplicated covered assertion ids", () => {
      const input = buildInput((draft) => {
        draft.acceptance.coveredAssertionIds = ["ASSERT-A1", "ASSERT-A1"];
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_COVERED_DUPLICATE");
    });

    it("treats an empty required set as exactly covered by an empty covered set", () => {
      const input = buildInput((draft) => {
        draft.acceptance.requiredAssertionIds = [];
        draft.acceptance.coveredAssertionIds = ["ASSERT-A1"];
      });
      expect(blockerCodes(input)).toContain("ACCEPTANCE_COVERAGE_ADDITIONAL");
      const covered = buildInput((draft) => {
        draft.acceptance.requiredAssertionIds = [];
        draft.acceptance.coveredAssertionIds = [];
      });
      expect(evaluateObjectiveCompletionV1(covered).complete).toBe(true);
    });
  });

  describe("certification", () => {
    it("blocks required certification without a PASS disposition and current identity", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: true };
      });
      const codes = blockerCodes(input);
      expect(codes).toContain("CERTIFICATION_REQUIRED_NOT_PASS");
      expect(codes).toContain("CERTIFICATION_IDENTITY_MISMATCH");
    });

    it("blocks required certification with a FAIL disposition", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: true, disposition: "FAIL", identity: draft.identity };
      });
      expect(blockerCodes(input)).toContain("CERTIFICATION_REQUIRED_NOT_PASS");
    });

    it("rejects required certification from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: true, disposition: "PASS", identity: identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }) };
      });
      expect(blockerCodes(input)).toContain("CERTIFICATION_IDENTITY_MISMATCH");
    });

    it("blocks a certification disposition when certification is not required", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: false, disposition: "PASS" };
      });
      expect(blockerCodes(input)).toContain("CERTIFICATION_UNEXPECTED_DISPOSITION");
    });

    it("rejects a stale certification identity even when certification is not required", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: false, identity: identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }) };
      });
      const codes = blockerCodes(input);
      expect(codes).toContain("CERTIFICATION_IDENTITY_MISMATCH");
      expect(codes).toContain("CERTIFICATION_UNEXPECTED_IDENTITY");
    });

    it("accepts an omitted certification record when certification is not required", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: false };
      });
      expect(evaluateObjectiveCompletionV1(input)).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("blocks a certification identity when certification is not required", () => {
      const input = buildInput((draft) => {
        draft.certification = { required: false, identity: draft.identity };
      });
      const decision = evaluateObjectiveCompletionV1(input);
      expect(decision.complete).toBe(false);
      expect(decision.blockers.map((entry) => entry.code)).toContain("CERTIFICATION_UNEXPECTED_IDENTITY");
    });
  });

  describe("external delivery", () => {
    it("blocks required delivery that is still PENDING", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: true, disposition: "PENDING", identity: draft.identity };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_NOT_RECONCILED");
    });

    it("blocks required delivery declared NOT_REQUIRED", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: true, disposition: "NOT_REQUIRED" };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_NOT_RECONCILED");
    });

    it("rejects required reconciled delivery from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: true, disposition: "RECONCILED", identity: identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }) };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_IDENTITY_MISMATCH");
    });

    it("blocks required reconciled delivery without a bound identity", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: true, disposition: "RECONCILED" };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_IDENTITY_MISMATCH");
    });

    it("accepts NOT_REQUIRED delivery without an identity when external delivery is not required", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: false, disposition: "NOT_REQUIRED" };
      });
      expect(evaluateObjectiveCompletionV1(input)).toEqual({ version: 1, complete: true, blockers: [] });
    });

    it("blocks a pending delivery disposition when external delivery is not required", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: false, disposition: "PENDING" };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_UNEXPECTED_DISPOSITION");
    });

    it("rejects a stale delivery identity even when external delivery is not required", () => {
      const input = buildInput((draft) => {
        draft.delivery = { required: false, disposition: "NOT_REQUIRED", identity: identity({ controllerEpoch: CONTROLLER_EPOCH - 1 }) };
      });
      expect(blockerCodes(input)).toContain("DELIVERY_IDENTITY_MISMATCH");
    });
  });

  describe("findings", () => {
    it("blocks a blocking finding for the current candidate", () => {
      const input = buildInput((draft) => {
        draft.findings = [{ candidate: candidate(), blocking: true }];
      });
      expect(blockerCodes(input)).toContain("BLOCKING_FINDING");
    });

    it("does not block a non-blocking finding for the current candidate", () => {
      const input = buildInput((draft) => {
        draft.findings = [{ candidate: candidate(), blocking: false }];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("does not block a blocking finding for an older candidate revision", () => {
      const input = buildInput((draft) => {
        draft.findings = [{ candidate: candidate({ revision: 2 }), blocking: true }];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("does not block a blocking finding for another operation", () => {
      const input = buildInput((draft) => {
        draft.findings = [{ candidate: candidate({ operationId: "OP-OTHER", candidateId: "candidate:OP-OTHER:r3" }), blocking: true }];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("blocks a blocking finding that carries no valid candidate revision", () => {
      const input = buildInput((draft) => {
        draft.findings = [{ candidate: { bogus: true } as unknown as CandidateRevisionV1, blocking: true }];
      });
      expect(blockerCodes(input)).toContain("FINDING_CANDIDATE_INVALID");
    });
  });

  describe("required participant states", () => {
    it("blocks required participants that remain REGISTERED, IDLE, or RUNNING", () => {
      for (const status of ["REGISTERED", "IDLE", "RUNNING"] as ObjectiveParticipantStatusV1[]) {
        const input = buildInput((draft) => {
          draft.participants = [{ id: "implementer", required: true, status }];
        });
        expect(blockerCodes(input)).toContain("PARTICIPANT_INCOMPLETE");
      }
    });

    it("does not block required participants whose work has terminated", () => {
      for (const status of ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"] as ObjectiveParticipantStatusV1[]) {
        const input = buildInput((draft) => {
          draft.participants = [{ id: "implementer", required: true, status }];
        });
        expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
      }
    });

    it("does not block non-required participants that are still running", () => {
      const input = buildInput((draft) => {
        draft.participants = [{ id: "observer", required: false, status: "RUNNING" }];
      });
      expect(evaluateObjectiveCompletionV1(input).complete).toBe(true);
    });

    it("blocks a required participant with an unsupported status", () => {
      const input = buildInput((draft) => {
        draft.participants = [{ id: "implementer", required: true, status: "UNKNOWN" as ObjectiveParticipantStatusV1 }];
      });
      expect(blockerCodes(input)).toContain("PARTICIPANT_STATUS_INVALID");
    });
  });

  describe("terminal identity", () => {
    it("blocks a terminal identity bound to a different candidate", () => {
      const input = buildInput((draft) => {
        draft.terminalIdentity = identity({ candidate: candidate({ revision: 2 }) });
      });
      expect(blockerCodes(input)).toContain("TERMINAL_IDENTITY_MISMATCH");
    });

    it("blocks a terminal identity bound to a different policy digest", () => {
      const input = buildInput((draft) => {
        draft.terminalIdentity = identity({ policyDigest: sha256Canonical("old-policy") });
      });
      expect(blockerCodes(input)).toContain("TERMINAL_IDENTITY_MISMATCH");
    });

    it("blocks a terminal identity bound to a different operation execution revision", () => {
      const input = buildInput((draft) => {
        draft.terminalIdentity = identity({ operationExecutionRevision: EXECUTION_REVISION - 1 });
      });
      expect(blockerCodes(input)).toContain("TERMINAL_IDENTITY_MISMATCH");
    });

    it("explicitly rejects a terminal identity from the prior controller epoch after takeover", () => {
      const input = buildInput((draft) => {
        draft.terminalIdentity = identity({ controllerEpoch: CONTROLLER_EPOCH - 1 });
      });
      const decision = evaluateObjectiveCompletionV1(input);
      expect(decision.complete).toBe(false);
      const terminal = decision.blockers.find((entry) => entry.code === "TERMINAL_IDENTITY_MISMATCH");
      expect(terminal?.message).toContain("controllerEpoch");
    });

    it("blocks a missing terminal identity", () => {
      const input = buildInput((draft) => {
        draft.terminalIdentity = undefined as unknown as ObjectiveCompletionIdentityV1;
      });
      expect(blockerCodes(input)).toContain("TERMINAL_IDENTITY_MISMATCH");
    });
  });
});
