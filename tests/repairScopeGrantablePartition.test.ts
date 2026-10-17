import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  findRepairHardProtectedViolations,
  listRepairScopeAmendments,
  partitionHardViolationsByNewTestTier,
  repairScopeBlockerDigest,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
  suspendRepairScopeForProductChoice,
  writeRepairScopeBlockerReceipt,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import type { RepairScopeBlockerReceiptV1 } from "../src/candidates/repairScope.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";

// D32: suspend/human amendment route must partition scope-blocker
// declarations at RAISING into lead-grantable vs never-exemptible paths.
// A mixed declaration (one grantable new-test file + one existing test
// file) must never raise one Owner decision covering both: the grantable
// file would be entangled in the owner-grant lifecycle and lost when grant
// honoring fails. Design (b) whole-declaration fail-fast (see
// resolveRepairScopeBlockerViaProductChoice): no suspension, no decision,
// split guidance. Pure-hard declarations still suspend for Owner (H-NEW-13
// "suspend as today"); pure-grantable declarations amend via lead as today.

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

describe("D32 partition-at-raising: grantable vs never-exemptible", () => {
  it("(a) mixed grantable new-test + existing test: whole declaration BLOCKED fast, NO decision raised, split guidance", async () => {
    const root = await createRepo();
    const operationId = "D32-MIXED-1";
    const task = contract("D32-MIXED");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const fresh = "tests/d32-mixed-new.spec.js";
    const existing = "tests/tier-existing.test.ts";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:d32-mixed",
      filesNeededOutsideScope: [
        { path: fresh, reason: "new regression coverage" },
        { path: existing, reason: "read-only reference for contract shape" },
      ],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker, timeoutMs: 750, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    // No suspension was ever opened: no Owner round-trip was spent.
    const after = await loadOperation(root, operationId);
    if (after.decisionRequest) {
      const offered = (after.decisionRequest.choices ?? []).map((choice) => `${choice.choiceId}: ${choice.description ?? ""}`);
      throw new Error(`D32 defect present: mixed declaration raised a decision offering: ${JSON.stringify(offered)}`);
    }
    expect(after.decisionRequest ?? null).toBeNull();
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
    // Split guidance: names the dropped hard file AND the grantable file.
    expect(resolved.check.message).toMatch(/NON_EXEMPTIBLE/);
    expect(resolved.check.message).toContain(existing);
    expect(resolved.check.message).toContain(fresh);
    expect(resolved.check.message).toMatch(/immutable/);
    expect(resolved.check.message).toMatch(/NEW tests\/ file/);
    expect(resolved.check.message).toMatch(/no decision is raised for a mixed set/i);
    const details = resolved.check.details as { grantableViaLeadPaths?: unknown; nonExemptiblePaths?: unknown };
    expect(details.grantableViaLeadPaths).toEqual([fresh]);
    expect(details.nonExemptiblePaths).toEqual([existing]);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("(b) all-grantable declaration: unchanged behavior (lead decision amends as today)", async () => {
    const root = await createRepo();
    const operationId = "D32-GRANTABLE-1";
    const task = contract("D32-GRANTABLE");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const fresh = "tests/d32-grantable-new.spec.js";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:d32-grantable",
      filesNeededOutsideScope: [{ path: fresh, reason: "new regression coverage" }],
    });
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
    expect(resolved.contract.scope?.allowed).toContain(fresh);
  });

  it("(c) nothing-grantable declaration at the raising gate: NO decision raised, terminal guidance names immutability", async () => {
    const root = await createRepo();
    const operationId = "D32-NOTHING-1";
    const task = contract("D32-NOTHING");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    const existing = "tests/tier-existing.test.ts";
    const blocker = createRepairScopeBlockerReceipt({
      operationId, taskId: task.task.id, workUnitId: "validation-repair:d32-nothing",
      filesNeededOutsideScope: [{ path: existing, reason: "tweak gate" }],
    });
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    let thrown: unknown;
    try {
      await suspendRepairScopeForProductChoice({
        controlRoot: root, operationId, config, blocker, contract: task, workspaceRoot: root,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/NON_EXEMPTIBLE/);
    expect(message).toContain(existing);
    expect(message).toMatch(/immutable/);
    expect(message).toMatch(/NEW tests\/ file/);
    // No decision was raised: the gate threw before any suspension.
    const after = await loadOperation(root, operationId);
    expect(after.decisionRequest ?? null).toBeNull();
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
  });

  it("(d) validator/policy paths stay never-exemptible via the lead channel", async () => {
    const root = await createRepo();
    const task = contract("D32-VALIDATOR");
    const config = projectConfig();
    const validator = "src/validators/d32-rules.ts";
    const policy = ".harness/project.yaml";
    // Tiering keeps both hard (never demoted to the grantable tier).
    const splitValidator = await partitionHardViolationsByNewTestTier([validator], config, task, root);
    expect(splitValidator.hard).toEqual([validator]);
    expect(splitValidator.newTestCreations).toEqual([]);
    const splitPolicy = await partitionHardViolationsByNewTestTier([policy], config, task, root);
    expect(splitPolicy.hard).toEqual([policy]);
    expect(splitPolicy.newTestCreations).toEqual([]);
    expect(findRepairHardProtectedViolations([validator, policy], config, task)).toEqual([validator, policy]);
    // Lead-channel honoring still refuses a validator path with NON_EXEMPTIBLE.
    const root2 = await createRepo();
    const operationId2 = "D32-VALIDATOR-APPLY";
    const task2 = contract("D32-VALIDATOR-APPLY");
    const config2 = projectConfig();
    await writeContractAndSeal(root2, config2, task2);
    await saveOwnedOperation(root2, {
      version: 1, id: operationId2, kind: "run", status: "RUNNING", phase: "repair",
      root: root2, payload: { taskId: task2.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId2, root2);
    const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d32-ledger-"));
    roots.push(ledgerDir);
    const ledger = new HumanDecisionLedgerV2(ledgerDir);
    const binding = syntheticBinding(operationId2);
    const blocker = createRepairScopeBlockerReceipt({
      operationId: operationId2, taskId: task2.task.id, workUnitId: "validation-repair:d32-validator",
      filesNeededOutsideScope: [{ path: validator, reason: "adjust validation" }],
    });
    const requestId = "request:d32-validator-1";
    const decision = await ledger.recordProductChoice({
      ...binding,
      purpose: { kind: "PRODUCT_CHOICE", requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID },
      kind: "CHOOSE", actorId: "human:control-center:test", reason: "attempt validator edit",
    }, requestId);
    await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    await expect(
      applyRepairScopeAmendment({
        root: root2, config: config2, contract: task2, blocker,
        authorization: { decision, binding, requestId }, ledger,
      }),
    ).rejects.toThrow(/NON_EXEMPTIBLE/i);
  });

  it("grantable definition: new tests/ + manifests + non-hard are lead-honorable; existing/frozen/validator/policy stay hard", async () => {    const root = await createRepo();
    const task = contract("D32-TIER");
    const config = projectConfig();
    const fresh = "tests/d32-tier-new.spec.js";
    // H-NEW-13 tier: non-existent tests/ file is grantable tier.
    const splitFresh = await partitionHardViolationsByNewTestTier([fresh], config, task, root);
    expect(splitFresh.hard).toEqual([]);
    expect(splitFresh.newTestCreations).toEqual([fresh]);
    // Dependency manifests are not hard at all (lead-honorable without tiering).
    expect(findRepairHardProtectedViolations(["package.json", "package-lock.json"], config, task)).toEqual([]);
    // Regular non-hard paths are not hard either.
    expect(findRepairHardProtectedViolations(["src/needs-fix.ts"], config, task)).toEqual([]);
    // Existing tests/ file stays hard.
    const splitExisting = await partitionHardViolationsByNewTestTier(["tests/tier-existing.test.ts"], config, task, root);
    expect(splitExisting.hard).toEqual(["tests/tier-existing.test.ts"]);
    expect(splitExisting.newTestCreations).toEqual([]);
    // Frozen-forward-wins: an explicitly frozen new tests/ file stays hard.
    const frozenTask: TaskContract = {
      ...task,
      scope: { ...(task.scope ?? {}), frozen: ["tests/d32-frozen-new.spec.js"] },
    };
    const splitFrozen = await partitionHardViolationsByNewTestTier(["tests/d32-frozen-new.spec.js"], config, frozenTask, root);
    expect(splitFrozen.hard).toEqual(["tests/d32-frozen-new.spec.js"]);
    expect(splitFrozen.newTestCreations).toEqual([]);
  });
});

describe("D32 extension: non-exact/unsafe declarations fail fast at raising", () => {
  it("malformed-mixed (grantable file + glob + traversal): whole declaration BLOCKED fast, guidance names every bad entry", async () => {
    const root = await createRepo();
    const operationId = "D32X-MIXED-1";
    const task = contract("D32X-MIXED");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const fresh = "tests/d32x-mixed-new.spec.js";
    const glob = "tests/**";
    // Traversal spelling that normalizes into a grantable shape: the raising
    // gate must judge the RAW spelling (mirroring the mint gate), so this is
    // malformed even though tests/d32x-trav.spec.js does not exist.
    const traversal = "src/../tests/d32x-trav.spec.js";
    const blocker = forgedBlocker(operationId, task.task.id, "validation-repair:d32x-mixed", [
      { path: fresh, reason: "new regression coverage" },
      { path: glob, reason: "cover everything under tests" },
      { path: traversal, reason: "sneaked spelling" },
    ]);
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker, timeoutMs: 750, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    // Fail-whole: no suspension, no decision, no amendment budget consumed.
    const after = await loadOperation(root, operationId);
    expect(after.decisionRequest ?? null).toBeNull();
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
    expect(resolved.check.message).toMatch(/MALFORMED/);
    expect(resolved.check.message).toContain(glob);
    expect(resolved.check.message).toContain(traversal);
    expect(resolved.check.message).toMatch(/Narrow globs and traversal spellings/);
    expect(resolved.check.message).toContain(fresh);
    expect(resolved.check.message).toMatch(/no amendment budget was consumed/);
    const details = resolved.check.details as { malformedPaths?: unknown; wellFormedPaths?: unknown };
    expect(details.malformedPaths).toEqual([glob, traversal].sort((a, b) => a.localeCompare(b)));
    expect(details.wellFormedPaths).toEqual([fresh]);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });

  it("all-malformed (glob only): BLOCKED fast with no decision and no well-formed carry-forward", async () => {
    const root = await createRepo();
    const operationId = "D32X-ALLMAL-1";
    const task = contract("D32X-ALLMAL");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const glob = "tests/**";
    const blocker = forgedBlocker(operationId, task.task.id, "validation-repair:d32x-allmal", [
      { path: glob, reason: "cover everything under tests" },
    ]);
    await writeRepairScopeBlockerReceipt(root, config, blocker);
    const resolved = await resolveRepairScopeBlockerViaProductChoice({
      root, controlRoot: root, operationId, config, contract: task, blocker, timeoutMs: 750, pollMs: 25,
    });
    expect(resolved.status).toBe("BLOCKED");
    if (resolved.status !== "BLOCKED") throw new Error("expected BLOCKED");
    const after = await loadOperation(root, operationId);
    expect(after.decisionRequest ?? null).toBeNull();
    expect(after.phase).not.toBe("HUMAN_REQUIRED");
    expect(resolved.check.message).toMatch(/MALFORMED/);
    expect(resolved.check.message).toContain(glob);
    expect(resolved.check.message).toMatch(/No well-formed entries/);
    const details = resolved.check.details as { malformedPaths?: unknown; wellFormedPaths?: unknown };
    expect(details.malformedPaths).toEqual([glob]);
    expect(details.wellFormedPaths).toEqual([]);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
  });
});

function forgedBlocker(
  operationId: string,
  taskId: string,
  workUnitId: string,
  entries: { path: string; reason: string }[],
): RepairScopeBlockerReceiptV1 {
  // Forged/direct receipt (bypasses createRepairScopeBlockerReceipt, which
  // refuses safe-globs and drops unsafe entries): the exact S2 threat the
  // raising exactness gate must catch. Zod shape + digest only.
  const body = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId,
    taskId,
    workUnitId,
    declaredAt: "2026-01-01T00:00:00.000Z",
    filesNeededOutsideScope: entries,
  };
  return { ...body, digest: repairScopeBlockerDigest(body) };
}

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

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d32-"));
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
    intent: "d32 test policy",
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
    project: { name: "d32-test" },
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
