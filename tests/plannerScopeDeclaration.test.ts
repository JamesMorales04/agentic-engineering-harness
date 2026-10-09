import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { outputJsonSchema, plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import { resolvePlannerScopeDeclarations, validatePlannerWavePlan } from "../src/agents/waveExecutor.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import {
  listRepairScopeAmendments,
  REPAIR_SCOPE_APPROVE_CHOICE_ID,
  REPAIR_SCOPE_DENY_CHOICE_ID,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";
import { buildRepairPrompt } from "../src/workers/prompt.js";

vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: vi.fn() }));
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
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function config(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "planner-decl-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "PLAN-DECL", title: "Planner declares protected need" },
    source: { proposal: "specs/changes/PLAN-DECL/proposal.md", spec: "specs/changes/PLAN-DECL/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    requirements: [{ id: "REQ-1" }],
    verification: { commands: [] },
  };
}

function plan(scopes: string[][], declared: { path: string; reason: string }[] = []): PlannerOutput {
  return plannerOutputSchema.parse({
    workUnits: scopes.map((scope, index) => ({
      id: `wu-${index + 1}`,
      objective: `Work unit ${index + 1}`,
      scope,
      dependencies: [],
      requirementRefs: ["REQ-1"],
      acceptanceRefs: [],
      competencies: [],
      riskTags: [],
      changeKinds: ["source"],
      risk: "low",
    })),
    affectedAreas: [],
    reviewDimensions: [],
    validationRequirements: [],
    outOfScopeImprovements: [],
    filesNeededOutsideScope: declared,
  });
}

describe("H-NEW-11 planner plan-level filesNeededOutsideScope", () => {
  it("planner contract accepts the declaration channel (max 8, exact entry schema)", () => {
    const unit = {
      id: "wu-1", objective: "work", scope: ["src/a.ts"], dependencies: [],
      requirementRefs: [], acceptanceRefs: [], competencies: [], riskTags: [],
      changeKinds: ["source"], risk: "low",
    };
    const declared = [{ path: "src/validators/rules.ts", reason: "validator must change" }];
    const parsed = plannerOutputSchema.parse({
      workUnits: [unit],
      filesNeededOutsideScope: declared,
    });
    expect(parsed.filesNeededOutsideScope).toEqual(declared);
    // Old payloads without the channel still parse (default []).
    const legacy = plannerOutputSchema.parse({ workUnits: [unit] });
    expect(legacy.filesNeededOutsideScope).toEqual([]);
    // Same entry schema as repairers: reason required, max 8 entries.
    expect(() => plannerOutputSchema.parse({
      workUnits: [unit],
      filesNeededOutsideScope: [{ path: "src/validators/rules.ts" }],
    })).toThrow();
    expect(() => plannerOutputSchema.parse({
      workUnits: [unit],
      filesNeededOutsideScope: Array.from({ length: 9 }, (_, i) => ({ path: `src/v${i}.ts`, reason: "x" })),
    })).toThrow();
    // Wire schema carries the channel (provider-facing), still optional.
    const wire = outputJsonSchema("planner") as { required?: string[]; properties?: Record<string, unknown> };
    expect(wire.properties?.["filesNeededOutsideScope"]).toBeDefined();
    expect(wire.required).toEqual(["workUnits", "affectedAreas", "reviewDimensions", "validationRequirements", "outOfScopeImprovements"]);
  });

  it("rejects undeclared hard-protected WU scope at compile with a precise diagnostic", () => {
    const issues = validatePlannerWavePlan(contract(), plan([["src/validators/rules.ts"]]), config());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    expect(issues[0]).toContain("src/validators/rules.ts");
    expect(issues[0]).toContain("filesNeededOutsideScope");
  });

  it("accepts the same scope with a matching exact declaration", () => {
    const issues = validatePlannerWavePlan(
      contract(),
      plan([["src/validators/rules.ts"]], [{ path: "src/validators/rules.ts", reason: "validator must change" }]),
      config(),
    );
    expect(issues).toEqual([]);
  });

  it("leaves non-hard scopes untouched (no new issues)", () => {
    expect(validatePlannerWavePlan(contract(), plan([["src/a.ts"]]), config())).toEqual([]);
  });

  it("glob scope intersecting hard protection requires declaration; exact hard file within satisfies", () => {
    const rejected = validatePlannerWavePlan(contract(), plan([["src/validators/**"]]), config());
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    const accepted = validatePlannerWavePlan(
      contract(),
      plan([["src/validators/**"]], [{ path: "src/validators/rules.ts", reason: "validator must change" }]),
      config(),
    );
    expect(accepted).toEqual([]);
  });

  it("rejects malformed declarations fail-closed at compile (glob/traversal)", () => {
    const glob = validatePlannerWavePlan(
      contract(),
      plan([["src/validators/rules.ts"]], [{ path: "src/validators/**", reason: "too broad" }]),
      config(),
    );
    expect(glob.some((issue) => issue.includes("PLANNER_BLOCKER_DECLARATION_INVALID"))).toBe(true);
    const traversal = validatePlannerWavePlan(
      contract(),
      plan([["src/validators/rules.ts"]], [{ path: "../secrets.txt", reason: "escape" }]),
      config(),
    );
    expect(traversal.some((issue) => issue.includes("PLANNER_BLOCKER_DECLARATION_INVALID"))).toBe(true);
  });

  it("routing is CLEAR when nothing is declared", async () => {
    const task = contract();
    const routed = await resolvePlannerScopeDeclarations({
      root: "/tmp", controlRoot: "/tmp", config: config(), contract: task, plan: plan([["src/a.ts"]]),
    });
    expect(routed.status).toBe("CLEAR");
  });

  it("routing strips already-writable declarations (CLEAR, no suspension)", async () => {
    const task = contract();
    const routed = await resolvePlannerScopeDeclarations({
      root: "/tmp", controlRoot: "/tmp", config: config(), contract: task,
      plan: plan([["src/a.ts"]], [{ path: "src/a.ts", reason: "already writable" }]),
    });
    expect(routed.status).toBe("CLEAR");
  });

  it("routing is BLOCKED fail-closed without an operation when genuinely blocked", async () => {
    const task = contract();
    const routed = await resolvePlannerScopeDeclarations({
      root: "/tmp", controlRoot: "/tmp", config: config(), contract: task,
      plan: plan([["src/validators/rules.ts"]], [{ path: "src/validators/rules.ts", reason: "needed" }]),
    });
    expect(routed.status).toBe("BLOCKED");
    if (routed.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(routed.check.message).toContain("src/validators/rules.ts");
  });

  it("end-to-end: declaration -> receipt -> suspend -> approve -> amendment -> assemblable", async () => {
    const root = await createRepo();
    const operationId = "PLAN-DECL-E2E-1";
    const task = contract();
    const cfg = config();
    await writeContractAndSeal(root, cfg, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "planning",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/PLAN-DECL/spec.md";
    // Contract allowlist covers the hard path (else the unrelated outside-scope gate fires first).
    const wide: TaskContract = { ...task, scope: { allowed: ["**"], forbidden: [], frozen: [] } };
    const declared = plan([[specPath]], [{ path: specPath, reason: "spec must record the new behavior" }]);
    expect(validatePlannerWavePlan(wide, declared, cfg)).toEqual([]);
    const pending = resolvePlannerScopeDeclarations({ root, controlRoot: root, config: cfg, contract: wide, plan: declared });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "owner approves exact plan set");
    const routed = await Promise.all([pending, approve]).then(([r]) => r);
    expect(routed.status).toBe("AMENDED");
    if (routed.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(routed.contract.scope?.allowed).toContain(specPath);
    expect(routed.amendment.exemptedPaths).toEqual([specPath]);
    expect(routed.amendment.ownerExemption?.exemptionId).toMatch(/^exemption:/);
    // The WU scope is assemblable through the existing exemption-honoring assembly.
    const retry = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "wu-1", phase: "validation-repair",
      config: cfg, contract: routed.contract, selection: repairerSelection(),
      executionCatalog: catalog(),
      allowedScope: routed.contract.scope?.allowed ?? ["**"], forbiddenScope: [],
      scopeAmendment: routed.amendment,
      prompt: buildRepairPrompt({ version: 1, taskId: task.task.id, attempt: 1, createdAt: new Date().toISOString(), failures: [] }),
      execute: async (isolatedRoot, participantId) => {
        await fs.writeFile(path.join(isolatedRoot, specPath), "# spec (planner-declared, owner-exempted)\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(retry.candidate).toBeDefined();
    expect(retry.changeSet?.changedFiles).toContain(specPath);
    expect(await listRepairScopeAmendments(root, cfg, task.task.id)).toHaveLength(1);
  });

  it("end-to-end: deny leaves BLOCKED standing with no amendment", async () => {
    const root = await createRepo();
    const operationId = "PLAN-DECL-E2E-2";
    const task = contract();
    const cfg = config();
    await writeContractAndSeal(root, cfg, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "planning",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const specPath = "specs/changes/PLAN-DECL/spec.md";
    const wide: TaskContract = { ...task, scope: { allowed: ["**"], forbidden: [], frozen: [] } };
    const declared = plan([[specPath]], [{ path: specPath, reason: "spec must record the new behavior" }]);
    const pending = resolvePlannerScopeDeclarations({ root, controlRoot: root, config: cfg, contract: wide, plan: declared });
    const deny = approveWaitingRequest(root, operationId, REPAIR_SCOPE_DENY_CHOICE_ID, "not justified");
    const routed = await Promise.all([pending, deny]).then(([r]) => r);
    expect(routed.status).toBe("BLOCKED");
    if (routed.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(routed.check.message).toContain(specPath);
    expect(await listRepairScopeAmendments(root, cfg, task.task.id)).toHaveLength(0);
  });
});

function catalog() {
  return compileExecutionCatalog({
    runtimes: { test: { adapter: "codex" } },
    models: { test: { runtime: "test", model: "fake" } },
    roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } },
  });
}

function repairerSelection(): AgentExecutionSelection {
  return {
    logicalAgent: "repairer", role: "Repairer", domains: [],
    runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex",
    modelAlias: "test", modelName: "fake", modelId: "fake",
    transport: "direct", skills: [], mcps: [],
    permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
    outputContract: "repair-result", args: [], runtimeCapabilities: {},
  };
}

function bindEnv(operationId: string, root: string): void {
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROL_ROOT = root;
}

async function approveWaitingRequest(root: string, operationId: string, choiceId: string, reason: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const current = await loadOperation(root, operationId);
    if (current.phase === "HUMAN_REQUIRED" && current.decisionRequest) {
      const { recordControlCenterDecision } = await import("../src/control-center/decision.js");
      const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
      await recordControlCenterDecision(root, ledger, {
        operationId, requestId: current.decisionRequest.requestId, choiceId, reason,
      }, "human:control-center:test");
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("suspension never appeared for planner blocker");
}

async function bindPolicyForCurrentIdentity(root: string, operationId: string) {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current), intent: "planner declaration test policy",
    route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {},
    validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {},
    contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-decl-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

async function writeContractAndSeal(root: string, cfg: HarnessProjectConfig, task: TaskContract): Promise<void> {
  const dir = path.join(root, cfg.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${task.task.id}.yaml`), YAML.stringify(task));
  const { sealTask } = await import("../src/core/seal.js");
  await fs.mkdir(path.join(root, "specs", "changes", task.task.id), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "proposal.md"), "# proposal\n");
  await fs.writeFile(path.join(root, "specs", "changes", task.task.id, "spec.md"), "# spec\n");
  await sealTask(root, cfg, task);
}
