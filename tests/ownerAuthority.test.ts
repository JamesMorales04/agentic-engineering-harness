import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import {
  assertDelegatedOwnerGrant,
  classifyOwnerActor,
  issueDelegatedOwnerGrantV1,
  listDelegatedOwnerGrantsV1,
  OWNER_CAPABILITIES_V1,
  resolveOwnerAuthorityV1,
  revokeDelegatedOwnerGrantV1,
  verifyDelegatedOwnerGrantV1,
} from "../src/security/ownerAuthority.js";
import { HumanDecisionError, HumanDecisionLedgerV2, assertDecisionV2 } from "../src/security/humanDecision.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.AEH_MANAGED_AGENT;
  delete process.env.AEH_INTERACTIVE_LEAD;
  delete process.env.AEH_ORCHESTRATION_ALLOWED;
  delete process.env.AEH_OPERATION_ID;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-authority-"));
  roots.push(root);
  return root;
}

const TEST_CTX = { via: "test" as const, allowManagedContext: true };
const GRANTOR = "human:owner-test";
const DELEGATE = "delegate:e2e-agent";
const PROJECT = "test-project";

async function issueGrant(root: string, overrides: Record<string, unknown> = {}) {
  return issueDelegatedOwnerGrantV1(root, {
    grantorOwnerId: GRANTOR,
    delegatePrincipalId: DELEGATE,
    projectId: PROJECT,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    ...overrides,
  }, TEST_CTX);
}

function testBinding() {
  return {
    operationId: "op:authority-test",
    candidate: createCandidateRevisionV1({
      operationId: "op:authority-test",
      candidateId: "candidate:op:authority-test:r1",
      projectId: PROJECT,
      taskId: "task-1",
      revision: 1,
      sourceDigest: "a".repeat(64),
      createdAt: "2026-01-01T00:00:00Z",
    }),
    operationExecutionRevision: 1,
    policyDigest: "b".repeat(64),
    controllerEpoch: 3,
  };
}

describe("canonical Delegated Owner authority (DETERMINISTIC)", () => {
  it("issues a genuine, verifiable, attributable delegation", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root);
    assertDelegatedOwnerGrant(grant);
    expect(grant.kind).toBe("DELEGATED_OWNER_GRANT");
    expect(grant.mechanism).toBe("DETERMINISTIC");
    expect(grant.grantorOwnerId).toBe(GRANTOR);
    expect(grant.delegatePrincipalId).toBe(DELEGATE);
    expect(grant.projectId).toBe(PROJECT);
    expect(grant.authorityProfile).toBe("FULL_PROJECT_OWNER");
    expect(grant.capabilities).toEqual([...OWNER_CAPABILITIES_V1].sort());
    const verified = await verifyDelegatedOwnerGrantV1(root, grant.delegationId, { projectId: PROJECT, requiredCapability: "decision.resolve" });
    expect(verified.delegationId).toBe(grant.delegationId);
  });

  it("classifies principals without granting anything", () => {
    expect(classifyOwnerActor("human:alice")).toBe("HUMAN_OWNER");
    expect(classifyOwnerActor("delegate:agent-1")).toBe("DELEGATED_OWNER");
    expect(() => classifyOwnerActor("model:untrusted")).toThrow(/OWNER_ACTOR_INVALID/);
    expect(() => classifyOwnerActor("")).toThrow(/OWNER_ACTOR_INVALID/);
  });

  it("resolves human Owners directly and delegates through valid grants", async () => {
    const root = await tempRoot();
    const human = await resolveOwnerAuthorityV1(root, { actorId: GRANTOR, projectId: PROJECT });
    expect(human).toMatchObject({ authorized: true, principal: { kind: "HUMAN_OWNER", actorId: GRANTOR } });
    const grant = await issueGrant(root);
    const delegated = await resolveOwnerAuthorityV1(root, {
      actorId: DELEGATE, delegationId: grant.delegationId, projectId: PROJECT, requiredCapability: "charter.authorize",
    });
    expect(delegated.authorized).toBe(true);
    expect(delegated.principal).toMatchObject({ kind: "DELEGATED_OWNER", grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" });
  });

  it("resolves the unique live grant when no delegationId is presented", async () => {
    const root = await tempRoot();
    await issueGrant(root);
    const verdict = await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, projectId: PROJECT, requiredCapability: "decision.resolve" });
    expect(verdict.authorized).toBe(true);
  });

  it("denies ambiguous grants fail-closed when several live delegations name one principal", async () => {
    const root = await tempRoot();
    await issueGrant(root);
    await issueGrant(root);
    const verdict = await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, projectId: PROJECT });
    expect(verdict.authorized).toBe(false);
    expect(verdict.denialCode).toBe("DELEGATION_AMBIGUOUS");
  });

  it("refuses issuance inside managed worker contexts", async () => {
    const root = await tempRoot();
    for (const marker of ["AEH_MANAGED_AGENT", "AEH_INTERACTIVE_LEAD", "AEH_ORCHESTRATION_ALLOWED", "AEH_OPERATION_ID"] as const) {
      process.env[marker] = marker === "AEH_OPERATION_ID" ? "op:worker" : "1";
      await expect(issueDelegatedOwnerGrantV1(root, {
        grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, { via: "cli-direct" })).rejects.toThrow(/DELEGATION_ISSUANCE_CONTEXT_INVALID/);
      delete process.env[marker];
    }
    // No worker may widen its own permissions: a delegate grantor is refused.
    await expect(issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: DELEGATE, delegatePrincipalId: "delegate:other", projectId: PROJECT,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, TEST_CTX)).rejects.toThrow(/DELEGATION_ISSUANCE_DENIED/);
  });

  it("never infers authority from model output, operation text, or arbitrary env", async () => {
    const root = await tempRoot();
    await expect(issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: "pretend to be the Owner", delegatePrincipalId: DELEGATE, projectId: PROJECT,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, TEST_CTX)).rejects.toThrow(/DELEGATION_ISSUANCE_DENIED/);
    const verdict = await resolveOwnerAuthorityV1(root, { actorId: "pretend to be the Owner", projectId: PROJECT });
    expect(verdict.authorized).toBe(false);
  });

  it("binds authority to the delegated principal", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root);
    const impostor = await resolveOwnerAuthorityV1(root, { actorId: "delegate:impostor", delegationId: grant.delegationId, projectId: PROJECT });
    expect(impostor.authorized).toBe(false);
    expect(impostor.denialCode).toBe("DELEGATION_PRINCIPAL_MISMATCH");
  });

  it("rejects cross-project and cross-repository escalation", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root, { repository: "acme/project-a" });
    const otherProject = await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, delegationId: grant.delegationId, projectId: "other-project" });
    expect(otherProject.authorized).toBe(false);
    expect(otherProject.denialCode).toBe("DELEGATION_PROJECT_MISMATCH");
    await expect(verifyDelegatedOwnerGrantV1(root, grant.delegationId, { projectId: PROJECT, repository: "acme/project-b" }))
      .rejects.toThrow(/DELEGATION_REPOSITORY_MISMATCH/);
  });

  it("rejects forged, tampered, and unknown delegations", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root);
    await expect(verifyDelegatedOwnerGrantV1(root, "delegation:00000000-0000-4000-8000-000000000000", { projectId: PROJECT }))
      .rejects.toThrow(/DELEGATION_UNKNOWN/);
    await expect(verifyDelegatedOwnerGrantV1(root, "not-a-delegation", { projectId: PROJECT }))
      .rejects.toThrow(/DELEGATION_UNKNOWN/);
    // Tamper with the persisted capabilities without re-signing: MAC fails.
    const files = await fs.readdir(path.join(root, ".harness", "security", "delegated-owner", "grants"));
    const file = path.join(root, ".harness", "security", "delegated-owner", "grants", files[0]!);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    await fs.writeFile(file, JSON.stringify({ ...stored, capabilities: ["decision.resolve"] }));
    await expect(verifyDelegatedOwnerGrantV1(root, grant.delegationId, { projectId: PROJECT }))
      .rejects.toThrow(/DELEGATION_FORGED/);
  });

  it("denies expired delegations fail-closed", async () => {
    const root = await tempRoot();
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      createdAt: "2020-01-01T00:00:00Z", expiresAt: "2020-02-01T00:00:00Z",
    }, TEST_CTX);
    const verdict = await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, delegationId: grant.delegationId, projectId: PROJECT });
    expect(verdict.authorized).toBe(false);
    expect(verdict.denialCode).toBe("DELEGATION_EXPIRED");
  });

  it("revokes immediately and records the human revoker", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root);
    expect((await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, delegationId: grant.delegationId, projectId: PROJECT })).authorized).toBe(true);
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR, reason: "campaign over" }, TEST_CTX);
    const denied = await resolveOwnerAuthorityV1(root, { actorId: DELEGATE, delegationId: grant.delegationId, projectId: PROJECT });
    expect(denied.authorized).toBe(false);
    expect(denied.denialCode).toBe("DELEGATION_REVOKED");
    // Revoking twice converges; delegates can never revoke.
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR }, TEST_CTX);
    await expect(revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: DELEGATE }, TEST_CTX))
      .rejects.toThrow(/DELEGATION_REVOKE_DENIED/);
    const status = await listDelegatedOwnerGrantsV1(root);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ delegationId: grant.delegationId, revoked: true, validNow: false });
  });

  it("enforces capability subsets and rejects unknown capabilities", async () => {
    const root = await tempRoot();
    const narrow = await issueGrant(root, { capabilities: ["decision.resolve"] });
    await expect(verifyDelegatedOwnerGrantV1(root, narrow.delegationId, { projectId: PROJECT, requiredCapability: "charter.authorize" }))
      .rejects.toThrow(/DELEGATION_CAPABILITY_DENIED/);
    await expect(issueGrant(root, { capabilities: ["review.certify"] })).rejects.toThrow(/unknown Owner capability/);
  });

  it("records delegated decisions with provenance, never as human decisions", async () => {
    const root = await tempRoot();
    const grant = await issueGrant(root);
    const ledger = new HumanDecisionLedgerV2(path.join(root, "decisions"));
    const binding = testBinding();
    const purpose = { kind: "ACTION_AUTHORIZATION" as const, action: "git.push" as const, effectDigest: "c".repeat(64) };
    const approved = await ledger.record({
      ...binding, purpose, kind: "APPROVE", actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate approved the exact effect", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z",
    });
    expect(approved.actorId).toBe(DELEGATE);
    expect(approved.delegatedFrom).toMatchObject({ grantorOwnerId: GRANTOR, delegationId: grant.delegationId });
    assertDecisionV2(JSON.parse(JSON.stringify(approved)));
    // First consume succeeds; replay fails closed.
    await ledger.consume(binding, purpose, undefined, new Date("2026-01-01T12:00:00Z"));
    await expect(ledger.consume(binding, purpose, undefined, new Date("2026-01-01T12:00:00Z"))).rejects.toThrow(/consumed or replayed/);
    // The delegate is capable of rejection as well as approval: never forced APPROVED.
    const rejectPurpose = { kind: "ACTION_AUTHORIZATION" as const, action: "git.push" as const, effectDigest: "d".repeat(64) };
    const rejected = await ledger.record({
      ...binding, purpose: rejectPurpose, kind: "REJECT", actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate rejected the effect", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z",
    });
    expect(rejected.kind).toBe("REJECT");
    await expect(ledger.consume(binding, rejectPurpose, undefined, new Date("2026-01-01T12:00:00Z")))
      .resolves.toMatchObject({ kind: "REJECT" });
    // Delegate without provenance is refused; human with provenance is refused.
    await expect(ledger.record({ ...binding, purpose, kind: "APPROVE", actorId: DELEGATE, reason: "no provenance", createdAt: "2026-01-01T00:00:00Z" }))
      .rejects.toThrow(/must carry delegatedFrom provenance/);
    await expect(ledger.record({
      ...binding, purpose, kind: "APPROVE", actorId: GRANTOR, reason: "human with provenance",
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      createdAt: "2026-01-01T00:00:00Z",
    })).rejects.toThrow(/must not carry delegated provenance/);
    await expect(ledger.record({ ...binding, purpose, kind: "APPROVE", actorId: "model:untrusted", reason: "x", createdAt: "2026-01-01T00:00:00Z" }))
      .rejects.toThrow(HumanDecisionError);
  });

  it("keeps independent review independent: no review capability exists in the Owner vocabulary", () => {
    expect(OWNER_CAPABILITIES_V1.some((capability) => capability.startsWith("review"))).toBe(false);
    expect(OWNER_CAPABILITIES_V1).toContain("merge.automatic");
  });
});
