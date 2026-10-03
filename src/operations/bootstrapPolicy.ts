import { compileResolvedOperationPolicy, assertResolvedOperationPolicyV2 } from "../architecture/executionIdentity.js";
import type { EconomicEnvelopeV1 } from "./executionLiveness.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import { sha256Canonical } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { configuredDeliveryPolicy, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import { bindResolvedOperationPolicy, currentControllerEpoch, loadOperation, type OperationRecordV2 } from "./state.js";
import { assertOperationOriginV1 } from "./operationProvenance.js";
import { collectOperationEconomicUsageV1, remainingEconomicEnvelopeForRecoveryV1 } from "./economicUsage.js";

/**
 * DETERMINISTIC provisional bootstrap policy for a fresh candidate. It carries the
 * `knowledgePolicy.bootstrap` marker, so the first real execution-semantics bind replaces it and
 * advances the operation execution revision instead of treating it as a frozen baseline. The
 * controller binds it after every candidate bind (workspace candidate, controller-owned authoring
 * advance) because binding a candidate clears the frozen policy.
 */
export async function bindBootstrapOperationPolicy(
  root: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  route: ImplementationRoute,
  minimumAssurance: AssuranceLevel,
  contract?: TaskContract
): Promise<OperationRecordV2> {
  const candidate = operation.candidateRevision;
  const controllerEpoch = currentControllerEpoch(operation);
  if (!candidate || !Number.isSafeInteger(operation.operationExecutionRevision) || !operation.controller?.tokenDigest) {
    throw new Error("EXECUTION_POLICY_INPUT_MISSING: bootstrap policy requires current candidate, operation execution revision, and claimed controller epoch.");
  }
  if (operation.resolvedOperationPolicy) {
    const frozen = operation.resolvedOperationPolicy;
    assertResolvedOperationPolicyV2(frozen);
    if (frozen.operationId !== operation.id || frozen.candidateRevision !== candidate.revision || frozen.candidateDigest !== candidate.identityDigest
      || frozen.operationExecutionRevision !== operation.operationExecutionRevision || frozen.controllerEpoch !== controllerEpoch
      || (candidate.projectId && frozen.projectId !== candidate.projectId) || frozen.route !== route || frozen.minimumAssurance !== minimumAssurance) {
      throw new Error("EXECUTION_POLICY_STALE: existing frozen bootstrap policy does not match the current operation, candidate, route, assurance, and controller epoch.");
    }
    return operation;
  }
  const deliveryPolicy = configuredDeliveryPolicy(config, operation.kind);
  const allowedExternalEffects = deliveryPolicy.allowedExternalEffects;
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const validationPolicy = contract?.verification ?? {};
  const executionLiveness = config.orchestration?.operations?.liveness ?? {};
  const economicConfig = config.orchestration?.operations?.economicEnvelope ?? {};
  let inheritedEconomic: EconomicEnvelopeV1 | undefined;
  if (operation.origin) assertOperationOriginV1(operation.origin);
  if (operation.origin?.kind === "FAILED_OPERATION_RECOVERY") {
    const parent = await loadOperation(root, operation.origin.parentOperationId!);
    if (parent.status !== "FAILED" || parent.revision !== operation.origin.parentTerminalRevision || !parent.resolvedOperationPolicy) throw new Error("OPERATION_RECOVERY_PARENT_STALE: the failed parent revision or frozen policy changed.");
    if (parent.ownerEconomicBoundary || parent.ownerContinuationBoundary) throw new Error("OPERATION_RECOVERY_OWNER_BOUNDARY: linked recovery cannot continue through a hard Owner boundary.");
    const parentPolicy = parent.resolvedOperationPolicy;
    const parentUsage = await collectOperationEconomicUsageV1(root, parent);
    if (parentUsage.digest !== operation.origin.inheritedEconomicUsageDigest) throw new Error("OPERATION_RECOVERY_USAGE_STALE: parent economic-usage evidence changed after the recovery continuation was authorized.");
    const expectedAuthorityDigest = sha256Canonical({ parentPolicyDigest: parentPolicy.digest, allowedExternalEffects: parentPolicy.allowedExternalEffects, parentOriginDigest: parent.origin?.digest ?? null, inheritedEconomicUsageDigest: parentUsage.digest });
    if (expectedAuthorityDigest !== operation.origin.inheritedAuthorityDigest) throw new Error("OPERATION_RECOVERY_AUTHORITY_STALE: inherited Owner delegation no longer matches the failed parent.");
    if (minimumAssuranceRank(minimumAssurance) < minimumAssuranceRank(parentPolicy.minimumAssurance)) throw new Error("OPERATION_RECOVERY_ASSURANCE_DOWNGRADE: recovery cannot lower the parent operation assurance.");
    inheritedEconomic = remainingEconomicEnvelopeForRecoveryV1(parentPolicy.economicEnvelope, parentUsage);
  }
  const hardDeadlineMs = executionLiveness.hardDeadlineMs ?? 8 * 60 * 60_000;
  const hardDeadlineAt = operation.origin?.rootHardDeadlineAt ?? new Date(Date.parse(operation.createdAt) + hardDeadlineMs).toISOString();
  const economicEnvelope = inheritedEconomic ? { ...economicConfig, ...inheritedEconomic, hardDeadlineAt } : { ...economicConfig, hardDeadlineAt };
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? config.project.name,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    intent: operation.intent?.request ?? contract?.routing?.intent ?? `${operation.kind} operation ${operation.id}`,
    route,
    minimumAssurance,
    policyVersions: { resolvedOperationPolicy: "2", roleInvocationPolicy: "1", executionBlueprint: "3", executionBinding: "3", skillManifest: "1", capabilityRegistry: "1", operationalSkillProjection: "1" },
    policyDigests: {
      validation: sha256Canonical(validationPolicy),
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical([]),
      context: sha256Canonical(config.context ?? null),
      executionLiveness: sha256Canonical(executionLiveness),
      economicEnvelope: sha256Canonical(economicEnvelope)
    },
    validationPolicy,
    reviewPolicy: {
      minimumAssurance,
      independentReviewRequired: minimumAssurance === "ELEVATED" || minimumAssurance === "CRITICAL",
      leadAcceptance: config.workflow?.reviews?.leadAcceptance !== false,
      leadAcceptanceDirect: config.workflow?.reviews?.leadAcceptanceDirect === true
    },
    deliveryPolicy,
    knowledgePolicy: { bootstrap: true },
    contextPolicy: config.context ?? { mode: "disabled" },
    allowedExternalEffects,
    humanDecisionRequirements,
    executionLiveness,
    economicEnvelope
  });
  if (operation.origin?.kind === "FAILED_OPERATION_RECOVERY") {
    const parent = await loadOperation(root, operation.origin.parentOperationId!);
    const extraEffects = policy.allowedExternalEffects.filter((effect) => !parent.resolvedOperationPolicy!.allowedExternalEffects.includes(effect));
    if (extraEffects.length) throw new Error(`OPERATION_RECOVERY_EXTERNAL_EFFECT_WIDENING: recovery adds owner-reserved effects ${extraEffects.join(", ")}.`);
  }
  return bindResolvedOperationPolicy(root, operation.id, policy);
}

function minimumAssuranceRank(value: AssuranceLevel): number { return value === "NONE" ? 0 : value === "STANDARD" ? 1 : value === "ELEVATED" ? 2 : 3; }
