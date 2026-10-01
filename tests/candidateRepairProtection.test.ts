import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { executeRepairerCandidateMutation, assertCompiledRepairer } from "../src/candidates/repair.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { loadOperation, saveOperation } from "../src/operations/state.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("Repairer Candidate boundaries", () => {
  it("rejects edits to acceptance and validator sources before they reach the Candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-protection-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "acceptance"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, "check.mjs"), "process.exit(1);\n");
    await fs.writeFile(path.join(root, "acceptance", "flow.feature"), "Then the value is correct\n");
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
    const operationId = "RUN-REPAIR-PROTECTED";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair", root, payload: { taskId: "REPAIR-PROTECTED" }, createdAt: now, updatedAt: now });
    const initial = (await loadOperation(root, operationId)).candidateRevision!;
    const contract: TaskContract = { version: 1, task: { id: "REPAIR-PROTECTED", title: "Protect acceptance and validators" }, source: { acceptance: "acceptance/flow.feature" }, scope: { allowed: ["**"], forbidden: [], frozen: [] } };
    const config: HarnessProjectConfig = { version: 1, project: { name: "repair-protection" }, validation: { commands: [{ id: "check", command: "node check.mjs" }] } };
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } } });

    await expect(executeRepairerCandidateMutation({
      root,
      stateRoot: root,
      operationId,
      taskId: contract.task.id,
      workUnitId: "quality-repair:protected",
      phase: "validation-repair",
      config,
      contract,
      selection,
      executionCatalog: catalog,
      allowedScope: ["**"],
      forbiddenScope: [],
      prompt: "Repair implementation only.",
      execute: async (isolatedRoot, participantId) => {
        await fs.writeFile(path.join(isolatedRoot, "check.mjs"), "process.exit(0);\n");
        await fs.writeFile(path.join(isolatedRoot, "acceptance", "flow.feature"), "Then any value is accepted\n");
        return { provider: "test", logicalAgent: "repairer", participantId, exitCode: 0, stdout: "", stderr: "" };
      }
    })).rejects.toThrow("ChangeSet escaped its assigned scope: acceptance/flow.feature, check.mjs");

    expect(await fs.readFile(path.join(root, "check.mjs"), "utf8")).toBe("process.exit(1);\n");
    expect(await fs.readFile(path.join(root, "acceptance", "flow.feature"), "utf8")).toBe("Then the value is correct\n");
    expect((await loadOperation(root, operationId)).candidateRevision?.identityDigest).toBe(initial.identityDigest);
  });

  it("rejects a Repairer blueprint that can review or approve its own candidate", () => {
    const selection = repairerSelection();
    const catalog = compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } } });
    expect(() => assertCompiledRepairer({ ...selection, permissions: { ...selection.permissions, review: "allow" } }, catalog)).toThrow("cannot include review");
  });
});

function repairerSelection(): AgentExecutionSelection {
  return { logicalAgent: "repairer", role: "Repairer", domains: [], runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex", modelAlias: "test", modelId: "fake", modelName: "fake", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" }, outputContract: "repair-result", args: [], runtimeCapabilities: {} };
}
