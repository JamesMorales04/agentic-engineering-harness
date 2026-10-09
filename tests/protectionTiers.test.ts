import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  applyRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
} from "../src/candidates/repairScope.js";
// H-NEW-13 RED: risk-tiered hard protection (create vs modify for tests/).
// Desired: paths under tests/ that do NOT exist at evaluation time are
// amendable tier (lead-approved amendment, no hard suspend/grant); paths
// that EXIST stay hard (human-gated suspend as today). Every other hard
// class is unchanged, including new files elsewhere.
import { partitionHardViolationsByNewTestTier } from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
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
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("H-NEW-13 risk-tiered hard protection: create vs modify for tests/", () => {
  it("pins the canonical deny source: tests/ paths are still reported hard by the pure gate", async () => {
    const root = await createRepo();
    const task = contract("TIER-PIN");
    const config = projectConfig();
    const fresh = "tests/tier-fresh-013.test.ts";
    const existing = "tests/tier-existing.test.ts";
    expect(findRepairHardProtectedViolations([fresh], config, task)).toEqual([fresh]);
    expect(findRepairHardProtectedViolations([existing], config, task)).toEqual([existing]);
    void root;
  });

  it("new tests/ file is amendable tier; existing tests/ file stays hard", async () => {
    const root = await createRepo();
    const task = contract("TIER-SPLIT");
    const config = projectConfig();
    const fresh = "tests/tier-fresh-013.test.ts";
    const existing = "tests/tier-existing.test.ts";
    const splitFresh = await partitionHardViolationsByNewTestTier([fresh], config, task, root);
    expect(splitFresh.hard).toEqual([]);
    expect(splitFresh.newTestCreations).toEqual([fresh]);
    const splitExisting = await partitionHardViolationsByNewTestTier([existing], config, task, root);
    expect(splitExisting.hard).toEqual([existing]);
    expect(splitExisting.newTestCreations).toEqual([]);
  });

  it("new files elsewhere stay hard (specs/, src/validators/, project.yaml)", async () => {
    const root = await createRepo();
    const task = contract("TIER-OTHER");
    const config = projectConfig();
    const freshSpec = "specs/changes/TIER-OTHER/fresh-spec.md";
    const freshValidator = "src/validators/tier-fresh-013.ts";
    const freshProject = ".harness/fresh-tier-013.yaml";
    for (const candidate of [freshSpec, freshValidator]) {
      const split = await partitionHardViolationsByNewTestTier([candidate], config, task, root);
      expect(split.newTestCreations).toEqual([]);
      expect(split.hard).toEqual([candidate]);
    }
    const projectSplit = await partitionHardViolationsByNewTestTier([".harness/project.yaml"], config, task, root);
    expect(projectSplit.hard).toEqual([".harness/project.yaml"]);
    expect(projectSplit.newTestCreations).toEqual([]);
    void freshProject;
  });

  it("apply allows a new tests/ file with ledger approval (no grant); refuses an existing one", async () => {
    const root = await createRepo();
    const operationId = "TIER-APPLY-1";
    const task = contract("TIER-APPLY");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    const fresh = "tests/tier-fresh-013.test.ts";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:tier-fresh",
      filesNeededOutsideScope: [{ path: fresh, reason: "new regression coverage" }],
    });
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tier-ledger-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const binding = syntheticBinding(operationId);
    const requestId = "request:tier-fresh-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:control-center:test", reason: "approve new test",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    const amended = await applyRepairScopeAmendment({
      root, config, contract: task, blocker,
      authorization: { decision, binding, requestId }, ledger,
    });
    expect(amended.status).toBe("AMENDED");
    if (amended.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(amended.amendment.exemptedPaths).toEqual([fresh]);
    expect(amended.amendment.ownerExemption).toBeUndefined();

    // Existing-file refusal is isolated on a fresh repo/task: the per-task
    // amendment cap (MAX=1) would otherwise mask the NON_EXEMPTIBLE hard
    // gate with BUDGET_EXCEEDED on the same task.
    const root2 = await createRepo();
    const operationId2 = "TIER-APPLY-2";
    const task2 = contract("TIER-APPLY-EXISTING");
    const config2 = projectConfig();
    await writeContractAndSeal(root2, config2, task2);
    await saveOwnedOperation(root2, {
      version: 1, id: operationId2, kind: "run", status: "RUNNING", phase: "repair",
      root: root2, payload: { taskId: task2.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId2, root2);
    const ledger2 = new HumanDecisionLedgerV2(ledgerDir);
    const binding2 = syntheticBinding(operationId2);
    const existingBlocker = createRepairScopeBlockerReceipt({
      operationId: operationId2, taskId: task2.task.id, workUnitId: "validation-repair:tier-existing",
      filesNeededOutsideScope: [{ path: "tests/tier-existing.test.ts", reason: "tweak gate" }],
    });
    const requestId2 = "request:tier-existing-1";
    const decision2 = await ledger2.recordProductChoice({
      ...binding2,
      purpose: { kind: "PRODUCT_CHOICE", requestId: requestId2, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:control-center:test", reason: "attempt existing test",
    }, requestId2);
    await ledger2.consumeExact(binding2, decision2.purpose, decision2.decisionId, decision2.actorId);
    await expect(
      applyRepairScopeAmendment({
        root: root2, config: config2, contract: task2, blocker: existingBlocker,
        authorization: { decision: decision2, binding: binding2, requestId: requestId2 }, ledger: ledger2,
      }),
    ).rejects.toThrow(/NON_EXEMPTIBLE/i);
  });

  it("resolver routes a new tests/ file to the amendable branch (no owner grant); existing stays hard", async () => {
    const root = await createRepo();
    const operationId = "TIER-RESOLVE-1";
    const task = contract("TIER-RESOLVE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const fresh = "tests/tier-fresh-013.test.ts";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:tier-fresh",
      filesNeededOutsideScope: [{ path: fresh, reason: "new regression coverage" }],
    });
    const { writeRepairScopeBlockerReceipt } = await import("../src/candidates/repairScope.js");
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "approve new test");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(resolved.amendment.exemptedPaths).toEqual([fresh]);
    expect(resolved.amendment.ownerExemption).toBeUndefined();
    expect(resolved.ownerExemption).toBeUndefined();
    const after = await loadOperation(root, operationId);
    expect(after.ownerExemptions ?? {}).toEqual({});

    // Amended retry writes the new test file without any grant.
    const retry = await retryWriting(root, operationId, task, config, resolved.contract, resolved.amendment, fresh, "import { it, expect } from 'vitest';\nit('tier', () => { expect(1).toBe(1); });\n");
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(fresh);
  });

  it("existing tests/ file still suspends hard (timeout BLOCKED, no amendment)", async () => {
    const root = await createRepo();
    const operationId = "TIER-HARD-1";
    const task = contract("TIER-HARD");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:tier-existing",
      filesNeededOutsideScope: [{ path: "tests/tier-existing.test.ts", reason: "tweak gate" }],
    });
    const { writeRepairScopeBlockerReceipt } = await import("../src/candidates/repairScope.js");
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker, timeoutMs: 500, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(resolved.check.message).toMatch(/hard-protected/i);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    const after = await loadOperation(root, operationId);
    expect(after.phase).toBe("HUMAN_REQUIRED");
  });

  it("race: file created between amendment and assembly still assembles (amended scope covers either way)", async () => {
    const root = await createRepo();
    const operationId = "TIER-RACE-1";
    const task = contract("TIER-RACE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const fresh = "tests/tier-race-013.test.ts";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:tier-race",
      filesNeededOutsideScope: [{ path: fresh, reason: "new regression coverage" }],
    });
    const { writeRepairScopeBlockerReceipt } = await import("../src/candidates/repairScope.js");
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const pending = resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker,
    });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "approve new test");
    const resolved = await Promise.all([pending, approve]).then(([r]) => r);
    expect(resolved.status).toBe("AMENDED");
    if (resolved.status !== "AMENDED") throw new Error("expected AMENDED");
    // Concurrent creation between check and assembly: the file now exists,
    // but the amended scope already includes it either way. Verify the scope
    // claim directly (pure projection, no workspace perturbation): the
    // amended allowlist contains the path and the amendment-path filter lifts
    // exactly it from the forbidden set.
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, fresh), "// concurrently created\n");
    expect(resolved.contract.scope?.allowed).toContain(fresh);
    const { filterForbiddenScopeForAmendment } = await import("../src/candidates/repairScope.js");
    const { repairProtectedPaths } = await import("../src/candidates/repair.js");
    const { repairHardProtectedPaths } = await import("../src/candidates/repairScope.js");
    const effectiveForbidden = filterForbiddenScopeForAmendment(
      [...repairProtectedPaths(config, task)],
      resolved.amendment,
      repairHardProtectedPaths(config, resolved.contract),
      undefined,
      [fresh],
    );
    expect(effectiveForbidden.some((p) => p === fresh || p === `${fresh}/**`)).toBe(false);
    // Remove the concurrent file so the workspace digest is restored, then
    // the amended retry writes it through the amendment path.
    await fs.rm(path.join(root, fresh), { force: true });
    const retry = await retryWriting(root, operationId, task, config, resolved.contract, resolved.amendment, fresh, "// retry content\n");
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(fresh);
  });
});

async function approveWaitingRequest(root: string, operationId: string, choiceId: string, reason: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const current = await loadOperation(root, operationId);
    if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
      const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
      const { HumanDecisionLedgerV2: Ledger } = await import("../src/security/humanDecision.js");
      const ledger = new Ledger(path.join(root, ".harness", "security", "human-decisions.json"));
      await recordControlCenterDecision(root, ledger, {
        operationId, requestId: current.decisionRequest.requestId, choiceId, reason,
      }, "human:control-center:test");
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("suspension never appeared");
}

async function retryWriting(root: string, operationId: string, task: TaskContract, config: HarnessProjectConfig, amendedContract: TaskContract, amendment: import("../src/candidates/repairScope.js").RepairScopeAmendmentV1, filePath: string, content: string) {
  const selection = repairerSelection();
  const catalog = compileExecutionCatalog({
    runtimes: { test: { adapter: "codex" } },
    models: { test: { runtime: "test", model: "fake" } },
    roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
  });
  return executeRepairerCandidateMutation({
    root, stateRoot: root, operationId, taskId: task.task.id,
    workUnitId: "validation-repair:tier-retry", phase: "validation-repair",
    config, contract: amendedContract, selection, executionCatalog: catalog,
    allowedScope: amendedContract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
    scopeAmendment: amendment,
    prompt: buildRepairPrompt(packet(task.task.id)),
    execute: async (isolatedRoot, participantId) => {
      await fs.mkdir(path.dirname(path.join(isolatedRoot, filePath)), { recursive: true });
      await fs.writeFile(path.join(isolatedRoot, filePath), content);
      return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tier-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "tests", "tier-existing.test.ts"), "import { it } from 'vitest';\nit('existing', () => {});\n");
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
    intent: "tier test policy",
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
    project: { name: "tier-test" },
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
