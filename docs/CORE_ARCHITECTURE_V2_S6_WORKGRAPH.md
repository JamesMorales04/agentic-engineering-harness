# Core Architecture v2 S6 WorkGraph

**Slice:** S6 — AcceptanceOracle & Objective Completion
**Baseline:** `core-architecture-v2` at `df0b6edd5bfa113aba722ada9b8b2ea0fd3cac36`
**Scope:** S6 only. S1–S5 are accepted. S7 and all other slices are excluded.

## Objective and gate

Complete `AcceptanceAssertion`, `VerificationRequirement`, `OracleResolver`, candidate-bound `EvidenceBundle`, and controller-owned `AcceptanceOracle` disposition. Enforce the normative objective Definition of Done and require managed Lead acceptance evidence and an accepted current oracle disposition before delivery effects.

The gate is satisfied only when every required assertion has sufficient current candidate-bound evidence, validation PASS and reviewer opinion remain insufficient by themselves, and completion evaluates the complete objective evidence set.

The normative target remains unchanged. The existing S4 `AcceptanceAssertionV1` bindings to candidate, impact digest, policy digest, dimensions, and evidence-strength floor are consumed as compiled; they are not reinterpreted or weakened.

## Tactical WorkGraph

| ID | WorkUnit | Classification | Mechanism | Scope / acceptance |
| --- | --- | --- | --- | --- |
| S6-W1 | Freeze the S6 evidence and disposition contracts against §9.4, §10.2, and §12. | LUNA_OWNED | HYBRID | Preserve the S4 assertion/evidence-strength interface, S3 Lead/human authority, and the distinction among validation, review, acceptance, CertificationCore, and completion. No target change. |
| S6-W2 | Implement deterministic verification requirement resolution, current evidence bundling, and AcceptanceOracle disposition with durable operation persistence. | LUNA_OWNED | HYBRID | Every required assertion resolves to approved evidence mechanisms; current candidate, impact, frozen policy, execution identity, provenance, and strength are checked. Construct `policyDigest` only from the current validated `ResolvedOperationPolicyV1`: require its operation, candidate revision/digest, operation execution revision, and `controllerEpoch` to match the current operation before using its canonical digest. Never accept an arbitrary caller-supplied digest as proof of current policy/epoch. Missing/stale/failed evidence blocks; PASS/reviewer/Lead claims cannot override. CertificationCore remains a separate evidence producer. |
| S6-W3 | Implement the pure objective Definition of Done evaluator behind the frozen interface below. | FLASH_DELEGATABLE | DETERMINISTIC | New `src/architecture/objectiveCompletion.ts` and `tests/objectiveCompletion.test.ts` only. Deterministically checks the whole objective snapshot and returns stable blocker codes. No lifecycle integration. |
| S6-W4 | Integrate managed Lead semantic evidence, oracle persistence, pre-delivery enforcement, candidate invalidation, and terminal completion gating. | SEQUENTIAL_AFTER_CONTRACT_FREEZE | HYBRID | Lead evidence is candidate-bound and independent of the implementation actor; it is input only. Controller-owned oracle disposition remains authoritative. No delivery effect before current Lead evidence and AcceptanceOracle acceptance. Candidate/policy/execution changes invalidate prior evidence/disposition. |
| S6-W5 | Add end-to-end lifecycle regressions, review the integrated diff, reconcile Status/Conformance/Ledger, and run the S6 validation ladder. | LUNA_OWNED | DETERMINISTIC | Prove the exact S6 gate with reproducible fixtures. Keep REAL_PROVIDER, BROWSER, OPA_PROVIDER, ADVERSARIAL, and PACKED_E2E claims separate. |

Dependencies: `S6-W1 → S6-W2`; `S6-W1 → S6-W3`; `S6-W2 + S6-W3 → S6-W4`; `S6-W4 → S6-W5`.

## Frozen interface for S6-W3

The evaluator is a pure deterministic function. Its input is compiled by controller-owned integration from durable current records; callers cannot use model output to set gate facts. It must not read files, select evidence, invoke tools, infer semantic meaning, or mutate operation state.

```ts
type ObjectiveEvidenceStatusV1 = "PASS" | "FAIL";
type ObjectiveParticipantStatusV1 =
  | "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED"
  | "FAILED" | "BLOCKED" | "CANCELLED";

interface ObjectiveCompletionIdentityV1 {
  operationId: string;
  candidate: CandidateRevisionV1;
  policyDigest: string;
  operationExecutionRevision: number;
  controllerEpoch: number;
}

interface ObjectiveAssertionEvidenceV1 {
  assertionId: string;
  status: ObjectiveEvidenceStatusV1;
  identity: ObjectiveCompletionIdentityV1;
}

interface ObjectiveCompletionInputV1 {
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
  participants: Array<{
    id: string;
    required: boolean;
    status: ObjectiveParticipantStatusV1;
  }>;
  terminalIdentity: ObjectiveCompletionIdentityV1;
}

interface ObjectiveCompletionDecisionV1 {
  version: 1;
  complete: boolean;
  blockers: Array<{ code: string; message: string }>;
}

function evaluateObjectiveCompletionV1(
  input: ObjectiveCompletionInputV1
): ObjectiveCompletionDecisionV1;
```

Required deterministic rules:

1. Validate schema, non-empty operation/policy identity, positive execution revision, non-negative safe-integer controller epoch (zero is valid), candidate validity, and current workspace/candidate equality. W2 must construct the identity's policy digest from the current validated frozen policy and verify that policy's operation, candidate revision/digest, execution revision, and controller epoch against the current operation before calling this evaluator.
2. Require every WorkGraph unit to be accounted for; reject duplicate IDs in either set.
3. For every required validation and review assertion, require exactly one PASS item bound to the full current operation/candidate/policy/execution/controller-epoch identity. Missing, duplicate, failed, stale-candidate, stale-policy, stale-execution, or old-epoch items block. Non-required items do not expand the gate.
4. Require an `ACCEPTED` disposition, exact current identity including controller epoch, unique required assertion IDs, and complete required assertion coverage. Missing or additional covered assertion IDs block.
5. When certification is required, require PASS evidence bound to the exact current identity including controller epoch. When certification is not required, omit both its disposition and identity. `ObjectiveCompletionInputV1` has no `NOT_REQUIRED` certification value; supplying either a `PASS`/`FAIL` disposition or an identity when certification is not required blocks completion. When external delivery is required, require `RECONCILED` evidence bound to the exact current identity including controller epoch; an unknown/pending effect blocks. When delivery is not required, its disposition must be `NOT_REQUIRED`.
6. A blocking finding for the current candidate blocks. A valid finding bound to an older candidate does not describe the current candidate.
7. No required participant may remain `REGISTERED`, `IDLE`, or `RUNNING`.
8. Terminal identity must exactly match the current operation/candidate/policy/execution/controller-epoch identity. Evidence from a prior controller epoch is stale after takeover and must be rejected; acceptance/completion records do not survive an epoch change.
9. Return stable, sorted blocker codes/messages; no timestamps, randomness, or model classifications affect the result.

The S6-W3 worker must add focused positive and negative tests for each rule, including a valid epoch-0 identity, stale candidate/policy/execution evidence, old-epoch evidence after takeover, empty required sets, duplicates, and mismatched terminal identity. It must not change this interface or its rules. S6-W2 integration tests additionally recompile the same frozen policy at a new controller epoch, prove its canonical digest changes, then prove old-epoch evidence and terminal identity are rejected.

### S6-W3 completion and certification contract reconciliation

The Director's pre-edit review found that an earlier WorkGraph draft required `NOT_REQUIRED` certification although the frozen interface has only an optional `PASS | FAIL` disposition and the normative target requires no synthetic certification record. Rule 5 above is the settled contract: when certification is not required, omit both disposition and identity; the evaluator rejects either supplied field. Focused regressions cover omitted certification as valid and reject both a supplied disposition and a supplied identity. This reconciliation changes neither the frozen type nor the normative target.

S6-W3 implementation is complete against that corrected interface. The focused `npx vitest run tests/objectiveCompletion.test.ts` passes 73 tests, including valid epoch zero, old-epoch evidence/terminal rejection, and both certification omission/rejection cases. The later S6 focused integration set and full non-system suite also pass as recorded in Status and Conformance.

## Exclusions and target boundary

- No S7 or unrelated slice work.
- No change to `docs/CORE_ARCHITECTURE_V2.md`, authority grants, operation state meanings, route policy, S3 decision semantics, S4 impact/assertion/evidence-strength contracts, CertificationCore responsibility, or delivery action authorization.
- No acceptance through validation PASS, reviewer agreement, participant completion, completion claims, Lead opinion, or model-selected evidence.
- No compatibility aliases, old acceptance path, or fallback behavior.
- This is the external controller development checkout; AEH does not govern it.
