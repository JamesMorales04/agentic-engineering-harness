import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { verifyTask } from "../src/core/verify.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
async function repoWithChange(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-workspace-"));
  git(root, "init"); git(root, "config", "user.email", "aeh@example.invalid"); git(root, "config", "user.name", "AEH Test");
  await fs.writeFile(path.join(root, "src.txt"), "before\n"); git(root, "add", "src.txt"); git(root, "commit", "-m", "base");
  await fs.writeFile(path.join(root, "src.txt"), "after\n");
  return root;
}
function baseConfig(): HarnessProjectConfig { return { version: 1, project: { name: "root-test" }, sdd: { contractsDir: ".harness/contracts", reportsDir: ".harness/reports" }, validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } }, telemetry: { enabled: false } }; }
function contract(): TaskContract { return { version: 1, task: { id: "CHANGE-ROOT", title: "Verify workspace" }, git: { baseRef: "HEAD" }, scope: { allowed: ["**"], forbidden: [], frozen: [] }, requirements: [] }; }

describe("verification roots", () => {
  it("reads code/diff from the workspace and persists report state in the control root", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-"));
    const workspaceRoot = await repoWithChange();
    const report = await verifyTask(workspaceRoot, baseConfig(), contract(), { stateRoot: controlRoot, policyRoot: controlRoot });
    expect(report.changedFiles).toContain("src.txt");
    await expect(fs.stat(path.join(controlRoot, ".harness", "reports", "CHANGE-ROOT.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(workspaceRoot, ".harness", "reports", "CHANGE-ROOT.json"))).rejects.toThrow();
  });

  it("automatically resolves an enabled delivery worktree when verify is called from the control root", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-control-"));
    const workspaceRoot = await repoWithChange();
    const task = contract();
    const config: HarnessProjectConfig = { ...baseConfig(), delivery: { stateDir: ".harness/delivery", paseo: { enabled: true, autoUseWorkspace: true } } };
    await fs.mkdir(path.join(workspaceRoot, ".harness", "contracts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".harness", "contracts", "CHANGE-ROOT.yaml"), YAML.stringify(task));
    await fs.mkdir(path.join(controlRoot, ".harness", "delivery"), { recursive: true });
    await fs.writeFile(path.join(controlRoot, ".harness", "delivery", "CHANGE-ROOT.json"), JSON.stringify({ version: 1, taskId: "CHANGE-ROOT", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), originatingBranch: "main", paseo: { workspaceId: "ws-root", worktreePath: workspaceRoot } }));

    const report = await verifyTask(controlRoot, config, task);
    expect(report.changedFiles).toContain("src.txt");
    await expect(fs.stat(path.join(controlRoot, ".harness", "reports", "CHANGE-ROOT.json"))).resolves.toBeDefined();
  });
});
