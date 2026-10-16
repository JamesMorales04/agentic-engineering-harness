import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  listRepairScopeAmendments,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  resolveRepairScopeBlockerViaProductChoice,
} from "../src/candidates/repairScope.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

/**
 * D4 (HIGH liveness, fail-closed) regression: an Owner-approved (incl.
 * delegated) hard-protection scope widening must survive to later phases.
 *
 * Later-phase assemblies (remediation fresh repair turns, review remediation,
 * wave repairers) funnel through executeRepairerCandidateMutation with NO
 * scopeAmendment and NO scopeBlocker, so the suspend/mint and honor channels
 * never run for a SILENT ChangeSet on the granted path. Before the fix the
 * escape-correction turn re-escaped and the ORIGINAL terminal kill propagated
 * (live: CHANGE-20261016T075432Z-b30dcf11 rev78 terminal after amendment-1 +
 * exemption:5df489c6 for tests/util.test.js). After the fix the assembly
 * consults the anchored grant (consult-only, cap-stable reuse) and
 * reassembles ONCE.
 *
 * Mechanism: DETERMINISTIC throughout. The `execute` stubs are local
 * filesystem writes (no provider calls); approvals use the in-process
 * control-center decision writer like the existing owner-exemption suites.
 */

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  managed: process.env.AEH_MANAGED_AGENT,
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_MANAGED_AGENT", originalEnv.managed);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function testLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("D4 anchored-grant honor for silent later-phase ChangeSets", () => {
  it("(1) correction ChangeSet on the granted path, no declarations, covering grant -> succeeds via reuse", async () => {
    const root = await createRepo();
    const operationId = "D4-CORRECTION-GRANT-1";
    const task = contract("D4-CORRECTION-GRANT-1");
    const config = projectConfig();
    const specPath = `specs/changes/${task.task.id}/spec.md`;
    const otherHard = "acceptance/flow.feature";
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    // Anchor the grant the D4 way: silent-less blocker declaration for the
    // granted path -> Owner suspend/mint channel -> durable amendment-1.
    const { amendedContract } = await mintGrantForHardPath(root, operationId, task, config, specPath);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);

    // First attempt escapes on an UNCOVERED hard path; the single correction
    // turn then produces a silent ChangeSet on the GRANTED path with no
    // declarations. Before the fix this died with the original terminal kill;
    // after the fix the correction re-assembly honors the anchored grant.
    const { selection, catalog } = repairerBinding();
    let calls = 0;
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:d4-correction", phase: "validation-repair",
      config, contract: amendedContract, selection, executionCatalog: catalog,
      allowedScope: amendedContract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        calls += 1;
        if (calls === 1) {
          await fs.writeFile(path.join(isolatedRoot, otherHard), "Then the other value is correct\n");
        } else {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# spec\n\nExtra granted change.\n");
        }
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toBe(2);
    expect(result.correctionUsed).toBe(true);
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.revision).toBe(2);
    expect(result.changeSet?.changedFiles).toEqual([specPath]);
    // Cap-stable reuse: no amendment-2 was written by the consult-only path.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect(await fs.readFile(path.join(root, specPath), "utf8")).toContain("Extra granted change.");
    // The first attempt's ChangeSet never applied (escape throws pre-apply).
    expect(await fs.readFile(path.join(root, otherHard), "utf8")).toBe("Then the value is correct\n");
    expect((await loadOperation(root, operationId)).status).toBe("RUNNING");
  });

  it("(2) same correction ChangeSet WITHOUT a grant -> stays terminal", async () => {
    const root = await createRepo();
    const operationId = "D4-CORRECTION-NOGRANT-1";
    const task = contract("D4-CORRECTION-NOGRANT-1");
    const config = projectConfig();
    const specPath = `specs/changes/${task.task.id}/spec.md`;
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);

    const { selection, catalog } = repairerBinding();
    let calls = 0;
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: "validation-repair:d4-correction-nogrant", phase: "validation-repair",
        config, contract: task, selection, executionCatalog: catalog,
        allowedScope: ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          calls += 1;
          await fs.writeFile(path.join(isolatedRoot, specPath), "# spec\n\nUngranted change.\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("ChangeSet escaped its assigned scope");
    expect(calls).toBe(2);
    // Consult-only honor wrote nothing: no amendment, no candidate advance.
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(1);
    expect(await fs.readFile(path.join(root, specPath), "utf8")).toBe("# spec\n");
  });

  it("(3) remediation-style assembly (no scopeAmendment, no declarations) on the granted path with covering grant -> succeeds", async () => {
    const root = await createRepo();
    const operationId = "D4-REMEDIATION-GRANT-1";
    const task = contract("D4-REMEDIATION-GRANT-1");
    const config = projectConfig();
    const specPath = `specs/changes/${task.task.id}/spec.md`;
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const { amendedContract } = await mintGrantForHardPath(root, operationId, task, config, specPath);

    // Remediation fresh-turn shape: phase validation-repair, repair work-unit,
    // amended in-memory contract, but NO scopeAmendment and NO declarations.
    const { selection, catalog } = repairerBinding();
    let calls = 0;
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: `repair:${task.task.id}:1`, phase: "validation-repair",
      config, contract: amendedContract, selection, executionCatalog: catalog,
      allowedScope: amendedContract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        calls += 1;
        await fs.writeFile(path.join(isolatedRoot, specPath), "# spec\n\nRemediation granted change.\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Honor lands on the FIRST attempt: no correction turn is consumed.
    expect(calls).toBe(1);
    expect(result.correctionUsed).toBeFalsy();
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.revision).toBe(2);
    expect(result.changeSet?.changedFiles).toEqual([specPath]);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect(await fs.readFile(path.join(root, specPath), "utf8")).toContain("Remediation granted change.");
  });

  it("(4) second DISTINCT hard path without grant -> terminal, no amendment, nothing applied", async () => {
    const root = await createRepo();
    const operationId = "D4-DISTINCT-HARD-1";
    const task = contract("D4-DISTINCT-HARD-1");
    const config = projectConfig();
    const specPath = `specs/changes/${task.task.id}/spec.md`;
    const otherHard = "acceptance/flow.feature";
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const { amendedContract } = await mintGrantForHardPath(root, operationId, task, config, specPath);

    // The granted path is covered but the DISTINCT hard path is not: exact
    // coverage fails, so the escape stays terminal fail-closed (no partial
    // honor, no silent pass on the covered subset).
    const { selection, catalog } = repairerBinding();
    await expect(
      executeRepairerCandidateMutation({
        root, stateRoot: root, operationId, taskId: task.task.id,
        workUnitId: `repair:${task.task.id}:1`, phase: "validation-repair",
        config, contract: amendedContract, selection, executionCatalog: catalog,
        allowedScope: amendedContract.scope?.allowed ?? ["src/**"], forbiddenScope: [],
        prompt: buildRepairPrompt(packet(task.task.id)),
        execute: async (isolatedRoot, participantId) => {
          await fs.writeFile(path.join(isolatedRoot, specPath), "# spec\n\nCovered but tainted.\n");
          await fs.writeFile(path.join(isolatedRoot, otherHard), "Then the tainted value is correct\n");
          return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("ChangeSet escaped its assigned scope");
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(1);
    expect(await fs.readFile(path.join(root, specPath), "utf8")).toBe("# spec\n");
    expect(await fs.readFile(path.join(root, otherHard), "utf8")).toBe("Then the value is correct\n");
  });

  it("(5) fresh-apply sub-path (no durable amendment yet, covering grant anchored) honors via the amended allowlist", async () => {
    const root = await createRepo();
    const operationId = "D4-FRESH-APPLY-1";
    const task = contract("D4-FRESH-APPLY-1");
    const config = projectConfig();
    const specPath = `specs/changes/${task.task.id}/spec.md`;
    await writeContractAndSeal(root, config, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    await mintGrantForHardPath(root, operationId, task, config, specPath);
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);

    // Remove the durable amendment but keep the anchored grant: the honor
    // path must take the fresh-apply sub-path (not reuse) and project the
    // NEWLY amended allowlist — projecting the caller's original allowlist
    // would reject the exact carve-out and rethrow the escape (Luna D4 P2).
    for (const existing of await listRepairScopeAmendments(root, config, task.task.id)) {
      await fs.rm(path.join(root, existing.amendmentPath), { force: true });
    }
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(0);

    const { selection, catalog } = repairerBinding();
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: `repair:${task.task.id}:1`, phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (isolatedRoot, participantId) => {
        await fs.writeFile(path.join(isolatedRoot, specPath), "# spec\n\nFresh-apply honored change.\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.candidate).toBeDefined();
    expect(result.changeSet?.changedFiles).toEqual([specPath]);
    // Fresh apply wrote exactly one amendment (cap consumed once, by the grant path).
    expect(await listRepairScopeAmendments(root, config, task.task.id)).toHaveLength(1);
    expect(await fs.readFile(path.join(root, specPath), "utf8")).toContain("Fresh-apply honored change.");
    expect((await loadOperation(root, operationId)).status).toBe("RUNNING");
  });
});

async function mintGrantForHardPath(
  root: string,
  operationId: string,
  task: TaskContract,
  config: HarnessProjectConfig,
  hardPath: string,
): Promise<{ amendedContract: TaskContract }> {
  const { selection, catalog } = repairerBinding();
  const blockerResult = await executeRepairerCandidateMutation({
    root, stateRoot: root, operationId, taskId: task.task.id,
    workUnitId: `validation-repair:${operationId}`, phase: "validation-repair",
    config, contract: task, selection, executionCatalog: catalog,
    allowedScope: ["src/**"], forbiddenScope: [],
    prompt: buildRepairPrompt(packet(task.task.id)),
    execute: async (_ir, participantId) => ({
      provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [], behaviorRepaired: [], validationCommands: [],
        filesNeededOutsideScope: [{ path: hardPath, reason: "hard needed" }],
      })}`,
      stderr: "",
    }),
  });
  if (!blockerResult.scopeBlocker) throw new Error("expected a scope blocker for the hard path");
  const pending = resolveRepairScopeBlockerViaProductChoice({ root, controlRoot: root, operationId, config, contract: task, blocker: blockerResult.scopeBlocker });
  const approve = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const current = await loadOperation(root, operationId);
      if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
        const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
        await recordControlCenterDecision(root, testLedger(root), {
          operationId, requestId: current.decisionRequest.requestId, choiceId: REPAIR_SCOPE_APPROVE_CHOICE_ID, reason: "approve",
        }, "human:control-center:test");
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no suspension");
  })();
  const resolved = await Promise.all([pending, approve]).then(([r]) => r);
  if (resolved.status !== "AMENDED" || !resolved.ownerExemption) throw new Error("expected AMENDED with an owner exemption");
  const live = await loadOperation(root, operationId);
  const grant = live.ownerExemptions?.[resolved.ownerExemption.exemptionId];
  if (!grant) throw new Error("missing anchored grant");
  return { amendedContract: resolved.contract };
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

function packet(taskId: string) {
  return {
    version: 1 as const, taskId, attempt: 1, createdAt: new Date().toISOString(),
    failures: [{ id: "x", category: "dependency", message: "x" }],
  };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d4-grant-honor-"));
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
  // Commit the sealed inputs so later-phase ChangeSets diff tracked files
  // (the proven pattern from the repair-scope suites).
  await runShell("git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm seal", { cwd: root });
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
    intent: "d4 grant-honor test policy",
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
    project: { name: "d4-grant-honor-test" },
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
