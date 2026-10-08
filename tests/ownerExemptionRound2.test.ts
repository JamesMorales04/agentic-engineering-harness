import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  bindOperationCandidate,
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  anchorOwnerHardProtectionExemption,
  requestOwnerHardProtectionExemption,
} from "../src/candidates/repairOwnerExemption.js";
import {
  createRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  findCoveringOwnerHardProtectionExemption,
  findRepairHardProtectedViolations,
  repairHardProtectedPaths,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairScope.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  managed: process.env.AEH_MANAGED_AGENT,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_MANAGED_AGENT", originalEnv.managed);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("B1 RED: MAC must bind live identities", () => {
  it("grant MAC body binds candidate revision + identityDigest + policy digest + execution revision", async () => {
    const root = await createRepo();
    const operationId = "B1-MAC-BIND-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    const liveBefore = await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [specPath], reason: "bind identities", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    // Live identities at anchor time must be MAC-bound.
    const live = await loadOperation(root, operationId);
    expect((grant as Record<string, unknown>).candidateRevision).toBe(live.candidateRevision!.revision);
    expect((grant as Record<string, unknown>).candidateIdentityDigest).toBe(live.candidateRevision!.identityDigest);
    expect((grant as Record<string, unknown>).policyDigest).toBe(live.resolvedOperationPolicy!.digest);
    expect((grant as Record<string, unknown>).operationExecutionRevision).toBe(live.operationExecutionRevision);
    expect(liveBefore.candidateRevision!.revision).toBe(live.candidateRevision!.revision);
    void decision;
  });

  it("same-epoch candidate advance invalidates the grant at every honor point", async () => {
    const root = await createRepo();
    const operationId = "B1-STALE-ADVANCE-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [specPath], reason: "stale test", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const before = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: before, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).resolves.toBeDefined();
    const epochBefore = currentControllerEpoch(before);

    // Same-epoch advance: new candidate revision (exec revision +1, policy cleared).
    const current = await loadOperation(root, operationId);
    const base = current.candidateRevision!;
    const advanced = createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r${base.revision + 1}`,
      projectId: base.projectId,
      taskId: base.taskId,
      revision: base.revision + 1,
      parentCandidateId: base.candidateId,
      sourceDigest: base.sourceDigest,
      worktree: root,
    });
    await bindOperationCandidate(root, operationId, advanced);
    const live = await loadOperation(root, operationId);
    expect(currentControllerEpoch(live)).toBe(epochBefore);
    expect(live.candidateRevision!.revision).toBe(base.revision + 1);
    expect(live.operationExecutionRevision).not.toBe(before.operationExecutionRevision);

    // Every honor point must now refuse.
    await expect(
      verifyOwnerHardProtectionExemption({ operation: live, neededPaths: [specPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/BINDING_STALE|STALE|revision|policy|candidate/i);
    const covering = await findCoveringOwnerHardProtectionExemption({
      operation: live, neededPaths: [specPath], ledger: testLedger(root),
    });
    expect(covering.grant).toBeUndefined();
    // Sync filter tier must also refuse with live identities.
    const amendmentBody = {
      version: 1 as const, mechanism: "DETERMINISTIC" as const, operationId, taskId: task.task.id,
      blockerDigest: "b".repeat(64), exemptedPaths: [specPath], decidedBy: "human" as const,
      decisionReason: "x", decidedAt: new Date().toISOString(), decisionId: decision.decisionId,
      requestId: grant.exemptionId, decidedActor: "human:owner:test",
      ownerExemption: { exemptionId: grant.exemptionId, decisionId: decision.decisionId, decisionDigest: sha256Canonical(decision) },
      amendedScope: ["src/**", specPath],
      contractPath: "c", sealPath: "s", amendmentPath: "a",
    };
    const amendmentLike = { ...amendmentBody, amendmentDigest: sha256Canonical(amendmentBody) };
    expect(() =>
      filterForbiddenScopeForAmendment([...repairHardProtectedPaths(config, task)], amendmentLike as never, repairHardProtectedPaths(config, task), {
        grant, operationId: live.id, controllerEpoch: currentControllerEpoch(live),
        candidateRevision: live.candidateRevision!.revision,
        candidateIdentityDigest: live.candidateRevision!.identityDigest,
        policyDigest: live.resolvedOperationPolicy?.digest ?? "missing",
        operationExecutionRevision: live.operationExecutionRevision!,
        terminal: false,
      } as never),
    ).toThrow(/NON_EXEMPTIBLE/i);
    void findRepairHardProtectedViolations;
  });
});

describe("B2 RED: trusted issuance via paired Control Center session", () => {
  it("unauthenticated/direct call cannot create an exemption request; paired-session request works with session-bound actor", async () => {
    const { recordControlCenterDecision, recordControlCenterExemptionRequest } = await import("../src/control-center/decision.js");
    const root = await createRepo();
    const operationId = "B2-AUTH-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const ledger = testLedger(root);
    void config;

    // Direct/unauthenticated: missing session actor must fail.
    await expect(
      (recordControlCenterExemptionRequest as (...args: unknown[]) => Promise<unknown>)(root, {
        operationId, purpose: "HARD_PROTECTION_EXEMPTION", paths: [specPath], reason: "direct",
      }, ""),
    ).rejects.toThrow(/session|auth|human|paired/i);
    // Caller-supplied actorId in body must be rejected (never trusted).
    await expect(
      recordControlCenterDecision(root, ledger, {
        operationId, purpose: "HARD_PROTECTION_EXEMPTION", paths: [specPath], reason: "forged actor", actorId: "human:forged",
      } as unknown, "human:control-center:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toThrow(/actor|unsupported|session/i);

    // Paired-session request works and binds actor from session.
    const sessionActor = "human:control-center:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const result = await recordControlCenterDecision(root, ledger, {
      operationId, purpose: "HARD_PROTECTION_EXEMPTION", paths: [specPath], reason: "paired owner approves",
    } as unknown, sessionActor) as Record<string, unknown>;
    expect(result.accepted).toBe(true);
    expect(typeof result.decisionId).toBe("string");
    expect(typeof result.exemptionId).toBe("string");
    const stored = await ledger.find(result.decisionId as string);
    expect(stored?.actorId).toBe(sessionActor);
    expect(stored?.purpose).toMatchObject({ kind: "HARD_PROTECTION_EXEMPTION", paths: [specPath] });
  });

  it("paired HTTP session creates an exemption; unauthenticated HTTP cannot", async () => {
    const { LocalControlCenterV1 } = await import("../src/control-center/server.js");
    const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
    const { pairControlCenter } = await import("./helpers/controlCenterSession.js");
    const root = await createRepo();
    const operationId = "B2-HTTP-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    void config;
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const ledger = testLedger(root);
    const center = new LocalControlCenterV1({
      onDecision: async (value, actorId) => {
        const result = await recordControlCenterDecision(root, ledger, value, actorId);
        return {
          accepted: result.accepted === true,
          ...(typeof (result as Record<string, unknown>).decisionId === "string" ? { decisionId: (result as Record<string, unknown>).decisionId as string } : {}),
          ...(typeof (result as Record<string, unknown>).exemptionId === "string" ? { exemptionId: (result as Record<string, unknown>).exemptionId as string } : {}),
          ...(typeof (result as Record<string, unknown>).operationId === "string" ? { operationId: (result as Record<string, unknown>).operationId as string } : {}),
        };
      },
    });
    const started = await center.start();
    try {
      const body = JSON.stringify({ operationId, purpose: "HARD_PROTECTION_EXEMPTION", paths: [specPath], reason: "http paired" });
      const unauth = await fetch(`${started.url}api/v1/decisions`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      expect([401, 403, 400]).toContain(unauth.status);
      expect(await ledger.list()).toHaveLength(0);

      const session = await pairControlCenter(started);
      const ok = await fetch(`${started.url}api/v1/decisions`, {
        method: "POST", headers: { ...session.headers(true), "content-type": "application/json" }, body,
      });
      expect(ok.status).toBe(200);
      const parsed = await ok.json() as Record<string, unknown>;
      expect(parsed.accepted).toBe(true);
      const decisions = await ledger.list();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.actorId).toMatch(/^human:control-center:[a-f0-9]{32}$/);
      expect(decisions[0]!.actorId).not.toContain("forged");
    } finally {
      await center.close();
    }
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-r2-"));
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
    intent: "owner exemption test policy",
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
    project: { name: "owner-exemption-test" },
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
