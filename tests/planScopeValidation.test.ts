import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/core/types.js";
import { plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import { compilePlannerWorkGraphWithOneCorrection } from "../src/agents/plannerWorkGraphCorrection.js";

const contract: TaskContract = {
  version: 1,
  task: { id: "TASK-SCOPE-SHAPE", title: "Validate plan scope shape" },
  routing: { route: "DELEGATED", assurance: "STANDARD" },
  requirements: []
};

function planWithScopes(scopes: string[][]): PlannerOutput {
  return plannerOutputSchema.parse({
    workUnits: scopes.map((scope, index) => ({
      id: `unit-${index + 1}`,
      objective: `Work unit ${index + 1}`,
      scope,
      dependencies: [],
      requirementRefs: [],
      acceptanceRefs: [],
      competencies: [],
      riskTags: [],
      changeKinds: ["source"],
      risk: "low"
    }))
  });
}

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-scope-"));
  await fs.mkdir(path.join(root, "docs", "evidence", "s9"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "evidence", "s9", "evidence.md"), "# evidence\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  return root;
}

describe("plan-time scope-shape validation (fail-closed, no broadening)", () => {
  it("rejects a bare directory scope that exists on disk", async () => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([["docs/evidence/s9"]]);
      await expect(
        compilePlannerWorkGraphWithOneCorrection({
          contract,
          plan,
          root
        })
      ).rejects.toThrow(/WORK_GRAPH_INVALID.*'unit-1'.*bare directory scope.*docs\/evidence\/s9.*exact file path.*s9\/\*\*/is);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts explicit recursive and exact-file scopes", async () => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([["docs/evidence/s9/**", "src/value.ts", "**"]]);
      const result = await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan,
        root
      });
      expect(result.graph.units).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["parent traversal", "../../outside"],
    ["nested traversal", "docs/../../outside"],
    ["resolvable traversal", "src/../outside"],
    ["absolute path", "/etc/passwd"],
    ["drive prefix", "C:/Windows/System32"],
    ["backslash drive", "C:\\Windows\\System32"],
    ["traversal glob", "../outside/**"],
    ["absolute glob", "/etc/**"]
  ])("rejects out-of-root scope before fs.stat: %s", async (_label, scope) => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([[scope]]);
      await expect(
        compilePlannerWorkGraphWithOneCorrection({ contract, plan, root })
      ).rejects.toThrow(/WORK_GRAPH_INVALID.*out-of-root scope/is);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for 4aeb0ba strip-then-reject: hasUnsafeRawScopeInput in
  // src/architecture/workGraph.ts (via assertNoBareDirectoryScopes <-
  // compilePlannerWorkGraphWithOneCorrection) strips leading `./` (incl.
  // redundant `././` and `.//` forms, backslash variants) FIRST, then rejects
  // drive/`..`/absolute. Without the strip, `./C:/...` looked relative and was accepted.
  it.each([
    ["dot-drive", "./C:/outside"],
    ["dot-traversal", "./../x"],
    ["dot-backslash-drive", ".\\C:\\x"],
    ["redundant-dot-drive", "././C:/outside"],
    ["dot-double-slash-drive", ".//C:/outside"],
    ["redundant-dot-traversal", "././../x"],
    ["dot-double-slash-traversal", ".//../x"],
    ["dot-traversal-glob", "./../outside/**"],
    ["dot-drive-glob", "./C:/outside/**"],
    ["dot-backslash-drive-glob", ".\\C:\\outside\\**"],
  ])("rejects dot-prefixed bypass before fs.stat: %s", async (_label, scope) => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([[scope]]);
      await expect(
        compilePlannerWorkGraphWithOneCorrection({ contract, plan, root })
      ).rejects.toThrow(/WORK_GRAPH_INVALID.*out-of-root scope/is);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts dot-prefixed benign scopes", async () => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([["./src/**", "./src/value.ts"]]);
      const result = await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan,
        root
      });
      expect(result.graph.units).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink scope whose target escapes the root (fail-closed)", async () => {
    const root = await makeRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-scope-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "# secret\n");
      await fs.symlink(outside, path.join(root, "link-outside"));
      const plan = planWithScopes([["link-outside"]]);
      await expect(
        compilePlannerWorkGraphWithOneCorrection({ contract, plan, root })
      ).rejects.toThrow(/WORK_GRAPH_INVALID.*out-of-root scope.*symlink/is);
    } finally {
      await fs.rm(path.join(root, "link-outside"), { force: true });
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts a benign nested glob alongside an inside symlink file", async () => {
    const root = await makeRoot();
    try {
      await fs.symlink(
        path.join(root, "src", "value.ts"),
        path.join(root, "src", "link-inside.ts")
      );
      const plan = planWithScopes([["src/nested/**", "src/link-inside.ts"]]);
      const result = await compilePlannerWorkGraphWithOneCorrection({ contract, plan, root });
      expect(result.graph.units).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
