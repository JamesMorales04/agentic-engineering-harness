import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation, repairProtectedPaths } from "../src/candidates/repair.js";
import {
  applyRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  repairHardProtectedPaths,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
} from "../src/candidates/repairScope.js";
import {
  anchorOwnerHardProtectionExemption,
  applyOwnerExemptedRepairScopeAmendment,
  requestOwnerHardProtectionExemption,
  verifyOwnerHardProtectionExemption,
} from "../src/candidates/repairOwnerExemption.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  isTerminalOperation,
  loadOperation,
  transitionOperationToTerminal,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

const mocks = vi.hoisted(() => ({ executeAgentPrompt: vi.fn() }));
vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/operations/supervisor.js", () => ({
  consolidateWithOperationSupervisor: vi.fn(async (_root: string, _config: unknown, _contract: unknown, _selection: unknown, input: { findings: unknown[] }) => ({
    output: { summary: "t", consolidatedFindings: input.findings, sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" },
    artifact: "t.json",
    session: { provider: "test", logicalAgent: "operation-supervisor", exitCode: 0, stdout: "", stderr: "" },
  })),
  maybeRotateOperationSupervisor: vi.fn(async () => undefined),
}));

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT,
  managed: process.env.AEH_MANAGED_AGENT,
  logical: process.env.AEH_LOGICAL_AGENT,
  role: process.env.AEH_AGENT_ROLE,
  interactive: process.env.AEH_INTERACTIVE_LEAD,
  orchestration: process.env.AEH_ORCHESTRATION_ALLOWED,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_MANAGED_AGENT", originalEnv.managed);
  restoreEnv("AEH_LOGICAL_AGENT", originalEnv.logical);
  restoreEnv("AEH_AGENT_ROLE", originalEnv.role);
  restoreEnv("AEH_INTERACTIVE_LEAD", originalEnv.interactive);
  restoreEnv("AEH_ORCHESTRATION_ALLOWED", originalEnv.orchestration);
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("owner-scoped hard-protection exemption (RED-first)", () => {
  it("pins the current gate: lead-approved amendment touching hard paths throws NON_EXEMPTIBLE with no exemption path", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-PIN-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    expect(findRepairHardProtectedViolations([sealPath], config, task)).toEqual([sealPath]);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:pin",
      filesNeededOutsideScope: [{ path: sealPath, reason: "needs seal tweak" }],
    });
    // No exemption exists anywhere: even a consumed ledger approval throws.
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-pin-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const binding = syntheticBinding(operationId);
    const requestId = "request:owner-pin-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:control-center:test", reason: "attempt seal exemption",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await expect(
      applyRepairScopeAmendment({ root, config, contract: task, blocker, authorization: { decision, binding, requestId }, ledger }),
    ).rejects.toThrow(/NON_EXEMPTIBLE/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("honest owner exemption: request -> anchor -> resolver AMENDED for a hard seal path, retry writes", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-HONEST-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    // Tracked hard file: the contract's source spec (hard-protected via
    // contract.source, and git-tracked so ChangeSet capture observes writes —
    // .harness seal artifacts are gitignored and invisible to the assembler).
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    expect(findRepairHardProtectedViolations([specPath], config, task)).toEqual([specPath]);
    const { decision, exemptionId } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [specPath], reason: "owner accepts seal regeneration for this operation", actorId: "human:owner:test",
    });
    expect(exemptionId).toMatch(/^exemption:[0-9a-f-]{36}$/i);
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    expect(grant.exemptionId).toBe(exemptionId);
    expect(grant.paths).toEqual([specPath]);
    expect(grant.decidedActor).toBe("human:owner:test");
    expect(grant.decisionDigest).toBe(sha256Canonical(decision));

    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:owner",
      filesNeededOutsideScope: [{ path: specPath, reason: "spec must be regenerated" }],
    });
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.contract.scope?.allowed).toContain(specPath);
    expect(resolved.amendment.exemptedPaths).toEqual([specPath]);
    expect(resolved.amendment.ownerExemption?.exemptionId).toBe(exemptionId);
    expect(resolved.amendment.ownerExemption?.decisionId).toBe(decision.decisionId);
    expect(resolved.amendment.ownerExemption?.decisionDigest).toBe(sha256Canonical(decision));
    // No product-choice suspension happened: the owner approval is the authority.
    const after = await loadOperation(root, operationId);
    expect(after.phase).not.toBe("HUMAN_REQUIRED");

    // The amended retry actually writes the exempted hard path.
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    const retry = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:owner-retry", phase: "validation-repair",
      config, contract: resolved.contract, selection, executionCatalog: catalog,
      allowedScope: resolved.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      scopeAmendment: resolved.amendment,
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.writeFile(path.join(isolatedRoot, specPath), "# spec (owner-exempted)\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(specPath);
  });

  it("sibling exactness: an exempted retry writing a non-exempt sibling still throws", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-SIBLING-1";
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
    const sibling = "specs/changes/REPAIR-SCOPE/proposal.md";
    expect(findRepairHardProtectedViolations([sibling], config, task)).toEqual([sibling]);
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [specPath], reason: "only the spec", actorId: "human:owner:test",
    });
    await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:sibling",
      filesNeededOutsideScope: [{ path: specPath, reason: "spec only" }],
    });
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    // The retry writes the exempted spec AND its non-exempt sibling: the
    // sibling must still throw (subtree `specs/**` stays denied for it).
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:sibling-retry", phase: "validation-repair",
        config, contract: resolved.contract, selection, executionCatalog: catalog,
        allowedScope: resolved.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        scopeAmendment: resolved.amendment,
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# spec (owner-exempted)\n");
          await fs.writeFile(path.join(isolatedRoot, sibling), "# proposal (not exempted)\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/escaped.*proposal|proposal.*escaped|scope/i);
  });

  it("forged grant (bad MAC) is rejected at verify, owner-apply, and the forbidden-scope filter", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-FORGE-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision, exemptionId } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealPath], reason: "honest scope", actorId: "human:owner:test",
    });
    const honest = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const forged = { ...honest, paths: [".harness/project.yaml", sealPath], mac: honest.mac };
    const operation = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({ operation, neededPaths: [sealPath], grant: forged, ledger: testLedger(root) }),
    ).rejects.toThrow(/FORGED|MAC|integrity/i);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:forge",
      filesNeededOutsideScope: [{ path: sealPath, reason: "x" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker, grant: forged, ledger: testLedger(root) }),
    ).rejects.toThrow(/FORGED|MAC|integrity/i);
    const amendmentBody = {
      version: 1 as const, mechanism: "DETERMINISTIC" as const, operationId, taskId: task.task.id,
      blockerDigest: "a".repeat(64), exemptedPaths: [sealPath], decidedBy: "human" as const,
      decisionReason: "x", decidedAt: new Date().toISOString(), decisionId: decision.decisionId,
      requestId: exemptionId, decidedActor: "human:owner:test",
      ownerExemption: { exemptionId, decisionId: decision.decisionId, decisionDigest: sha256Canonical(decision) },
      amendedScope: ["src/**", sealPath],
      contractPath: "c", sealPath: "s", amendmentPath: "a",
    };
    const amendmentLike = { ...amendmentBody, amendmentDigest: sha256Canonical(amendmentBody) };
    expect(() =>
      filterForbiddenScopeForAmendment([...repairProtectedPaths(config, task)], amendmentLike as never, repairHardProtectedPaths(config, task), {
        grant: forged, operationId, controllerEpoch: currentControllerEpoch(operation),
      }),
    ).toThrow(/NON_EXEMPTIBLE/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("model-minted ledger decision without a controller-anchored grant grants nothing", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-NOGRANT-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    // A shell writer CAN mint ledger files with a self-declared human: actor;
    // without the controller-anchored MAC grant it must still be BLOCKED.
    const ledger = testLedger(root);
    const operation = await loadOperation(root, operationId);
    const binding = bindingForCurrentOperation(operation);
    const exemptionId = `exemption:${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`;
    const minted = await ledger.record({
      ...binding,
      purpose: { kind: "HARD_PROTECTION_EXEMPTION", exemptionId, paths: [sealPath] },
      kind: "APPROVE", actorId: "human:forged", reason: "model minted",
    });
    expect(minted.decisionId).toMatch(/^decision:/);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:nogrant",
      filesNeededOutsideScope: [{ path: sealPath, reason: "x" }],
    });
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.message).toMatch(/non-exemptible/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("cross-operation replay is rejected: a grant anchored in op A is dead in op B", async () => {
    const root = await createRepo();
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    const opA = "OWNER-EXEMPT-XOP-A";
    await saveOwnedOperation(root, {
      version: 1, id: opA, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(opA, root);
    await bindPolicyForCurrentIdentity(root, opA);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId: opA, paths: [sealPath], reason: "op A only", actorId: "human:owner:test",
    });
    const grantA = await anchorOwnerHardProtectionExemption({ root, operationId: opA, decisionId: decision.decisionId });
    // Op B is saved WITHOUT claiming (controller token stays op A's): the MAC
    // verifies, so rejection must come from the operation binding, not the MAC.
    const opB = "OWNER-EXEMPT-XOP-B";
    const { saveOperation } = await import("../src/operations/state.js");
    process.env.AEH_OPERATION_ID = opB;
    await saveOperation(root, {
      version: 1, id: opB, kind: "run", status: "RUNNING", phase: "repair", root,
      payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    const operationB = await loadOperation(root, opB);
    await expect(
      verifyOwnerHardProtectionExemption({ operation: operationB, neededPaths: [sealPath], grant: grantA, ledger: testLedger(root) }),
    ).rejects.toThrow(/CROSS_OPERATION|operation.*mismatch|binding/i);
    const blockerB = createRepairScopeBlockerReceipt({
      operationId: opB, taskId: task.task.id, workUnitId: "validation-repair:xop",
      filesNeededOutsideScope: [{ path: sealPath, reason: "x" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker: blockerB, grant: grantA, ledger: testLedger(root) }),
    ).rejects.toThrow(/CROSS_OPERATION|operation.*mismatch|binding/i);
  });

  it("expired exemptions are rejected even with a valid MAC", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-EXP-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealPath], reason: "short-lived", actorId: "human:owner:test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const operation = await loadOperation(root, operationId);
    await expect(
      verifyOwnerHardProtectionExemption({
        operation, neededPaths: [sealPath], grant, ledger: testLedger(root),
        now: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toThrow(/EXPIRED/i);
  });

  it("terminal state kills the exemption: grants are stripped and verify refuses", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-TERM-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealPath], reason: "dies with op", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    expect((await loadOperation(root, operationId)).ownerExemptions?.[grant.exemptionId]).toBeDefined();
    await transitionOperationToTerminal(root, operationId, { status: "FAILED", error: "test terminal" });
    const terminal = await loadOperation(root, operationId);
    expect(isTerminalOperation(terminal.status)).toBe(true);
    expect(terminal.ownerExemptions).toBeUndefined();
    await expect(
      verifyOwnerHardProtectionExemption({ operation: terminal, neededPaths: [sealPath], grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/TERMINAL/i);
  });

  it("direct writes never honor exemptions: assembly scope escape still throws with a live grant", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-DIRECT-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    // Tracked hard file (see honest test): the grant names the seal, but the
    // direct write targets the contract source spec with NO amendment — the
    // grant must not widen assembly scope by itself.
    const specPath = "specs/changes/REPAIR-SCOPE/spec.md";
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealPath], reason: "grant exists", actorId: "human:owner:test",
    });
    await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    expect((await loadOperation(root, operationId)).ownerExemptions).toBeDefined();
    // No scopeAmendment: the grant must not widen assembly scope by itself.
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
    });
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:direct", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# direct\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/scope|escaped|denied/i);
  });

  it("managed-agent shells cannot issue exemptions (confused-deputy refusal)", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-AGENT-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    process.env.AEH_MANAGED_AGENT = "1";
    process.env.AEH_LOGICAL_AGENT = "repairer";
    process.env.AEH_AGENT_ROLE = "Repairer";
    process.env.AEH_INTERACTIVE_LEAD = "0";
    process.env.AEH_ORCHESTRATION_ALLOWED = "0";
    await expect(
      requestOwnerHardProtectionExemption({
        root, operationId, paths: [`.harness/seals/${task.task.id}.json`], reason: "agent steering", actorId: "human:owner:test",
      }),
    ).rejects.toThrow(/AGENT_FORBIDDEN|managed|bounded/i);
  });

  it("glob paths are rejected at issuance; not-yet-existing exact files are allowed upfront", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-PATHS-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    await expect(
      requestOwnerHardProtectionExemption({
        root, operationId, paths: ["src/**"], reason: "glob smuggling", actorId: "human:owner:test",
      }),
    ).rejects.toThrow(/PATH_INVALID|exact|wildcard/i);
    await expect(
      requestOwnerHardProtectionExemption({
        root, operationId, paths: ["../escape.ts"], reason: "traversal", actorId: "human:owner:test",
      }),
    ).rejects.toThrow(/PATH_INVALID|safe/i);
    // Exact upfront declaration of a file that does not exist yet is allowed
    // (hard-protected validator sources may need to be created by the repair).
    const future = "src/validators/future-check.ts";
    expect(findRepairHardProtectedViolations([future], config, task)).toEqual([future]);
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [future], reason: "new validator", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    expect(grant.paths).toEqual([future]);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:future",
      filesNeededOutsideScope: [{ path: future, reason: "create the missing validator" }],
    });
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    expect(resolved.status).toBe("AMENDED");
  });

  it("one grant serves repair-loop re-amendment across tasks; the per-task cap still holds", async () => {
    const root = await createRepo();
    const config = projectConfig();
    const taskA = contract("REPAIR-SCOPE-A");
    const taskB = contract("REPAIR-SCOPE-B");
    await writeContractAndSeal(root, config, taskA);
    await writeContractAndSeal(root, config, taskB);
    const operationId = "OWNER-EXEMPT-MULTI-1";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: taskA.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealA = `.harness/seals/${taskA.task.id}.json`;
    const sealB = `.harness/seals/${taskB.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealA, sealB], reason: "both seals", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const ledger = testLedger(root);
    const blockerA = createRepairScopeBlockerReceipt({
      operationId, taskId: taskA.task.id, workUnitId: "validation-repair:multi-a",
      filesNeededOutsideScope: [{ path: sealA, reason: "a" }],
    });
    const first = await applyOwnerExemptedRepairScopeAmendment({ root, config, contract: taskA, blocker: blockerA, grant, ledger });
    expect(first.status).toBe("AMENDED");
    const blockerB = createRepairScopeBlockerReceipt({
      operationId, taskId: taskB.task.id, workUnitId: "validation-repair:multi-b",
      filesNeededOutsideScope: [{ path: sealB, reason: "b" }],
    });
    const second = await applyOwnerExemptedRepairScopeAmendment({ root, config, contract: taskB, blocker: blockerB, grant, ledger });
    expect(second.status).toBe("AMENDED");
    // Same task again: the per-task amendment budget still fails closed.
    const blockerA2 = createRepairScopeBlockerReceipt({
      operationId, taskId: taskA.task.id, workUnitId: "validation-repair:multi-a2",
      filesNeededOutsideScope: [{ path: sealA, reason: "a again" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: taskA, blocker: blockerA2, grant, ledger }),
    ).rejects.toThrow(/Only 1 repair scope amendment|BUDGET/i);
  });

  it("participant steering fails: blocker paths outside the grant are never partially honored", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-STEER-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const sealPath = `.harness/seals/${task.task.id}.json`;
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: [sealPath], reason: "only the seal", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    // The participant declares the granted seal PLUS an ungranted policy file.
    const steered = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:steer",
      filesNeededOutsideScope: [
        { path: sealPath, reason: "granted" },
        { path: ".harness/project.yaml", reason: "steered" },
      ],
    });
    expect(findRepairHardProtectedViolations([".harness/project.yaml"], config, task)).toEqual([".harness/project.yaml"]);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker: steered,
    });
    expect(resolved.status).toBe("BLOCKED");
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker: steered, grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/NOT_COVERED|cover/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("owner path cannot launder amendable manifests past the product-choice deny option", async () => {
    const root = await createRepo();
    const operationId = "OWNER-EXEMPT-LAUNDER-1";
    const task = contract("REPAIR-SCOPE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const { decision } = await requestOwnerHardProtectionExemption({
      root, operationId, paths: ["package-lock.json"], reason: "amendable only", actorId: "human:owner:test",
    });
    const grant = await anchorOwnerHardProtectionExemption({ root, operationId, decisionId: decision.decisionId });
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:launder",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "trivy bump" }],
    });
    await expect(
      applyOwnerExemptedRepairScopeAmendment({ root, config, contract: task, blocker, grant, ledger: testLedger(root) }),
    ).rejects.toThrow(/HARD|amendable|product-choice/i);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-owner-exempt-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", {
    cwd: root,
  });
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

function packet(taskId: string) {
  return {
    version: 1 as const,
    taskId,
    attempt: 1,
    createdAt: new Date().toISOString(),
    failures: [{ id: "dep.vuln", category: "dependency", message: "transitive dep needs bump" }],
  };
}

function repairerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "repairer",
    role: "Repairer",
    domains: [],
    runtimeName: "test",
    runtimeAdapter: "codex",
    paseoProvider: "codex",
    modelAlias: "test",
    modelName: "fake",
    modelId: "fake",
    transport: "direct",
    skills: [],
    mcps: [],
    permissions: {
      read: "allow",
      write: "allow",
      shell: "allow",
      network: "deny",
      delegate: "deny",
      review: "deny",
      gitWrite: "deny",
    },
    outputContract: "repair-result",
    args: [],
    runtimeCapabilities: {},
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
