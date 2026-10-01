import { compileResolvedOperationPolicy, assertResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import { sha256Canonical } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { configuredExternalEffects, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import { bindResolvedOperationPolicy, currentControllerEpoch, type OperationRecordV2 } from "./state.js";

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
    assertResolvedOperationPolicyV1(frozen);
    if (frozen.operationId !== operation.id || frozen.candidateRevision !== candidate.revision || frozen.candidateDigest !== candidate.identityDigest
      || frozen.operationExecutionRevision !== operation.operationExecutionRevision || frozen.controllerEpoch !== controllerEpoch
      || (candidate.projectId && frozen.projectId !== candidate.projectId) || frozen.route !== route || frozen.minimumAssurance !== minimumAssurance) {
      throw new Error("EXECUTION_POLICY_STALE: existing frozen bootstrap policy does not match the current operation, candidate, route, assurance, and controller epoch.");
    }
    return operation;
  }
  const allowedExternalEffects = configuredExternalEffects(config, operation.kind);
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const validationPolicy = contract?.verification ?? {};
  const deliveryPolicy = {
    githubEnabled: config.delivery?.github?.enabled === true,
    paseoEnabled: config.delivery?.paseo?.enabled === true,
    allowedExternalEffects
  };
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
    policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
    policyDigests: {
      validation: sha256Canonical(validationPolicy),
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical([]),
      context: sha256Canonical(config.context ?? null)
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
    humanDecisionRequirements
  });
  return bindResolvedOperationPolicy(root, operation.id, policy);
}
