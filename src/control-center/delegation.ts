import { HumanDecisionLedgerV2 } from "../security/humanDecision.js";
import {
  isDelegatedOwnerActor,
  isHumanOwnerActor,
  issueDelegatedOwnerGrantV1,
  listDelegatedOwnerGrantsV1,
  revokeDelegatedOwnerGrantV1,
  verifyDelegatedOwnerGrantV1,
  type DelegationStatusV1,
} from "../security/ownerAuthority.js";
import type { ControlCenterActionResultV1 } from "./contracts.js";

export interface DelegationGrantRequestV1 {
  delegatePrincipalId: string;
  expiresAt?: string;
  ttlDays?: number;
  repository?: string;
  capabilities?: Array<
    | "operation.initiate" | "scope.amend" | "decision.resolve" | "charter.authorize"
    | "test.acceptance-modify" | "policy.change" | "continuation.economic" | "recovery.authorize"
    | "result.accept" | "delivery.authorize" | "pr.create" | "merge.automatic"
    | "experiment.restart" | "repair.continue"
  >;
  reason?: string;
}

/**
 * Grant a FULL_PROJECT_OWNER delegation through a paired Control Center
 * session. The session actor MUST be the authenticated human grantor — the
 * grant records that actor, never a self-reported string from the body.
 */
export async function grantDelegationForSession(
  root: string,
  projectId: string,
  sessionActorId: string,
  body: DelegationGrantRequestV1,
): Promise<{ delegationId: string; delegatePrincipalId: string; grantorOwnerId: string; expiresAt: string }> {
  if (!isHumanOwnerActor(sessionActorId)) {
    throw new Error("DELEGATION_ISSUANCE_DENIED: only an authenticated human Owner session may grant delegations.");
  }
  const delegatePrincipalId = (body.delegatePrincipalId ?? "").trim();
  if (!isDelegatedOwnerActor(delegatePrincipalId)) throw new Error("DELEGATION_ISSUANCE_DENIED: delegate principal must use the 'delegate:*' namespace.");
  const ttlDays = body.ttlDays ?? 30;
  if (body.expiresAt === undefined && (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 366)) {
    throw new Error("DELEGATION_ISSUANCE_DENIED: ttlDays must be within (0, 366].");
  }
  const grant = await issueDelegatedOwnerGrantV1(root, {
    grantorOwnerId: sessionActorId,
    delegatePrincipalId,
    projectId,
    ...(body.repository ? { repository: body.repository } : {}),
    expiresAt: body.expiresAt ?? new Date(Date.now() + ttlDays * 24 * 60 * 60_000).toISOString(),
    ...(body.capabilities?.length ? { capabilities: body.capabilities } : {}),
  }, { via: "control-center-paired", pairedActorId: sessionActorId });
  return { delegationId: grant.delegationId, delegatePrincipalId: grant.delegatePrincipalId, grantorOwnerId: grant.grantorOwnerId, expiresAt: grant.expiresAt };
}

export async function listDelegationsForSession(root: string, _sessionActorId: string): Promise<DelegationStatusV1[]> {
  return listDelegatedOwnerGrantsV1(root);
}

/** Revoke immediately. Any authenticated human Owner may revoke; the revoker is recorded. */
export async function revokeDelegationForSession(
  root: string,
  sessionActorId: string,
  delegationId: string,
  reason?: string,
): Promise<ControlCenterActionResultV1> {
  if (!isHumanOwnerActor(sessionActorId)) throw new Error("DELEGATION_REVOKE_DENIED: only an authenticated human Owner session may revoke a delegation.");
  await revokeDelegatedOwnerGrantV1(root, delegationId, { revokedBy: sessionActorId, ...(reason ? { reason } : {}) }, { via: "control-center-paired", pairedActorId: sessionActorId });
  return { accepted: true };
}

export interface DelegateSessionGrantV1 {
  actorId: string;
  delegationId: string;
  grantorOwnerId: string;
  expiresAt: string;
}

/**
 * Mint a delegate Control Center session. The delegationId acts as the
 * bearer credential issued out-of-band to the specific AI agent at grant
 * time; the session actor becomes the bound `delegate:*` principal, so every
 * subsequent decision carries real delegated provenance through the standard
 * decision workflow. Human sessions can never mint these; only a valid,
 * unexpired, unrevoked grant verifies.
 */
export async function verifyDelegateSessionGrant(
  root: string,
  projectId: string,
  delegationId: string,
  delegatePrincipalId: string,
): Promise<DelegateSessionGrantV1> {
  const grant = await verifyDelegatedOwnerGrantV1(root, delegationId.trim(), { projectId });
  if (grant.delegatePrincipalId !== delegatePrincipalId.trim()) {
    throw new Error("DELEGATION_PRINCIPAL_MISMATCH: delegation is bound to another delegated principal.");
  }
  return { actorId: grant.delegatePrincipalId, delegationId: grant.delegationId, grantorOwnerId: grant.grantorOwnerId, expiresAt: grant.expiresAt };
}

/** Recent decisions attributable to a delegation, for Owner review. Delegated decisions stay attributable. */
export async function recentDecisionsForDelegation(
  root: string,
  ledger: HumanDecisionLedgerV2,
  delegationId: string,
  limit = 50,
): Promise<Array<{ decisionId: string; operationId: string; kind: string; purpose: unknown; actorId: string; createdAt: string; reason: string }>> {
  const all = await ledger.list();
  return all
    .filter((decision) => decision.delegatedFrom?.delegationId === delegationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map((decision) => ({
      decisionId: decision.decisionId,
      operationId: decision.operationId,
      kind: decision.kind,
      purpose: decision.purpose,
      actorId: decision.actorId,
      createdAt: decision.createdAt,
      reason: decision.reason,
    }));
}
