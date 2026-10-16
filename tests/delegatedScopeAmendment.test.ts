import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  REPAIR_SCOPE_DENY_CHOICE_ID,
  applyRepairScopeAmendment,
  assertRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  mintOwnerHardProtectionExemptionFromProductChoice,
  resolveRepairScopeBlockerViaProductChoice,
  writeRepairScopeBlockerReceipt,
} from "../src/candidates/repairScope.js";
import { recordControlCenterDecision } from "../src/control-center/decision.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  issueDelegatedOwnerGrantV1,
  resolveDelegationProjectScope,
  revokeDelegatedOwnerGrantV1,
} from "../src/security/ownerAuthority.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const TEST_CTX = { via: "test" as const, allowManagedContext: true };
const GRANTOR = "human:scope-owner-test";
const DELEGATE = "delegate:scope-agent";

/**
 * D1 repro: decision.ts ACCEPTS delegate:* actors with a verified
 * FULL_PROJECT_OWNER grant (decision.resolve at record time), but the
 * downstream scope-amendment gates reject them. Every test below asserts the
 * DESIRED end state: a delegate approval with valid grant + delegatedFrom
 * provenance authorizes exactly like a human approval. They FAIL on the
 * current gates (REPAIR_SCOPE_DECISION_ACTOR_INVALID /
 * OWNER_EXEMPTION_NOT_HUMAN / PARTICIPANT_PLAN_INVALID on the artifact
 * assert) and PASS after the fix. Fail-closed paths (deny, revoked, expired,
 * unknown, cross-project) must reject with delegation-specific codes.
 */
describe("delegated Owner scope amendments (D1)", () => {
  it("regular (non-hard) amendment apply accepts a delegated Owner approval with provenance", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-APPLY-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-blocker",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" }],
    });
    const grant = await issueScopeGrant(root);
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-apply-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate approves exact lockfile set",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);

    const amended = await applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId },
      ledger,
    });
    expect(amended.status).toBe("AMENDED");
    if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(amended.amendment.decidedBy).toBe("human");
    expect(amended.amendment.decidedActor).toBe(DELEGATE);
    expect(amended.amendment.delegatedFrom).toMatchObject({
      grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER",
    });
    expect(() => assertRepairScopeAmendment(amended.amendment)).not.toThrow();
  });

  it("presented-decision mutation cannot inject artifact metadata: stored ledger truth wins", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-MUTATED-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-mutated",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" }],
    });
    const grant = await issueScopeGrant(root);
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-mutated-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "ledger truth reason",
    }, requestId);
    const stored = await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    expect(stored).toBeTruthy();

    // Present a tampered copy (mutated reason): the amendment must still
    // carry the STORED reason/timestamp/id, with a self-consistent digest.
    const tampered = { ...decision, reason: "forged presentation reason" };
    const amended = await applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision: tampered, binding, requestId },
      ledger,
    });
    expect(amended.status).toBe("AMENDED");
    if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(amended.amendment.decisionReason).toBe("ledger truth reason");
    expect(amended.amendment.decidedAt).toBe(stored!.createdAt);
    expect(amended.amendment.decisionId).toBe(stored!.decisionId);
    expect(amended.amendment.decidedActor).toBe(DELEGATE);
    expect(() => assertRepairScopeAmendment(amended.amendment)).not.toThrow();
  });

  it("hard-path mint accepts a delegated Owner approval and preserves provenance in the grant", async () => {
    const root = await createRepo();
    const operationId = "OP-DELEGATE-MINT-1";
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const live = await loadOperation(root, operationId);
    const binding = bindingForCurrentOperation(live);
    const grant = await issueScopeGrant(root);
    const ledger = testLedger(root);
    const requestId = "request:delegate-mint-1";
    const specPath = "specs/changes/DELEGATE-SCOPE/spec.md";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate approves exact hard set",
    }, requestId);
    const stored = await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    expect(stored).toBeTruthy();

    // Present a tampered copy: the grant must anchor the STORED reason and
    // digest, so the anchored grant verifies against the ledger decision.
    const tampered = { ...decision, reason: "forged mint reason" };
    const minted = await mintOwnerHardProtectionExemptionFromProductChoice({
      root, operationId, paths: [specPath], decision: tampered, binding, requestId,
    });
    expect(minted.decidedActor).toBe(DELEGATE);
    expect(minted.delegatedFrom).toMatchObject({
      grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER",
    });
    expect(minted.decisionReason).toBe("delegate approves exact hard set");
    expect(minted.decisionDigest).toBe(sha256Canonical(stored!));
  });

  it("amendment artifact assert accepts delegate provenance and rejects provenance-stripped delegates", async () => {
    const root = await createRepo();
    const amendmentPath = path.join(root, ".harness", "seals", "DELEGATE-SCOPE-scope-amendment-1.json");
    const grant = await issueScopeGrant(root);
    const body = {
      version: 1 as const,
      mechanism: "DETERMINISTIC" as const,
      operationId: "OP-DELEGATE-ARTIFACT-1",
      taskId: "DELEGATE-SCOPE",
      blockerDigest: "a".repeat(64),
      exemptedPaths: ["package-lock.json"],
      decidedBy: "human" as const,
      decisionReason: "delegate approves exact lockfile set",
      decidedAt: "2026-01-01T00:00:00.000Z",
      decisionId: "decision:12345678-1234-1234-1234-123456789012",
      requestId: "request:delegate-artifact-1",
      decidedActor: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" as const },
      amendedScope: ["package-lock.json", "src/**"],
      contractPath: ".harness/contracts/DELEGATE-SCOPE.yaml",
      sealPath: ".harness/seals/DELEGATE-SCOPE.json",
      amendmentPath: path.relative(root, amendmentPath).replaceAll("\\", "/"),
    };
    // Desired: a delegate amendment carrying valid provenance validates.
    expect(() => assertRepairScopeAmendment({ ...body, amendmentDigest: sha256Canonical(body) })).not.toThrow();
    // Fail-closed: a delegate actor WITHOUT provenance never validates.
    const { delegatedFrom: _stripped, ...strippedBody } = body;
    void _stripped;
    expect(() => assertRepairScopeAmendment({ ...strippedBody, amendmentDigest: sha256Canonical(strippedBody) }))
      .toThrow(/delegatedFrom|provenance|delegate/i);
  });

  it("regular suspend/decide/resume end-to-end: delegate product choice amends via the Control Center path", async () => {
    const root = await createRepo();
    const operationId = "OP-DELEGATE-E2E-1";
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-e2e",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy-mandated transitive bump requires lockfile update" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const grant = await issueScopeGrant(root);
    const ledger = testLedger(root);

    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    const approve = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const current = await loadOperation(root, operationId);
        if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
          await recordControlCenterDecision(root, ledger, {
            operationId, requestId: current.decisionRequest.requestId,
            choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "delegate approves exact lockfile set",
          }, DELEGATE, grant.delegationId);
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("suspension never appeared for delegate e2e");
    })();
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.amendment.decidedActor).toBe(DELEGATE);
    expect(resolved.amendment.delegatedFrom).toMatchObject({ delegationId: grant.delegationId });
  }, 30000);

  it("hard suspend/decide/resume end-to-end: delegate product choice mints a delegated grant and amends", async () => {
    const root = await createRepo();
    const operationId = "OP-DELEGATE-E2E-HARD-1";
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/DELEGATE-SCOPE/spec.md";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-e2e-hard",
      filesNeededOutsideScope: [{ path: specPath, reason: "spec must be regenerated" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const grant = await issueScopeGrant(root);
    const ledger = testLedger(root);

    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    const approve = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const current = await loadOperation(root, operationId);
        if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
          await recordControlCenterDecision(root, ledger, {
            operationId, requestId: current.decisionRequest.requestId,
            choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "delegate approves exact hard set",
          }, DELEGATE, grant.delegationId);
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("suspension never appeared for delegate hard e2e");
    })();
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.amendment.decidedActor).toBe(DELEGATE);
    expect(resolved.amendment.ownerExemption?.exemptionId).toMatch(/^exemption:/);
    const after = await loadOperation(root, operationId);
    const anchored = after.ownerExemptions?.[resolved.amendment.ownerExemption!.exemptionId];
    expect(anchored?.decidedActor).toBe(DELEGATE);
    expect(anchored?.delegatedFrom).toMatchObject({ delegationId: grant.delegationId });
  }, 30000);

  it("delegate deny choice still returns BLOCKED (no amendment, no bypass)", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-DENY-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-deny",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    const grant = await issueScopeGrant(root);
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-deny-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_DENY_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate refuses lockfile churn",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);

    const denied = await applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId },
      ledger,
    });
    expect(denied.status).toBe("BLOCKED");
  });

  it("revoked grant fails closed at apply time (re-verified at USE, not just at record)", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-REVOKED-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-revoked",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    const grant = await issueScopeGrant(root);
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-revoked-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate approves before revocation",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR }, TEST_CTX);

    await expect(applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId },
      ledger,
    })).rejects.toThrow(/DELEGATION_REVOKED/);
  });

  it("expired grant fails closed at hard-path mint time", async () => {
    const root = await createRepo();
    const operationId = "OP-DELEGATE-EXPIRED-1";
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const live = await loadOperation(root, operationId);
    const binding = bindingForCurrentOperation(live);
    const scope = await resolveDelegationProjectScope(root);
    const shortGrant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: scope.projectId,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    }, TEST_CTX);
    const ledger = testLedger(root);
    const requestId = "request:delegate-expired-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: shortGrant.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "delegate approves before expiry",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await new Promise((r) => setTimeout(r, 1200));

    await expect(mintOwnerHardProtectionExemptionFromProductChoice({
      root, operationId, paths: ["specs/changes/DELEGATE-SCOPE/spec.md"], decision, binding, requestId,
    })).rejects.toThrow(/DELEGATION_EXPIRED/);
  }, 30000);

  it("worker without a grant cannot approve (unknown delegation fails closed at apply)", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-IMPOSTOR-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-impostor",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-impostor-1";
    // The ledger layer records self-declared provenance; authority is decided
    // at USE time, where the unknown grant must fail closed.
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: "delegate:impostor",
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: "delegation:12345678-1234-1234-1234-123456789012", profile: "FULL_PROJECT_OWNER" },
      reason: "impostor self-approval",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);

    await expect(applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId },
      ledger,
    })).rejects.toThrow(/DELEGATION_UNKNOWN/);
  });

  it("cross-project grant is rejected at apply (no cross-project authority)", async () => {
    const root = await createRepo();
    const task = contract("DELEGATE-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const operationId = "OP-DELEGATE-XPROJ-1";
    const blocker = createRepairScopeBlockerReceipt({
      operationId,
      taskId: task.task.id,
      workUnitId: "validation-repair:delegate-xproj",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    const foreign = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: "foreign-project",
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const binding = syntheticBinding(operationId);
    const ledger = await tempLedger();
    const requestId = "request:delegate-xproj-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE",
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: foreign.delegationId, profile: "FULL_PROJECT_OWNER" },
      reason: "cross-project approval attempt",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);

    await expect(applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId },
      ledger,
    })).rejects.toThrow(/DELEGATION_PROJECT_MISMATCH/);
  });
});

async function issueScopeGrant(root: string) {
  const scope = await resolveDelegationProjectScope(root);
  return issueDelegatedOwnerGrantV1(root, {
    grantorOwnerId: GRANTOR,
    delegatePrincipalId: DELEGATE,
    projectId: scope.projectId,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  }, TEST_CTX);
}

async function tempLedger(): Promise<HumanDecisionLedgerV2> {
  const resolved = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-delegate-ledger-"));
  roots.push(resolved);
  return new HumanDecisionLedgerV2(resolved);
}

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-delegate-scope-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

async function writeContractAndSeal(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const { default: YAML } = await import("yaml");
  const dir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  const { sealTask } = await import("../src/core/seal.js");
  await fs.mkdir(path.join(root, "specs", "changes", task.task.id), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "proposal.md"), "# proposal\n");
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "spec.md"), "# spec\n");
  await sealTask(root, config, task);
}

function syntheticBinding(operationId: string) {
  return {
    operationId,
    candidate: createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r1`, revision: 1, sourceDigest: "a".repeat(64) }),
    operationExecutionRevision: 1,
    policyDigest: "b".repeat(64),
    controllerEpoch: 0,
  };
}

function bindingForCurrentOperation(current: Awaited<ReturnType<typeof loadOperation>>) {
  return {
    operationId: current.id,
    candidate: current.candidateRevision!,
    operationExecutionRevision: current.operationExecutionRevision!,
    policyDigest: current.resolvedOperationPolicy!.digest,
    controllerEpoch: currentControllerEpoch(current),
  };
}

async function bindPolicyForCurrentIdentity(root: string, operationId: string) {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "delegated scope amendment test policy",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "delegate-scope-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(taskId: string): TaskContract {
  return {
    version: 1,
    task: { id: taskId, title: `Repair ${taskId}` },
    source: { proposal: `specs/changes/${taskId}/proposal.md`, spec: `specs/changes/${taskId}/spec.md` },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}

function bindEnv(operationId: string, root: string): void {
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROL_ROOT = root;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
