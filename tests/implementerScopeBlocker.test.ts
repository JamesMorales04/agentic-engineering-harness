import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { outputJsonSchema, validateAgentOutput } from "../src/agents/outputContracts.js";
import { executeRepairerCandidateMutation } from "../src/candidates/repair.js";
import { parseRepairScopeBlockerFromSession } from "../src/candidates/repairScope.js";
import { buildRepairPrompt, buildWorkerPrompt } from "../src/workers/prompt.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runShell } from "../src/utils/process.js";

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

describe("implementer out-of-scope blocker channel (RED-first)", () => {
  it("contract: blocker-only implementer report validates with the declared field", () => {
    const result = validateAgentOutput("implementer", {
      filesChanged: [],
      behaviorImplemented: [],
      decisions: [],
      assumptions: [],
      risks: [],
      validationCommands: [],
      followUp: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    expect(result.ok).toBe(true);
    expect((result.value as { filesNeededOutsideScope: unknown[] }).filesNeededOutsideScope).toHaveLength(1);
  });

  it("contract: implementer changes+blocker fails with the no-mutation conflict", () => {
    const result = validateAgentOutput("implementer", {
      filesChanged: ["src/a.ts"],
      behaviorImplemented: [],
      decisions: [],
      assumptions: [],
      risks: [],
      validationCommands: [],
      followUp: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toMatch(/REPAIR_SCOPE_BLOCKER_CONFLICT/);
  });

  it("contract: fully-empty implementer result still fails (H-NEW-2 preserved)", () => {
    expect(
      validateAgentOutput("implementer", {
        filesChanged: [],
        behaviorImplemented: [],
        decisions: [],
        assumptions: [],
        risks: [],
        validationCommands: [],
        followUp: [],
      }).ok,
    ).toBe(false);
  });

  it("wire: implementer JSON schema carries the blocker field plus the no-mutation anyOf", () => {
    const schema = outputJsonSchema("implementer") as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, unknown>;
    expect(props).toHaveProperty("filesNeededOutsideScope");
    expect(schema).toHaveProperty("anyOf");
  });

  it("extractor: implementer-shaped declaration parses via the canonical extractor", () => {
    const stdout = `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: [],
      behaviorImplemented: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    })}`;
    expect(parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toEqual([
      { path: "package-lock.json", reason: "needs bump" },
    ]);
  });

  it("extractor: repair-shaped declaration still parses (H-NEW-1 preserved)", () => {
    const stdout = `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: [],
      behaviorRepaired: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    })}`;
    expect(parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toEqual([
      { path: "package-lock.json", reason: "needs bump" },
    ]);
  });

  it("extractor: implementer conflict throws (never swallowed as undefined)", () => {
    const stdout = `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: ["src/a.ts"],
      behaviorImplemented: [],
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
    })}`;
    expect(() => parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toThrow(
      /REPAIR_SCOPE_BLOCKER_CONFLICT/,
    );
  });

  it("prompt: implementer prompt mirrors the repair blocker path", () => {
    const prompt = buildWorkerPrompt(
      { version: 1, task: { id: "T1", title: "t" }, source: {}, requirements: [] } as unknown as TaskContract,
      undefined,
    );
    expect(prompt).toMatch(/filesNeededOutsideScope\[{path, reason}\]/);
    expect(prompt).toMatch(/report, don't expand/i);
    expect(prompt).toMatch(/Silent scope expansion is rejected/);
    expect(prompt).toMatch(/lead-approved scope amendment with reseal/);
  });

  it("consumer: run.ts DIRECT path routes implementer declarations to amendment handling", async () => {
    const runTs = await fs.readFile(new URL("../src/core/run.ts", import.meta.url), "utf8");
    expect(runTs).toContain("parseRepairScopeBlockerFromSession");
    expect(runTs).toContain("partitionRepairScopeBlockerFiles");
    expect(runTs).toContain("implementerScopeBlockedCheck");
    expect(runTs).toContain("resolveRepairScopeBlockerViaProductChoice");
    // Suspend boundary: BLOCKED must STOP before validation/repair (no fallthrough).
    expect(runTs).not.toContain("Fall through to normal validation");
    expect(runTs).toContain("BEFORE validation/repair");
  });

  it("end-to-end: Repairer via implementer contract declaring implementer-shaped blocker routes to a BLOCKED receipt", async () => {
    const root = await createRepo();
    const operationId = "CHANGE-IMPL-BLOCKER-1";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, {
      version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "repair",
      root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now,
    } as never);
    bindEnv(operationId, root);
    const selection: AgentExecutionSelection = {
      logicalAgent: "repairer", role: "Repairer", domains: [],
      runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex",
      modelAlias: "test", modelId: "fake", modelName: "fake", transport: "direct",
      skills: [], mcps: [],
      permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", gitWrite: "deny" },
      outputContract: "implementer", args: [], runtimeCapabilities: {},
    };
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "implementer", args: [] } },
    });
    const result = await executeRepairerCandidateMutation({
      root, stateRoot: root, operationId, taskId: task.task.id,
      workUnitId: "validation-repair:implementer-shape", phase: "validation-repair",
      config, contract: task, selection, executionCatalog: catalog,
      allowedScope: ["src/**"], forbiddenScope: [],
      prompt: buildRepairPrompt(packet(task.task.id)),
      execute: async (_ir, participantId) => ({
        provider: "test", logicalAgent: "repairer", participantId, exitCode: 0,
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [],
          behaviorImplemented: [],
          decisions: [],
          assumptions: [],
          risks: [],
          validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump for implementer-shaped repair" }],
          followUp: [],
        })}`,
        stderr: "",
      }),
    });
    expect(result.scopeBlocker).toBeDefined();
    expect(result.scopeBlocker?.filesNeededOutsideScope.map((e) => e.path)).toEqual(["package-lock.json"]);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-impl-blocker-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

function projectConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "impl-blocker-test" },
    sdd: { contractsDir: ".harness/contracts" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function contract(): TaskContract {
  return {
    version: 1,
    task: { id: "IMPLB", title: "implementer blocker" },
    source: { proposal: "specs/changes/IMPLB/proposal.md", spec: "specs/changes/IMPLB/spec.md" },
    git: { baseRef: "HEAD" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DELEGATED", assurance: "STANDARD" },
    verification: { commands: [] },
  };
}

function packet(taskId: string) {
  return {
    version: 1 as const, taskId, attempt: 1, createdAt: new Date().toISOString(),
    failures: [{ id: "dep.vuln", category: "dependency", message: "needs bump" }],
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
