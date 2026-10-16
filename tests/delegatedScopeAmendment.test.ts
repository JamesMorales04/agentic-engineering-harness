import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  applyRepairScopeAmendment,
  assertDelegatedAmendmentAuthorityV1,
  assertRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairScope.js";
import { recordControlCenterDecision } from "../src/control-center/decision.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { sealTask } from "../src/core/seal.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  issueDelegatedOwnerGrantV1,
  revokeDelegatedOwnerGrantV1,
} from "../src/security/ownerAuthority.js";
import { resolveRepairScopeBlockerViaProductChoice } from "../src/candidates/repairScope.js";
import { runShell } from "../src/utils/process.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { deriveDirectRetryExemptionsV1 } from "../src/core/run.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
  token: process.env.AEH_CONTROLLER_TOKEN,
  epoch: process.env.AEH_CONTROLLER_EPOCH,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_CONTROLLER_TOKEN", originalEnv.token);
  restoreEnv("AEH_CONTROLLER_EPOCH", originalEnv.epoch);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const GRANTOR = "human:control-center:test-delegate";
const DELEGATE = "delegate:l5-test-agent";
const PROJECT = "delegated-amend-test";
const TEST_CTX = { via: "test" as const, allowManagedContext: true };
const NEW_TEST = "tests/new-delegated.test.ts";
const HARD_SPEC = "specs/changes/DELEGATED-HARD/spec.md";

describe("DELEGATED_OWNER scope-amendment authority", () => {
  it("positive: delegate approves a new-test-tier amendment end to end (recorded as DELEGATED_OWNER, never HUMAN_OWNER)", async () => {
    const { root, task, config } = await fixture("DELEGATED-AMEND-1");
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      capabilities: ["scope.amend", "decision.resolve"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const blocker = await writtenBlocker(root, "DELEGATED-AMEND-1", task.task.id, [NEW_TEST]);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId: "DELEGATED-AMEND-1", config, contract: task, blocker,
    });
    const approve = approveWaitingRequest(root, "DELEGATED-AMEND-1", grant.delegationId, "delegate approves exact new-test set");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.contract.scope?.allowed).toContain(NEW_TEST);
    expect(resolved.amendment.decidedBy).toBe("delegated");
    expect(resolved.amendment.decidedActor).toBe(DELEGATE);
    expect(resolved.amendment.delegatedFrom).toMatchObject({
      grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER",
    });
    expect(resolved.amendment.ownerExemption).toBeUndefined();
    // The durable artifact validates, and the retry derivation projects
    // exactly the amended file as the assembler carve-out.
    expect(() => assertRepairScopeAmendment(resolved.amendment)).not.toThrow();
    const operation = await loadOperation(root, "DELEGATED-AMEND-1");
    const exemptions = await deriveDirectRetryExemptionsV1({ stateRoot: root, operation, amendment: resolved.amendment });
    expect(exemptions).toEqual([NEW_TEST]);
  });

  it("positive: delegate approves a hard path (grant minted, honored, recorded as DELEGATED_OWNER)", async () => {
    const { root, task, config } = await fixture("DELEGATED-HARD-1", HARD_SPEC);
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      capabilities: ["scope.amend", "decision.resolve"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const blocker = await writtenBlocker(root, "DELEGATED-HARD-1", task.task.id, [HARD_SPEC]);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId: "DELEGATED-HARD-1", config, contract: task, blocker,
    });
    const approve = approveWaitingRequest(root, "DELEGATED-HARD-1", grant.delegationId, "delegate approves exact hard set");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED" || !resolved.ownerExemption) throw new Error("expected AMENDED with grant");
    expect(resolved.amendment.decidedBy).toBe("delegated");
    expect(resolved.amendment.decidedActor).toBe(DELEGATE);
    expect(resolved.amendment.delegatedFrom?.delegationId).toBe(grant.delegationId);
    const anchored = (await loadOperation(root, "DELEGATED-HARD-1")).ownerExemptions?.[resolved.ownerExemption.exemptionId];
    expect(anchored?.decidedActor).toBe(DELEGATE);
    expect(() => assertRepairScopeAmendment(resolved.amendment)).not.toThrow();
    // The anchored grant honors on the live operation (MAC, lineage, expiry).
    const ledger = testLedger(root);
    const operation = await loadOperation(root, "DELEGATED-HARD-1");
    const honored = await verifyOwnerHardProtectionExemption({
      operation, neededPaths: [HARD_SPEC], grant: anchored!, ledger,
    });
    expect(honored.decidedActor).toBe(DELEGATE);
  });

  it("adversarial: revoked grant fails closed at apply time (recorded while live, revoked before apply)", async () => {
    const { root } = await fixture("DELEGATED-REVOKE-1");
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      capabilities: ["scope.amend", "decision.resolve"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const decision = {
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    await revokeDelegatedOwnerGrantV1(root, grant.delegationId, { revokedBy: GRANTOR }, TEST_CTX);
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision })).rejects.toThrow(/REVOKED/);
  });

  it("adversarial: expired grant fails closed", async () => {
    const { root } = await fixture("DELEGATED-EXPIRED-1");
    const live = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      capabilities: ["scope.amend", "decision.resolve"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const liveDecision = {
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: live.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    // Expire via a short-lived grant, then wait it out.
    const short = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: "delegate:short-lived", projectId: PROJECT,
      capabilities: ["scope.amend"],
      expiresAt: new Date(Date.now() + 50).toISOString(),
    }, TEST_CTX);
    await new Promise((r) => setTimeout(r, 80));
    const expiredDecision = {
      actorId: "delegate:short-lived",
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: short.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision: expiredDecision })).rejects.toThrow(/EXPIRED/);
    // The live grant still verifies (control: the check is about expiry).
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision: liveDecision })).resolves.toMatchObject({ kind: "DELEGATED_OWNER" });
  });

  it("adversarial: grant without scope.amend is denied (decision.resolve alone authorizes recording, never amending)", async () => {
    const { root } = await fixture("DELEGATED-NOCAP-1");
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: PROJECT,
      capabilities: ["decision.resolve"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const decision = {
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision })).rejects.toThrow(/CAPABILITY_DENIED/);
  });

  it("adversarial: delegate without provenance is refused (never attributed, never authorized)", async () => {
    const { root } = await fixture("DELEGATED-NOPROV-1");
    const decision = { actorId: DELEGATE } as never;
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision })).rejects.toThrow(/provenance/i);
  });

  it("adversarial: cross-project grant is refused", async () => {
    const { root } = await fixture("DELEGATED-XPROJ-1");
    const grant = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: DELEGATE, projectId: "some-other-project",
      capabilities: ["scope.amend"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const decision = {
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: grant.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision })).rejects.toThrow(/PROJECT_MISMATCH/);
  });

  it("adversarial: provenance naming another principal is refused (principal mismatch)", async () => {
    const { root } = await fixture("DELEGATED-MISMATCH-1");
    const other = await issueDelegatedOwnerGrantV1(root, {
      grantorOwnerId: GRANTOR, delegatePrincipalId: "delegate:someone-else", projectId: PROJECT,
      capabilities: ["scope.amend"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, TEST_CTX);
    const decision = {
      actorId: DELEGATE,
      delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: other.delegationId, profile: "FULL_PROJECT_OWNER" as const },
    } as never;
    await expect(assertDelegatedAmendmentAuthorityV1({ root, decision })).rejects.toThrow(/PRINCIPAL_MISMATCH/);
  });

  it("adversarial: artifact cross-contamination is rejected both directions", () => {
    const delegatedAsHuman = {
      version: 1, mechanism: "DETERMINISTIC", operationId: "OP", taskId: "T",
      blockerDigest: "d", exemptedPaths: [NEW_TEST], decidedBy: "human",
      decisionReason: "r", decidedAt: new Date().toISOString(),
      decisionId: "decision:00000000-0000-4000-8000-000000000001", requestId: "request:1",
      decidedActor: DELEGATE, delegatedFrom: { grantorOwnerId: GRANTOR, delegationId: "delegation:00000000-0000-4000-8000-000000000002", profile: "FULL_PROJECT_OWNER" },
      amendedScope: [], contractPath: "c", sealPath: "s", amendmentPath: "a",
      amendmentDigest: "a".repeat(64),
    };
    // Human-labeled artifact carrying delegated provenance: rejected
    // (actor check fires first for the delegate actor; either rejection
    // is fail-closed correct).
    expect(() => assertRepairScopeAmendment(delegatedAsHuman)).toThrow(
      /must be the ledger human authority|must not carry delegated provenance/,
    );
    const humanAsDelegated = { ...delegatedAsHuman, decidedBy: "delegated", delegatedFrom: undefined, decidedActor: GRANTOR };
    // Delegated-labeled artifact with a human actor: rejected.
    expect(() => assertRepairScopeAmendment(humanAsDelegated)).toThrow(/must be the approving delegate principal/);
    const missingProvenance = { ...delegatedAsHuman, decidedBy: "delegated", decidedActor: DELEGATE, delegatedFrom: undefined };
    // Delegated label without provenance: rejected.
    expect(() => assertRepairScopeAmendment(missingProvenance)).toThrow(/provenance/);
  });

  it("human path unchanged: human approvals still validate and apply without provenance", async () => {
    const { root, task, config } = await fixture("HUMAN-UNCHANGED-1");
    const blocker = await writtenBlocker(root, "HUMAN-UNCHANGED-1", task.task.id, [NEW_TEST]);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId: "HUMAN-UNCHANGED-1", config, contract: task, blocker,
    });
    const approve = approveWaitingRequestHuman(root, "HUMAN-UNCHANGED-1", "human approves exact new-test set");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.amendment.decidedBy).toBe("human");
    expect(resolved.amendment.decidedActor).toBe("human:control-center:test-delegate");
    expect(resolved.amendment.delegatedFrom).toBeUndefined();
    expect(() => assertRepairScopeAmendment(resolved.amendment)).not.toThrow();
  });
});

async function approveWaitingRequest(root: string, operationId: string, delegationId: string, reason: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { loadOperation } = await import("../src/operations/state.js");
    const current = await loadOperation(root, operationId);
    if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
      await recordControlCenterDecision(root, testLedger(root), {
        operationId, requestId: current.decisionRequest.requestId, choiceId: "approve-exact-paths", reason,
      }, DELEGATE, delegationId);
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("suspension never appeared for delegated blocker");
}

async function approveWaitingRequestHuman(root: string, operationId: string, reason: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { loadOperation } = await import("../src/operations/state.js");
    const current = await loadOperation(root, operationId);
    if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
      await recordControlCenterDecision(root, testLedger(root), {
        operationId, requestId: current.decisionRequest.requestId, choiceId: "approve-exact-paths", reason,
      }, "human:control-center:test-delegate");
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("suspension never appeared for human blocker");
}

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

async function writtenBlocker(root: string, operationId: string, taskId: string, paths: string[]) {
  const { writeRepairScopeBlockerReceipt, assertRepairScopeBlockerReceipt } = await import("../src/candidates/repairScope.js");
  const blocker = createRepairScopeBlockerReceipt({
    operationId, taskId, workUnitId: `direct:${taskId}`,
    filesNeededOutsideScope: paths.map((p) => ({ path: p, reason: "needed for acceptance" })),
  });
  const receiptFile = await writeRepairScopeBlockerReceipt(root, projectConfig(), blocker);
  const persisted: unknown = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  assertRepairScopeBlockerReceipt(persisted);
  if ((persisted as { digest: string }).digest !== blocker.digest) throw new Error("receipt digest mismatch");
  return blocker;
}

async function fixture(operationId: string, extraFile?: string): Promise<{ root: string; task: TaskContract; config: HarnessProjectConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-delegated-amend-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
  await fs.mkdir(path.join(root, ".harness", "security"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), `version: 1\nproject:\n  name: ${PROJECT}\n`);
  if (extraFile) {
    await fs.mkdir(path.join(root, path.dirname(extraFile)), { recursive: true });
    await fs.writeFile(path.join(root, extraFile), "hard content\n");
  }
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  const task = taskContract(operationId);
  const config = projectConfig();
  await fs.writeFile(path.join(root, ".harness", "contracts", `${task.task.id}.yaml`), YAML.stringify(task));
  await writeContractAndSeal(root, config, task);
  const now = "2026-01-01T00:00:00.000Z";
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now } as never);
  await bindPolicyForCurrentIdentity(root, operationId);
  return { root, task, config };
}

async function writeContractAndSeal(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const dir = path.join(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  await sealTask(root, config, task);
}

async function bindPolicyForCurrentIdentity(root: string, operationId: string) {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? PROJECT,
    operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "delegated amendment test policy",
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
  const { bindResolvedOperationPolicy } = await import("../src/operations/state.js");
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

function taskContract(operationId: string): TaskContract {
  return {
    version: 1,
    task: { id: operationId, title: "Delegated amendment" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { intent: "implement", profile: "test", route: "DIRECT", assurance: "STANDARD" },
    repair: { maxAttempts: 2 },
  };
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: PROJECT },
    agents: { configPath: ".harness/agents.source.jsonc", activeProfile: "test", required: true },
    sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    orchestration: { worker: { maxRepairAttempts: 2 } },
    controlPlane: { required: false },
    telemetry: { enabled: false },
  } as HarnessProjectConfig;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
