import { describe, expect, it } from "vitest";
import { plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import {
  resolvePlannerScopeDeclarations,
  validatePlannerWavePlan,
} from "../src/agents/waveExecutor.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

function config(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "d26-decl-exempt-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function narrowContract(): TaskContract {
  return {
    version: 1,
    task: { id: "D26", title: "D26 declared scope exemption" },
    source: { proposal: "specs/changes/D26/proposal.md", spec: "specs/changes/D26/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    requirements: [{ id: "REQ-1" }],
    verification: { commands: [] },
  };
}

function wideContract(): TaskContract {
  return { ...narrowContract(), scope: { allowed: ["**"], forbidden: [], frozen: [] } };
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

describe("D26 declared-scope plain exemption (DETERMINISTIC, no providers)", () => {
  it("(a) declared exact new-test file under tests/ passes plain scope and routes to Owner decision", async () => {
    const task = narrowContract();
    const cfg = config();
    const file = "tests/tasks.unit.spec.js";
    const declared = plan([[file]], [{ path: file, reason: "New unit spec; outside allowed scope, needs Owner amendment" }]);
    const issues = validatePlannerWavePlan(task, declared, cfg);
    expect(issues).toEqual([]);
    // Declaration is preserved for routing — never a silent pass. Without a
    // managed operation the existing helper fails closed BLOCKED (with an
    // operation it suspends HUMAN_REQUIRED; suspend->approve/deny is covered
    // by plannerScopeDeclaration.test.ts e2e).
    const routed = await resolvePlannerScopeDeclarations({
      root: "/tmp",
      controlRoot: "/tmp",
      config: cfg,
      contract: task,
      plan: declared,
    });
    expect(routed.status).toBe("BLOCKED");
    if (routed.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(routed.check.message).toContain(file);
    expect(declared.filesNeededOutsideScope?.map((e) => e.path)).toEqual([file]);
  });

  it("(b) undeclared new-test file still fails with the identical diagnostic", () => {
    const task = narrowContract();
    const cfg = config();
    const file = "tests/tasks.unit.spec.js";
    const raw = plan([[file]]);
    const issues = validatePlannerWavePlan(task, raw, cfg);
    // Byte-identical plain-scope diagnostic (the D26 pre-fix terminal).
    expect(issues).toContain(`wu-1 scope ${file} is outside TaskContract scope`);
    expect(issues.some((i) => i.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED") && i.includes(file))).toBe(true);
  });

  it("(c) declared NON-test hard file is not silently passed — it routes to the Owner decision", async () => {
    const wide = wideContract();
    const cfg = config();
    const file = "src/validators/rules.ts";
    const declared = plan([[file]], [{ path: file, reason: "validator must change" }]);
    // Wide contract: plain scope already passes, so validation is CLEAR both
    // pre- and post-fix (guard). The declaration must still reach the Owner
    // route, never a silent pass.
    expect(validatePlannerWavePlan(wide, declared, cfg)).toEqual([]);
    const routed = await resolvePlannerScopeDeclarations({
      root: "/tmp",
      controlRoot: "/tmp",
      config: cfg,
      contract: wide,
      plan: declared,
    });
    expect(routed.status).toBe("BLOCKED");
    if (routed.status !== "BLOCKED") throw new Error("expected BLOCKED");
    expect(routed.check.message).toContain(file);
  });

  it("(guard) malformed declarations never exempt the plain scope check", () => {
    const task = narrowContract();
    const cfg = config();
    const file = "tests/tasks.unit.spec.js";
    for (const bad of ["tests/**", "../secrets.txt", "/abs/path.ts"]) {
      const p = plan([[file]], [{ path: bad, reason: "bad" }]);
      const issues = validatePlannerWavePlan(task, p, cfg);
      expect(issues).toContain(`wu-1 scope ${file} is outside TaskContract scope`);
    }
    // Empty path cannot pass the planner schema (min-length 1); the validator
    // treats it fail-closed when it arrives via a bypass. Construct it
    // without schema parsing to prove no exemption.
    const base = plan([[file]], [{ path: "tests/other.spec.js", reason: "placeholder" }]);
    const withEmpty = { ...base, filesNeededOutsideScope: [{ path: "", reason: "bad" }] };
    expect(validatePlannerWavePlan(task, withEmpty as PlannerOutput, cfg)).toContain(
      `wu-1 scope ${file} is outside TaskContract scope`,
    );
  });

  it("(guard) glob WU scope is never exempted even when an exact file is declared", () => {
    const task = narrowContract();
    const cfg = config();
    const p = plan([["tests/**"]], [{ path: "tests/tasks.unit.spec.js", reason: "needed" }]);
    const issues = validatePlannerWavePlan(task, p, cfg);
    expect(issues).toContain("wu-1 scope tests/** is outside TaskContract scope");
    expect(issues.some((i) => i.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED"))).toBe(true);
  });
});
