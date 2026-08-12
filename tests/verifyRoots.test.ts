import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTask } from "../src/core/verify.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }


describe("verification roots", () => {
  it("reads code/diff from the workspace and persists report state in the control root", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-"));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-workspace-"));
    git(workspaceRoot, "init"); git(workspaceRoot, "config", "user.email", "aeh@example.invalid"); git(workspaceRoot, "config", "user.name", "AEH Test");
    await fs.writeFile(path.join(workspaceRoot, "src.txt"), "before\n"); git(workspaceRoot, "add", "src.txt"); git(workspaceRoot, "commit", "-m", "base");
    await fs.writeFile(path.join(workspaceRoot, "src.txt"), "after\n");

    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "root-test" },
      sdd: { reportsDir: ".harness/reports" },
      validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
      telemetry: { enabled: false }
    };
    const contract: TaskContract = {
      version: 1,
      task: { id: "CHANGE-ROOT", title: "Verify workspace" },
      git: { baseRef: "HEAD" },
      scope: { allowed: ["**"], forbidden: [], frozen: [] },
      requirements: []
    };

    const report = await verifyTask(workspaceRoot, config, contract, { stateRoot: controlRoot, policyRoot: controlRoot });
    expect(report.changedFiles).toContain("src.txt");
    await expect(fs.stat(path.join(controlRoot, ".harness", "reports", "CHANGE-ROOT.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(workspaceRoot, ".harness", "reports", "CHANGE-ROOT.json"))).rejects.toThrow();
  });
});
