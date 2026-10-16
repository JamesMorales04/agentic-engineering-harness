import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  createRepairScopeBlockerReceipt,
  listRepairScopeAmendments,
  loadCurrentTaskAmendmentForAssembly,
  resolveRepairScopeBlockerViaProductChoice,
  writeRepairScopeBlockerReceipt,
} from "../src/candidates/repairScope.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

/**
 * D15 (HIGH liveness, fail-closed) regression: scope-amendment ARTIFACTS do
 * not travel with amended contracts. Live: op
 * CHANGE-20261016T135028Z-989e10d1 — planning-phase delegated approval
 * created durable amendment-1 for tests/range.spec.js (new-test tier), the
 * amended CONTRACT propagated, but the INITIAL post-approval assembly (which
 * enforces hard-protection beyond allowlist membership and needs the
 * amendment object for carve-outs) received scopeAmendment: none and threw
 * terminal escape on the approved file.
 *
 * Fix: new exported helper loadCurrentTaskAmendmentForAssembly (durable-read
 * + digest gates, DETERMINISTIC) + fallback at every initial assembly that
 * holds no fresher amendment (repair apply/reject callee fallback per call,
 * DIRECT closure per assembly). Explicitly-passed amendment always wins (newer
 * by construction); loading consumes no cap; verification below (NOT_SEALED,
 * owner re-verification, lead shape, digests) runs unchanged; uncovered
 * silent ChangeSets stay terminal.
 *
 * Mechanism: DETERMINISTIC throughout. `execute` stubs are local filesystem
 * writes (no providers); approvals use the in-process control-center decision
 * writer like the D4/D12 suites.
 */

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

describe("D15 durable amendment threading for initial assemblies", () => {
  it("(a) initial repair assembly with a pre-existing durable non-owner amendment succeeds via the loaded amendment (no scopeAmendment passed)", async () => {
    const root = await createRepo();
    const operationId = "D15-INITIAL-LOADED-1";
    const task = contract("D15-INITIAL-LOADED-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d15-initial-new.spec.js";
    const first = await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d15-first");
    expect(first.amendment.ownerExemption).toBeUndefined();
    expect(first.amendment.exemptedPaths).toEqual([covered]);

    // The live shape: the amended CONTRACT propagated (caller holds it) but
    // NO amendment object travels with it. The loader must find amendment-1.
    const loaded = await loadCurrentTaskAmendmentForAssembly(root, config, operationId, task.task.id);
    expect(loaded?.amendmentDigest).toBe(first.amendment.amendmentDigest);

    const { selection, catalog } = repairerBinding();
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:d15-initial", phase: "validation-repair",
      config, contract: first.contract, selection, executionCatalog: catalog,
      allowedScope: first.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      // NOTE: no scopeAmendment passed — the D15 defect shape.
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.mkdir(path.dirname(path.join(isolatedRoot, covered)), { recursive: true });
        await fs.writeFile(path.join(isolatedRoot, covered), "it('covers range', () => {});\n// d15 initial via loaded\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.candidate).toBeDefined();
    expect(result.changeSet?.changedFiles).toContain(covered);
    // Consult-only: no new artifact, cap-stable.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  });

  it("(b) without a durable amendment the same silent ChangeSet stays terminal", async () => {
    const root = await createRepo();
    const operationId = "D15-NO-AMENDMENT-1";
    const task = contract("D15-NO-AMENDMENT-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    expect(await loadCurrentTaskAmendmentForAssembly(root, config, operationId, task.task.id)).toBeUndefined();

    const covered = "tests/d15-no-amendment.spec.js";
    const { selection, catalog } = repairerBinding();
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:d15-no-amend", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: task.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.mkdir(path.dirname(path.join(isolatedRoot, covered)), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, covered), "it('covers range', () => {});\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/escaped/i);
  });

  it("(c) explicitly-passed amendment wins over an older durable one", async () => {
    const root = await createRepo();
    const operationId = "D15-EXPLICIT-WINS-1";
    const task = contract("D15-EXPLICIT-WINS-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const durablePath = "tests/d15-durable-old.spec.js";
    const first = await amendViaApproval(root, operationId, task, config, durablePath, "validation-repair:d15-first");
    // The loader sees only the older durable amendment (different path).
    const loaded = await loadCurrentTaskAmendmentForAssembly(root, config, operationId, task.task.id);
    expect(loaded?.exemptedPaths).toEqual([durablePath]);

    // Extend the persisted contract allowlist to also cover the explicit path
    // (NOT_SEALED requires membership; the seal is recomputed deterministically).
    const explicitPath = "tests/d15-explicit-new.spec.js";
    const { default: YAML } = await import("yaml");
    const contractFile = path.join(root, ".harness", "contracts", `${task.task.id}.yaml`);
    const persisted = YAML.parse(await fs.readFile(contractFile, "utf8")) as TaskContract;
    expect(persisted.scope?.allowed).toContain(durablePath);
    const extended: TaskContract = {
      ...persisted,
      scope: { ...(persisted.scope ?? {}), allowed: [...new Set([...(persisted.scope?.allowed ?? []), explicitPath])].sort((a, b) => a.localeCompare(b)) },
    };
    await fs.writeFile(contractFile, YAML.stringify(extended));
    const { sealTask } = await import("../src/core/seal.js");
    await sealTask(root, config, extended);

    // In-memory explicit amendment for the NEW path (valid digest, human
    // authority shape — the retry path re-verifies shape/allowlist/tier, not
    // the ledger, for non-owner amendments).
    const { amendmentDigest: _dropped, ...unsigned } = first.amendment as Record<string, unknown>;
    void _dropped;
    const explicitBody = {
      ...(unsigned as object),
      exemptedPaths: [explicitPath],
      amendedScope: [...new Set([...((first.amendment as unknown as { amendedScope: string[] }).amendedScope ?? []), explicitPath])].sort((a, b) => a.localeCompare(b)),
    };
    const explicit = { ...explicitBody, amendmentDigest: sha256Canonical(explicitBody) } as unknown as typeof first.amendment;

    const { selection, catalog } = repairerBinding();
    // Negative control: the durable alone does NOT cover the explicit path.
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:d15-explicit-control", phase: "validation-repair",
        config, contract: extended, selection, executionCatalog: catalog,
        allowedScope: extended.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.mkdir(path.dirname(path.join(isolatedRoot, explicitPath)), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, explicitPath), "it('explicit', () => {});\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/escaped/i);

    // With the explicit amendment passed, the same ChangeSet succeeds — the
    // explicit (newer by construction) wins over the older durable.
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:d15-explicit-wins", phase: "validation-repair",
      config, contract: extended, selection, executionCatalog: catalog,
      allowedScope: extended.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      scopeAmendment: explicit,
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.mkdir(path.dirname(path.join(isolatedRoot, explicitPath)), { recursive: true });
        await fs.writeFile(path.join(isolatedRoot, explicitPath), "it('explicit', () => {});\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.candidate).toBeDefined();
    expect(result.changeSet?.changedFiles).toContain(explicitPath);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
  });

  it("(d) invalid digest artifact on disk is skipped (falls back to no-amendment behavior)", async () => {
    const root = await createRepo();
    const operationId = "D15-INVALID-SKIPPED-1";
    const task = contract("D15-INVALID-SKIPPED-1");
    const config = projectConfig();
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const covered = "tests/d15-invalid-new.spec.js";
    const first = await amendViaApproval(root, operationId, task, config, covered, "validation-repair:d15-first");
    // Tamper: edit exemptedPaths without recomputing the digest.
    const [stored] = await listRepairScopeAmendments(root, config, task.task.id);
    const tampered = { ...stored, exemptedPaths: ["tests/d15-evil.spec.js"] };
    await fs.writeFile(path.join(root, stored!.amendmentPath), `${JSON.stringify(tampered, null, 2)}\n`);

    // The loader skips the invalid artifact (no throw — falls back to none).
    expect(await loadCurrentTaskAmendmentForAssembly(root, config, operationId, task.task.id)).toBeUndefined();

    // And the assembly stays terminal (no carve-out from the tampered file).
    const { selection, catalog } = repairerBinding();
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:d15-invalid", phase: "validation-repair",
        config, contract: first.contract, selection, executionCatalog: catalog,
        allowedScope: first.contract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.mkdir(path.dirname(path.join(isolatedRoot, covered)), { recursive: true });
          await fs.writeFile(path.join(isolatedRoot, covered), "it('covers range', () => {});\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow(/escaped/i);
  });
});

/** First-blocker approve flow: suspend/record/await → AMENDED (mirrors the D12 suite). */
async function amendViaApproval(
  root: string,
  operationId: string,
  task: TaskContract,
  config: HarnessProjectConfig,
  testPath: string,
  workUnitId: string,
): Promise<{ contract: TaskContract; amendment: { amendmentDigest: string; exemptedPaths: string[]; ownerExemption?: unknown; amendmentPath: string; amendedScope?: string[] } }> {
  const blocker = createRepairScopeBlockerReceipt({
    operationId,
    taskId: task.task.id,
    workUnitId,
    filesNeededOutsideScope: [{ path: testPath, reason: "new test coverage requires creating this file" }],
  });
  await writeRepairScopeBlockerReceipt(root, config, blocker);
  const pending = resolveRepairScopeBlockerViaProductChoice({ root, controlRoot: root, operationId, config, contract: task, blocker });
  const approve = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const current = await loadOperation(root, operationId);
      if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
        const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
        const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
        await recordControlCenterDecision(root, ledger, {
          operationId, requestId: current.decisionRequest.requestId,
          choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "approve exact new-test set",
        }, "human:control-center:test");
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("suspension never appeared for D15 setup approval");
  })();
  const resolved = await Promise.all([pending, approve]).then(([r]) => r);
  expect(resolved.status).toBe("AMENDED");
  if (resolved.status !== "AMENDED") throw new Error("expected AMENDED in D15 setup");
  return { contract: resolved.contract, amendment: resolved.amendment };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d15-thread-amendment-"));
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
    intent: "d15 thread-amendment test policy",
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
    project: { name: "d15-thread-amendment-test" },
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
    failures: [{ id: "d15.thread", category: "scope", message: "needs covered path" }],
  };
}

function repairerBinding() {
  const selection = {
    logicalAgent: "repairer", role: "Repairer", domains: [], runtimeName: "test", runtimeAdapter: "codex",
    paseoProvider: "codex", modelAlias: "test", modelName: "fake", modelId: "fake", transport: "direct",
    skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
    outputContract: "repair-result", args: [], runtimeCapabilities: {},
  } as never;
  const catalog = compileExecutionCatalog({
    runtimes: { test: { adapter: "codex" } },
    models: { test: { runtime: "test", model: "fake" } },
    roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
  });
  return { selection, catalog };
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
