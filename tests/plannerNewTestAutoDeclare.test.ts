import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import {
  autoDeclarePlannerNewTestScopes,
  computePlannerUndeclaredHardScopes,
  executePlannerWaves,
  resolvePlannerScopeDeclarations,
  validatePlannerWavePlan,
} from "../src/agents/waveExecutor.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { REPAIR_SCOPE_APPROVE_CHOICE_ID } from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

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
    project: { name: "planner-auto-decl-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function baseContract(): TaskContract {
  return {
    version: 1,
    task: { id: "PLAN-AUTO", title: "Planner auto-declare new tests" },
    source: { proposal: "specs/changes/PLAN-AUTO/proposal.md", spec: "specs/changes/PLAN-AUTO/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    requirements: [{ id: "REQ-1" }],
    verification: { commands: [] },
  };
}

function wideContract(): TaskContract {
  return { ...baseContract(), scope: { allowed: ["**"], forbidden: [], frozen: [] } };
}

function planWithObjectives(
  units: { scope: string[]; objective: string }[],
  declared: { path: string; reason: string }[] = [],
): PlannerOutput {
  return plannerOutputSchema.parse({
    workUnits: units.map((unit, index) => ({
      id: `wu-${index + 1}`,
      objective: unit.objective,
      scope: unit.scope,
      dependencies: [],
      requirementRefs: ["REQ-1"],
      acceptanceRefs: [],
      competencies: [],
      riskTags: [],
      changeKinds: ["test"],
      risk: "low",
    })),
    affectedAreas: [],
    reviewDimensions: [],
    validationRequirements: [],
    outOfScopeImprovements: [],
    filesNeededOutsideScope: declared,
  });
}

describe("D10 planner new-test auto-declare (DETERMINISTIC, no providers)", () => {
  it("(a) undeclared NEW tests/ file auto-declares with a transparent reason and re-validates CLEAR", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const fresh = "tests/auto-new-001.test.ts";
    const raw = planWithObjectives([{ scope: [fresh], objective: "Add regression coverage for the new boundary" }]);
    const issues = validatePlannerWavePlan(task, raw, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    const auto = await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root });
    expect(auto).not.toBeNull();
    expect(auto!.autoDeclared).toEqual([fresh]);
    expect(auto!.hardRemaining).toEqual([]);
    expect(auto!.plan.filesNeededOutsideScope).toHaveLength(1);
    expect(auto!.plan.filesNeededOutsideScope[0]!.path).toBe(fresh);
    expect(auto!.plan.filesNeededOutsideScope[0]!.reason).toMatch(/^\[auto-derived from WU wu-1 scope\] /);
    expect(auto!.plan.filesNeededOutsideScope[0]!.reason).toContain("Add regression coverage for the new boundary");
    expect(validatePlannerWavePlan(task, auto!.plan, cfg)).toEqual([]);
  });

  it("(a-amend) auto-declared NEW tests/ file routes to the existing suspend/amend channel (approve -> AMENDED)", async () => {
    const root = await createRepo();
    const operationId = "PLAN-AUTO-NEWTEST-1";
    const task = baseContract();
    const cfg = config();
    await writeContractAndSeal(root, cfg, task);
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "planning",
      root, payload: { taskId: task.task.id }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    bindEnv(operationId, root);
    await bindPolicyForCurrentIdentity(root, operationId);
    const wide: TaskContract = { ...task, scope: { allowed: ["**"], forbidden: [], frozen: [] } };
    const fresh = "tests/auto-new-amend-001.test.ts";
    const raw = planWithObjectives([{ scope: [fresh], objective: "Add regression coverage for the amend channel" }]);
    expect(validatePlannerWavePlan(wide, raw, cfg).some((issue) => issue.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED"))).toBe(true);
    const auto = await autoDeclarePlannerNewTestScopes({ contract: wide, plan: raw, config: cfg, root });
    expect(auto).not.toBeNull();
    expect(validatePlannerWavePlan(wide, auto!.plan, cfg)).toEqual([]);
    const pending = resolvePlannerScopeDeclarations({ root, controlRoot: root, config: cfg, contract: wide, plan: auto!.plan });
    const approve = approveWaitingRequest(root, operationId, REPAIR_SCOPE_APPROVE_CHOICE_ID, "owner approves new test creation");
    const routed = await Promise.all([pending, approve]).then(([r]) => r);
    expect(routed.status).toBe("AMENDED");
    if (routed.status !== "AMENDED") throw new Error("expected AMENDED");
    expect(routed.amendment.exemptedPaths).toEqual([fresh]);
    expect(routed.contract.scope?.allowed).toContain(fresh);
  });

  it("(b) undeclared EXISTING tests/ file stays terminal with the current diagnostic (no auto-declare)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const existing = "tests/auto-existing-001.test.ts";
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, existing), "it('exists', () => {});\n");
    const raw = planWithObjectives([{ scope: [existing], objective: "Extend the existing regression file" }]);
    const issues = validatePlannerWavePlan(task, raw, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    expect(issues[0]).toContain(existing);
    const auto = await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root });
    expect(auto).toBeNull();
  });

  it("(c) mixed new+existing: new auto-declares, existing stays hard, whole plan still fails terminal", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const fresh = "tests/auto-mixed-new-001.test.ts";
    const existing = "tests/auto-mixed-existing-001.test.ts";
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, existing), "it('exists', () => {});\n");
    const raw = planWithObjectives([
      { scope: [fresh], objective: "Add fresh regression coverage" },
      { scope: [existing], objective: "Extend the existing regression file" },
    ]);
    const issues = validatePlannerWavePlan(task, raw, cfg);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED"))).toBe(true);
    const auto = await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root });
    expect(auto).not.toBeNull();
    // New-test subset synthesized; existing path reported as the hard remainder.
    expect(auto!.autoDeclared).toEqual([fresh]);
    expect(auto!.hardRemaining).toEqual([existing]);
    // Re-validation still cites the existing file: the whole plan fails
    // terminal (the auto-declared subset is discarded with it, never routed).
    const reIssues = validatePlannerWavePlan(task, auto!.plan, cfg);
    expect(reIssues).toHaveLength(1);
    expect(reIssues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    expect(reIssues[0]).toContain(existing);
    expect(reIssues.join("\n")).not.toContain(fresh);
  });

  it("(d) no hard intersections: CLEAR unchanged (no auto-declare)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const raw = planWithObjectives([{ scope: ["src/a.ts"], objective: "Touch in-scope source" }]);
    expect(validatePlannerWavePlan(task, raw, cfg)).toEqual([]);
    expect(computePlannerUndeclaredHardScopes(task, raw, cfg)).toEqual([]);
    expect(await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root })).toBeNull();
    const routed = await resolvePlannerScopeDeclarations({
      root, controlRoot: root, config: cfg, contract: task, plan: raw,
    });
    expect(routed.status).toBe("CLEAR");
  });

  it("glob scopes touching hard protection are never auto-declared (stay TERMINAL)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const raw = planWithObjectives([{ scope: ["tests/**"], objective: "Cover everything under tests" }]);
    const issues = validatePlannerWavePlan(task, raw, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    expect(issues[0]).toContain("Glob scopes cannot be satisfied by declaration");
    const intersections = computePlannerUndeclaredHardScopes(task, raw, cfg);
    expect(intersections).toHaveLength(1);
    expect(intersections[0]!.isExactFile).toBe(false);
    expect(await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root })).toBeNull();
  });

  it("non-test hard paths are never auto-declared (validators stay TERMINAL)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const raw = planWithObjectives([{ scope: ["src/validators/rules.ts"], objective: "Change validator behavior" }]);
    expect(validatePlannerWavePlan(task, raw, cfg).some((issue) => issue.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED"))).toBe(true);
    expect(await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root })).toBeNull();
  });

  it("caps synthesized declarations at 8 (overflow stays terminal)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const cfg = config();
    const fresh = Array.from({ length: 9 }, (_, i) => `tests/auto-cap-new-${String(i).padStart(3, "0")}.test.ts`);
    const raw = planWithObjectives(fresh.map((scope) => ({ scope: [scope], objective: `Coverage ${scope}` })));
    expect(validatePlannerWavePlan(task, raw, cfg)).toHaveLength(9);
    const auto = await autoDeclarePlannerNewTestScopes({ contract: task, plan: raw, config: cfg, root });
    expect(auto).not.toBeNull();
    expect(auto!.autoDeclared).toHaveLength(8);
    expect(auto!.hardRemaining).toHaveLength(1);
    const reIssues = validatePlannerWavePlan(task, auto!.plan, cfg);
    expect(reIssues).toHaveLength(1);
    expect(reIssues[0]).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
  });
});

describe("D10 runPlanning integration (precomputedPlan, no providers)", () => {
  function waveInput(root: string, contract: TaskContract, plan: PlannerOutput) {
    return {
      root,
      stateRoot: root,
      config: config(),
      contract: contract as never,
      implementationSelection: { logicalAgent: "implementer" } as never,
      executionCatalog: {} as never,
      capabilityRegistry: {} as never,
      precomputedPlan: plan,
      revalidate: async () => { throw new Error("must not revalidate on pre-execution failure"); },
    };
  }

  function resultMessage(result: { aggregateSession?: { stdout?: string; stderr?: string } }): string {
    return `${result.aggregateSession?.stdout ?? ""}\n${result.aggregateSession?.stderr ?? ""}`;
  }

  it("new-test omission routes to the suspend/amend channel (BLOCKED without an operation, not contract-rejected)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const fresh = "tests/auto-wave-new-001.test.ts";
    const raw = planWithObjectives([{ scope: [fresh], objective: "Add regression coverage for the wave path" }]);
    const result = await executePlannerWaves(waveInput(root, task, raw));
    expect(result.used).toBe(true);
    expect(result.preExecutionFailure).toBe(true);
    expect(result.waves).toEqual([]);
    // Before the fix this was terminal "Planner contract rejected:
    // PLANNER_PROTECTED_SCOPE_UNDECLARED"; after auto-declare the augmented
    // plan reaches the existing declaration routing (BLOCKED fail-closed with
    // no operation to suspend).
    expect(resultMessage(result)).toContain("Planner scope blocked");
    expect(resultMessage(result)).toContain(fresh);
    expect(resultMessage(result)).not.toContain("Planner contract rejected");
  });

  it("existing-test omission stays terminal with the current diagnostic", async () => {
    const root = await createRepo();
    const task = wideContract();
    const existing = "tests/auto-wave-existing-001.test.ts";
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, existing), "it('exists', () => {});\n");
    const raw = planWithObjectives([{ scope: [existing], objective: "Extend the existing regression file" }]);
    const result = await executePlannerWaves(waveInput(root, task, raw));
    expect(result.used).toBe(true);
    expect(result.preExecutionFailure).toBe(true);
    expect(resultMessage(result)).toContain("Planner contract rejected");
    expect(resultMessage(result)).toContain("PLANNER_PROTECTED_SCOPE_UNDECLARED");
    expect(resultMessage(result)).toContain(existing);
  });

  it("mixed new+existing stays terminal citing the hard remainder (augmented plan retained for inspection)", async () => {
    const root = await createRepo();
    const task = wideContract();
    const fresh = "tests/auto-wave-mixed-new-001.test.ts";
    const existing = "tests/auto-wave-mixed-existing-001.test.ts";
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, existing), "it('exists', () => {});\n");
    const raw = planWithObjectives([
      { scope: [fresh], objective: "Add fresh regression coverage" },
      { scope: [existing], objective: "Extend the existing regression file" },
    ]);
    const result = await executePlannerWaves(waveInput(root, task, raw));
    expect(result.used).toBe(true);
    expect(result.preExecutionFailure).toBe(true);
    expect(resultMessage(result)).toContain("Planner contract rejected");
    expect(resultMessage(result)).toContain(existing);
    // The new-test subset was synthesized before the terminal verdict; the
    // whole plan still fails and is never routed to suspension.
    expect(result.plan?.filesNeededOutsideScope?.map((entry) => entry.path)).toEqual([fresh]);
    expect(result.plan?.filesNeededOutsideScope?.[0]?.reason).toMatch(/^\[auto-derived from WU wu-1 scope\] /);
  });
});

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
    controllerEpoch: currentControllerEpoch(current), intent: "planner auto-declare test policy",
    route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {},
    validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {},
    contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-auto-"));
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
