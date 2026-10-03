import { assertResolvedOperationPolicyV2, type ResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import { sha256Canonical } from "../core/digest.js";
import { assertOperationOriginV1 } from "./operationProvenance.js";
import { collectOperationEconomicUsageV1, remainingEconomicEnvelopeForRecoveryV1, type OperationEconomicUsageSnapshotV1 } from "./economicUsage.js";
import { currentControllerEpoch, loadOperation, type OperationRecordV2 } from "./state.js";
import { createTrustedOperationToolError } from "./toolDiagnostics.js";

export interface RecoveryAuthorityV1 {
  policy: ResolvedOperationPolicyV2;
  remainingEconomicEnvelope: ResolvedOperationPolicyV2["economicEnvelope"];
  inheritedAuthorityDigest: string;
  parentUsage: OperationEconomicUsageSnapshotV1;
}

/**
 * DETERMINISTIC recovery authority resolution. A policy-less failed leaf is
 * recoverable only when its own frozen origin proves one direct, policy-bound
 * failed parent. This covers the crash window after origin creation and before
 * bootstrap policy binding; it does not infer authority from request content.
 */
export async function resolveRecoveryAuthorityV1(root: string, parent: OperationRecordV2): Promise<RecoveryAuthorityV1> {
  if (parent.status !== "FAILED") throw createTrustedOperationToolError("OPERATION_RECOVERY_PARENT_NOT_FAILED", "Only a terminal failed operation can authorize a recovery continuation.");
  if (parent.ownerEconomicBoundary || parent.ownerContinuationBoundary) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", "A linked continuation cannot bypass an Owner boundary; the human Owner must authorize a fresh top-level request under a changed policy.", undefined, parent.id);

  if (parent.resolvedOperationPolicy) {
    const policy = parent.resolvedOperationPolicy;
    assertResolvedOperationPolicyV2(policy);
    assertPolicyIdentity(parent, policy);
    const parentUsage = await collectOperationEconomicUsageV1(root, parent);
    const remainingEconomicEnvelope = remainingEconomicEnvelopeForRecoveryV1(policy.economicEnvelope, parentUsage);
    assertRecoveryDeadline(parent.origin?.rootHardDeadlineAt ?? policy.economicEnvelope.hardDeadlineAt ?? new Date(Date.parse(parent.createdAt) + policy.executionLiveness.hardDeadlineMs).toISOString(), parent.id);
    return {
      policy,
      remainingEconomicEnvelope,
      parentUsage,
      inheritedAuthorityDigest: sha256Canonical({ parentPolicyDigest: policy.digest, allowedExternalEffects: policy.allowedExternalEffects, parentOriginDigest: parent.origin?.digest ?? null, inheritedEconomicUsageDigest: parentUsage.digest })
    };
  }

  if (!parent.origin || parent.origin.kind !== "FAILED_OPERATION_RECOVERY") {
    throw createTrustedOperationToolError("OPERATION_RECOVERY_AUTHORITY_MISSING", "Failed parent has no frozen policy or verifiable linked policy ancestor.", undefined, parent.id);
  }
  assertOperationOriginV1(parent.origin);
  const ancestor = await loadOperation(root, parent.origin.parentOperationId!);
  if (ancestor.status !== "FAILED" || ancestor.revision !== parent.origin.parentTerminalRevision) {
    throw new Error("OPERATION_RECOVERY_PARENT_STALE: the policy-bearing ancestor id, terminal status, or revision changed.");
  }
  if (ancestor.ownerEconomicBoundary || ancestor.ownerContinuationBoundary) {
    throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", "A linked continuation cannot bypass an Owner boundary in its policy-bearing ancestor.", undefined, ancestor.id);
  }
  const policy = ancestor.resolvedOperationPolicy;
  if (!policy) throw createTrustedOperationToolError("OPERATION_RECOVERY_AUTHORITY_MISSING", "Policy-less recovery ancestry has no frozen authority anchor.", undefined, ancestor.id);
  assertResolvedOperationPolicyV2(policy);
  assertPolicyIdentity(ancestor, policy);

  const ancestorUsage = await collectOperationEconomicUsageV1(root, ancestor);
  if (ancestorUsage.digest !== parent.origin.inheritedEconomicUsageDigest) throw new Error("OPERATION_RECOVERY_USAGE_STALE: policy-bearing ancestor usage changed after the failed leaf was created.");
  const expectedParentAuthorityDigest = sha256Canonical({ parentPolicyDigest: policy.digest, allowedExternalEffects: policy.allowedExternalEffects, parentOriginDigest: ancestor.origin?.digest ?? null, inheritedEconomicUsageDigest: ancestorUsage.digest });
  if (expectedParentAuthorityDigest !== parent.origin.inheritedAuthorityDigest) throw new Error("OPERATION_RECOVERY_AUTHORITY_STALE: failed leaf origin no longer matches its policy-bearing ancestor.");
  const inheritedRootDeadlineAt = ancestor.origin?.rootHardDeadlineAt
    ?? policy.economicEnvelope.hardDeadlineAt
    ?? new Date(Date.parse(ancestor.createdAt) + policy.executionLiveness.hardDeadlineMs).toISOString();
  if (parent.origin.rootHardDeadlineAt !== inheritedRootDeadlineAt) {
    throw new Error("OPERATION_RECOVERY_DEADLINE_STALE: failed leaf changed its inherited root deadline.");
  }
  assertRecoveryDeadline(inheritedRootDeadlineAt, parent.id);

  const parentUsage = await collectOperationEconomicUsageV1(root, parent);
  const afterAncestor = remainingEconomicEnvelopeForRecoveryV1(policy.economicEnvelope, ancestorUsage);
  const remainingEconomicEnvelope = remainingEconomicEnvelopeForRecoveryV1(afterAncestor, parentUsage);
  // This digest commits to both exact links, both terminal revisions and the
  // observed usage snapshots so bootstrap can repeat the same deterministic check.
  const inheritedAuthorityDigest = sha256Canonical({
    version: 1,
    authorityOperationId: ancestor.id,
    authorityTerminalRevision: ancestor.revision,
    authorityPolicyDigest: policy.digest,
    authorityOriginDigest: ancestor.origin?.digest ?? null,
    authorityUsageDigest: ancestorUsage.digest,
    parentOperationId: parent.id,
    parentTerminalRevision: parent.revision,
    parentOriginDigest: parent.origin.digest,
    parentUsageDigest: parentUsage.digest,
    remainingEconomicEnvelope
  });
  return { policy, remainingEconomicEnvelope, inheritedAuthorityDigest, parentUsage };
}

function assertPolicyIdentity(operation: OperationRecordV2, policy: ResolvedOperationPolicyV2): void {
  const candidate = operation.candidateRevision;
  if (policy.operationId !== operation.id || !candidate
    || policy.operationExecutionRevision !== operation.operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(operation)
    || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new Error("OPERATION_RECOVERY_POLICY_CORRUPT: frozen policy identity does not match its operation, candidate, execution revision, or controller epoch.");
  }
}

function assertRecoveryDeadline(deadlineAt: string, operationId: string): void {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", "The inherited hard deadline has elapsed; the human Owner must authorize a fresh top-level request.", undefined, operationId);
  }
}
