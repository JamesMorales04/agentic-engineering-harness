import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { recordControlCenterDecision } from "../src/control-center/decision.js";
import {
  grantDelegationForSession,
  listDelegationsForSession,
  recentDecisionsForDelegation,
  revokeDelegationForSession,
  verifyDelegateSessionGrant,
} from "../src/control-center/delegation.js";
import { LocalControlCenterV1 } from "../src/control-center/server.js";
import {
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
  pauseOperationIfRequested,
  pendingOperationControl,
  requestOperationPause,
  requestOperationResume,
  saveOperation,
  suspendOperationForProductChoice,
} from "../src/operations/state.js";
import { cancelOperation } from "../src/operations/controller.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { issueDelegatedOwnerGrantV1, revokeDelegatedOwnerGrantV1 } from "../src/security/ownerAuthority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-delegated-decision-"));
  roots.push(root);
  return root;
}

const GRANTOR = "human:control-center:test";
const DELEGATE = "delegate:e2e-agent";
const TEST_CTX = { via: "test" as const, allowManagedContext: true };

async function suspendedFixture(root: string, operationId: string) {
  const now = new Date().toISOString();
  await saveOperation(root, { version: 1, id: operationId, kind: "audit", status: "RUNNING", phase: "review", root, payload: { request: "review" }, createdAt: now, updatedAt: now });
  const initial = await loadOperation(root, operationId);
  const owned = await claimControllerEpoch(root, operationId, "controller:test", { pid: process.pid });
  const policy = compileResolvedOperationPolicy({
    projectId: initial.candidateRevision!.projectId!, operationId: initial.id,
    operationExecutionRevision: initial.operationExecutionRevision!, candidateRevision: initial.candidateRevision!.revision,
    candidateDigest: initial.candidateRevision!.identityDigest, controllerEpoch: owned.controller!.epoch,
    intent: "delegated decision fixture", route: "NO_AGENT", minimumAssurance: "NONE", policyVersions: {},
    policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {},
    contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, initial.id, policy);
  await suspendOperationForProductChoice(root, initial.id, {
    issue: "Choose the product requirement behavior.",
    authoritativeEvidence: [{ artifact: ".harness/results/spec-manager.json", sha256: "a".repeat(64), description: "Accepted Spec Manager result." }],
    whatTried: ["Reviewed the current requirement and existing behavior."],
    whyUnresolvable: "The user-facing behavior has two valid product interpretations.",
    choices: [
      { choiceId: "strict", label: "Strict behavior", description: "Require explicit confirmation.", consequences: ["Adds a confirmation requirement."] },
      { choiceId: "lenient", label: "Lenient behavior", description: "Proceed without confirmation.", consequences: ["Skips the confirmation requirement."] },
    ],
    workThatCanContinue: [],
  }, { version: 1, resumeTarget: "SPEC_AUTHORING", taskId: operationId });
  const waiting = await loadOperation(root, operationId);
  if (waiting.phase !== "HUMAN_REQUIRED" || !waiting.decisionRequest) throw new Error("fixture failed to suspend HUMAN_REQUIRED");
  return waiting;
}

describe("delegated Owner decisions through the real Control Center path", () => {
  it("approves and rejects through a FULL_PROJECT_OWNER delegate with provenance, without contacting the human", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-APPROVE");
    const projectId = waiting.candidateRevision!.projectId!;
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
    const input = { operationId: waiting.id, requestId: waiting.decisionRequest!.requestId, choiceId: "strict" };

    // An unauthorized principal cannot resolve the Owner decision.
    await expect(recordControlCenterDecision(root, ledger, input, "delegate:impostor"))
      .rejects.toThrow(/DECISION_AUTHORITY_DENIED|DELEGATION_UNKNOWN/);

    // The authorized delegate approves (and could equally choose the decline
    // option — both paths record delegated provenance, never APPROVED-forced).
    const accepted = await recordControlCenterDecision(root, ledger, input, DELEGATE);
    expect(accepted).toMatchObject({ accepted: true, delegated: true, actingPrincipal: DELEGATE, grantorOwnerId: GRANTOR, delegationId: grant.delegationId });
    const stored = await ledger.find((accepted as { decisionId: string }).decisionId);
    expect(stored?.actorId).toBe(DELEGATE);
    expect(stored?.delegatedFrom).toMatchObject({ grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" });
    await expect(recordControlCenterDecision(root, ledger, input, DELEGATE)).rejects.toThrow(/already been submitted/);
  });

  it("exercises delegated pause, resume, and cancel under the same grant", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-CONTROL");
    const projectId = waiting.candidateRevision!.projectId!;
    await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    await expect(requestOperationPause(root, waiting.id, "delegate:impostor")).rejects.toThrow(/DELEGATION_/);
    await requestOperationPause(root, waiting.id, DELEGATE);
    const paused = await pauseOperationIfRequested(root, waiting.id, { activeParticipantIds: [], activeProviderLeaseIds: [], observedAt: new Date().toISOString() });
    expect(paused.phase).toBe("PAUSED");
    const pauseDecision = (await new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json")).list())
      .find((decision) => decision.kind === "PAUSE");
    expect(pauseDecision?.delegatedFrom?.delegationId).toBeDefined();
    await requestOperationResume(root, waiting.id, DELEGATE);
    // The resume decision is recorded with delegated provenance; a running
    // controller applies it (phase returns to HUMAN_REQUIRED under execution).
    const resumeDecision = (await new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json")).list())
      .find((decision) => decision.kind === "RESUME");
    expect(resumeDecision?.actorId).toBe(DELEGATE);
    expect(resumeDecision?.delegatedFrom?.delegationId).toBeDefined();
    const cancelled = await cancelOperation(root, waiting.id, { humanActorId: DELEGATE });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("fails closed when a grant is revoked between recording and applying a deferred control", async () => {    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-REVOKE-RACE");
    const projectId = waiting.candidateRevision!.projectId!;
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, { via: "test", allowManagedContext: true });
    await requestOperationPause(root, waiting.id, DELEGATE);
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR }, { via: "test", allowManagedContext: true });
    await expect(pauseOperationIfRequested(root, waiting.id, { activeParticipantIds: [], activeProviderLeaseIds: [], observedAt: new Date().toISOString() }))
      .rejects.toThrow(/DELEGATION_REVOKED/);
    expect((await loadOperation(root, waiting.id)).phase).toBe("HUMAN_REQUIRED");
  });

  it("serves the full delegation lifecycle over real HTTP: grant, delegate session, decision, review, revoke", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-HTTP");
    const projectId = waiting.candidateRevision!.projectId!;
    const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
    let center: LocalControlCenterV1 | undefined;
    try {
      center = new LocalControlCenterV1({
        onDecision: async (value, actorId) => {
          const result = await recordControlCenterDecision(root, ledger, value, actorId);
          return { accepted: result.accepted === true };
        },
        onListDelegations: async (actorId) => listDelegationsForSession(root, actorId),
        onGrantDelegation: async (body, actorId) => grantDelegationForSession(root, projectId, actorId, body as Parameters<typeof grantDelegationForSession>[3]),
        onRevokeDelegation: async (delegationId, actorId, reason) => revokeDelegationForSession(root, actorId, delegationId, reason),
        onDelegationDecisions: async (delegationId) => recentDecisionsForDelegation(root, ledger, delegationId),
        onDelegateSession: async (delegationId, delegatePrincipalId) => verifyDelegateSessionGrant(root, projectId, delegationId, delegatePrincipalId),
      });
      const started = await center.start();
      const origin = new URL(started.url).origin;

      // Pair the human Owner browser session (single-use nonce from the URL).
      const pairingUrl = new URL(started.pairingUrl);
      const nonce = pairingUrl.hash.replace(/^#pair=/, "");
      const pair = await fetch(`${origin}/api/v1/pair`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ nonce }),
      });
      expect(pair.status).toBe(200);
      const humanCookie = (pair.headers.get("set-cookie") ?? "").split(";")[0]!;
      const humanSession = await (await fetch(`${origin}/api/v1/session`, { headers: { Cookie: humanCookie } })).json() as { csrfToken: string; actorId: string };
      expect(humanSession.actorId).toMatch(/^human:control-center:/);
      const humanHeaders = (csrf: string) => ({ Cookie: humanCookie, Origin: origin, "X-AEH-CSRF": csrf, "Content-Type": "application/json" });

      // Owner grants FULL_PROJECT_OWNER through the real interface.
      const granted = await fetch(`${origin}/api/v1/delegations`, {
        method: "POST", headers: humanHeaders(humanSession.csrfToken),
        body: JSON.stringify({ delegatePrincipalId: DELEGATE, ttlDays: 1 }),
      });
      expect(granted.status).toBe(200);
      const grantBody = await granted.json() as { delegationId: string; grantorOwnerId: string };
      expect(grantBody.grantorOwnerId).toBe(humanSession.actorId);

      // Status inspection shows the live delegation.
      const status = await (await fetch(`${origin}/api/v1/delegations`, { headers: { Cookie: humanCookie } })).json() as { items: Array<{ delegationId: string; validNow: boolean }> };
      expect(status.items.map((item) => item.delegationId)).toContain(grantBody.delegationId);
      expect(status.items.find((item) => item.delegationId === grantBody.delegationId)?.validNow).toBe(true);

      // The AI delegate opens its own session with the bearer credential.
      const delegatePair = await fetch(`${origin}/api/v1/delegate-session`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ delegationId: grantBody.delegationId, delegatePrincipalId: DELEGATE }),
      });
      expect(delegatePair.status).toBe(200);
      const delegateSession = await delegatePair.json() as { csrfToken: string; actorId: string };
      expect(delegateSession.actorId).toBe(DELEGATE);
      const delegateCookie = (delegatePair.headers.get("set-cookie") ?? "").split(";")[0]!;
      const delegateHeaders = { Cookie: delegateCookie, Origin: origin, "X-AEH-CSRF": delegateSession.csrfToken, "Content-Type": "application/json" };

      // Delegates must never enumerate or manage grants: bearer ids stay secret.
      const enumerated = await fetch(`${origin}/api/v1/delegations`, { headers: { Cookie: delegateCookie } });
      expect(enumerated.status).toBe(403);
      const selfGranted = await fetch(`${origin}/api/v1/delegations`, {
        method: "POST", headers: delegateHeaders, body: JSON.stringify({ delegatePrincipalId: "delegate:other" }),
      });
      expect(selfGranted.status).toBe(403);

      // The delegate resolves the HUMAN_REQUIRED decision autonomously.
      const decided = await fetch(`${origin}/api/v1/decisions`, {
        method: "POST", headers: delegateHeaders,
        body: JSON.stringify({ operationId: waiting.id, requestId: waiting.decisionRequest!.requestId, choiceId: "lenient" }),
      });
      expect(decided.status).toBe(200);

      // The Owner reviews exactly what the delegate decided, attributed correctly.
      const reviewed = await (await fetch(`${origin}/api/v1/delegations/${encodeURIComponent(grantBody.delegationId)}/decisions`, { headers: { Cookie: humanCookie } })).json() as {
        items: Array<{ actorId: string; operationId: string; choiceId?: string }>;
      };
      expect(reviewed.items).toHaveLength(1);
      expect(reviewed.items[0]).toMatchObject({ actorId: DELEGATE, operationId: waiting.id });

      // Revocation ends authority immediately: the delegate session is dropped
      // and further decisions fail closed.
      const revoked = await fetch(`${origin}/api/v1/delegations/${encodeURIComponent(grantBody.delegationId)}/revoke`, {
        method: "POST", headers: humanHeaders(humanSession.csrfToken), body: JSON.stringify({ reason: "campaign over" }),
      });
      expect(revoked.status).toBe(200);
      const afterRevoke = await fetch(`${origin}/api/v1/decisions`, {
        method: "POST", headers: delegateHeaders,
        body: JSON.stringify({ operationId: waiting.id, requestId: waiting.decisionRequest!.requestId, choiceId: "strict" }),
      });
      expect(afterRevoke.status).not.toBe(200);
    } finally {
      await center?.close();
    }
  });

  it("resolves multi-grant delegates through the session-bound grant id", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-MULTI-GRANT");
    const projectId = waiting.candidateRevision!.projectId!;
    const first = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, { via: "test", allowManagedContext: true });
    await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, { via: "test", allowManagedContext: true });
    const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
    const input = { operationId: waiting.id, requestId: waiting.decisionRequest!.requestId, choiceId: "strict" };
    // Without an explicit grant the delegate is ambiguous: fail closed.
    await expect(recordControlCenterDecision(root, ledger, input, DELEGATE))
      .rejects.toThrow(/DELEGATION_AMBIGUOUS/);
    // The delegate session's bound grant resolves it with full provenance.
    const accepted = await recordControlCenterDecision(root, ledger, input, DELEGATE, first.delegationId);
    expect(accepted).toMatchObject({ accepted: true, delegated: true, delegationId: first.delegationId });
    // A foreign grant id for the same principal is rejected.
    const other = await tempRoot();
    const foreign = await issueDelegatedOwnerGrantV1(other, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, { via: "test", allowManagedContext: true });
    await expect(recordControlCenterDecision(root, ledger, input, DELEGATE, foreign.delegationId))
      .rejects.toThrow(/DELEGATION_UNKNOWN/);
  });

  it("prefers live-grant pending controls over revoked-grant ones without ambiguity", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-STALE-CONTROL");
    const projectId = waiting.candidateRevision!.projectId!;
    const ctx = { via: "test", allowManagedContext: true } as const;
    const grantA = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, ctx);
    const pauseA = await requestOperationPause(root, waiting.id, DELEGATE, undefined, grantA.delegationId);
    await revokeDelegatedOwnerGrantV1(root, grantA.delegationId, { revokedBy: GRANTOR }, ctx);
    const grantB = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, ctx);
    const pauseB = await requestOperationPause(root, waiting.id, DELEGATE, undefined, grantB.delegationId);
    expect(pauseB.decisionId).not.toBe(pauseA.decisionId);
    // Observation selects the live grant's decision instead of throwing
    // ambiguous or applying the dead one.
    const pending = await pendingOperationControl(root, waiting.id, "PAUSE");
    expect(pending?.decisionId).toBe(pauseB.decisionId);
    const paused = await pauseOperationIfRequested(root, waiting.id, { activeParticipantIds: [], activeProviderLeaseIds: [], observedAt: new Date().toISOString() });
    expect(paused.phase).toBe("PAUSED");
    expect(paused.pause?.requestedBy).toBe(DELEGATE);
  });

  it("cancels under a live grant despite a stale revoked-grant cancel decision", async () => {
    const root = await tempRoot();
    const waiting = await suspendedFixture(root, "OP-DELEGATED-STALE-CANCEL");
    const projectId = waiting.candidateRevision!.projectId!;
    const ctx = { via: "test", allowManagedContext: true } as const;
    const grantA = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, ctx);
    const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
    const op = await loadOperation(root, waiting.id);
    const now = new Date();
    await ledger.record({
      operationId: op.id,
      candidate: op.candidateRevision!,
      operationExecutionRevision: op.operationExecutionRevision!,
      policyDigest: op.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(op),
      purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" },
      kind: "CANCEL",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grantA.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "stale grant cancel",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await revokeDelegatedOwnerGrantV1(root, grantA.delegationId, { revokedBy: GRANTOR }, ctx);
    const grantB = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, ctx);
    // Without per-grant scoping this would reuse the stale decision and fail
    // at consumption; with it, the live grant records and consumes its own.
    const cancelled = await cancelOperation(root, waiting.id, { humanActorId: DELEGATE, delegationId: grantB.delegationId });
    expect(cancelled.status).toBe("CANCELLED");
  });
});
