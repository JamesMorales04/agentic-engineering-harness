import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeAgentPrompt: vi.fn() }));

vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/operations/supervisor.js", () => ({
  consolidateWithOperationSupervisor: vi.fn(async (_root, _config, _contract, _selection, input) => ({
    output: { summary: "test consolidation", consolidatedFindings: input.findings, sourceFindingIds: input.findings.map((finding: { id: string }) => finding.id), conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" },
    artifact: "test-consolidation.json",
    session: session("operation-supervisor", "participant:supervisor")
  })),
  maybeRotateOperationSupervisor: vi.fn(async () => undefined)
}));

import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport, WorkerSession } from "../src/core/types.js";
import { runReviewLifecycle } from "../src/agents/reviewLifecycle.js";
import type { AgentExecutionSelection, ResolvedRoute } from "../src/agents/types.js";
import { loadOperation, saveOperation } from "../src/operations/state.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  control: process.env.AEH_CONTROL_ROOT
};

afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", originalEnv.id);
  restoreEnv("AEH_OPERATION_KIND", originalEnv.kind);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", originalEnv.redirect);
  restoreEnv("AEH_CONTROL_ROOT", originalEnv.control);
  mocks.executeAgentPrompt.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("review remediation candidate lifecycle", () => {
  it("rejects a Reviewer mutation and terminalizes as SYSTEM_FAILURE without changing the Candidate", async () => {
    const root = await createRepo();
    const operationId = "RUN-REVIEW-MUTATION-ATTEMPT";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    const candidate = (await loadOperation(root, operationId)).candidateRevision!;
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;
    const reviewer = selection("reviewer", "Reviewer");
    const repairer = selection("repairer", "Repairer");
    const implementer = selection("implementer", "Implementer");
    mocks.executeAgentPrompt.mockImplementation(async (agentRoot: string, _config: HarnessProjectConfig, _contract: TaskContract, agent: AgentExecutionSelection, _prompt: string, options: { participantId?: string }) => {
      expect(agent.role).toBe("Reviewer");
      await fs.writeFile(path.join(agentRoot, "src", "value.ts"), "export const value = 99;\n");
      return { ...session(agent.logicalAgent, options.participantId), stdout: `AEH_RESULT_JSON=${JSON.stringify({ verdict: "PASS", findings: [], finalizationSafety: "SAFE" })}` };
    });

    const result = await runReviewLifecycle({
      root,
      stateRoot: root,
      config,
      contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" } satisfies ResolvedRoute,
      reviewerSelections: { reviewer },
      repairerSelection: repairer,
      executionCatalog: compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } } }),
      implementationSelection: implementer,
      report: await validate(root, config, task),
      revalidate: () => validate(root, config, task)
    });

    // A reviewer authority violation is not implementation debt: no Repairer is invoked and the
    // operation terminalizes with a durable typed system failure.
    expect(mocks.executeAgentPrompt.mock.calls.map((call) => call[3].role)).toEqual(["Reviewer"]);
    expect(result.status).toBe("FAIL");
    expect(result.finalState).toBe("SYSTEM_FAILURE");
    expect(result.humanRequired).toBe(false);
    const failure = result.checks.find((check) => check.id === "agent.system-failure");
    expect(failure?.message).toContain("Reviewer provider turn failed; this is not remediable implementation debt");
    expect(failure?.message).toContain("MUTATION");
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect((await loadOperation(root, operationId)).candidateRevision?.identityDigest).toBe(candidate.identityDigest);
  });

  it("terminalizes a Reviewer provider stop as SYSTEM_FAILURE without remediation (AEH-V2-0119)", async () => {
    const root = await createRepo();
    const operationId = "RUN-REVIEW-PROVIDER-STOP";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;
    const reviewer = selection("reviewer", "Reviewer");
    const repairer = selection("repairer", "Repairer");
    const implementer = selection("implementer", "Implementer");
    mocks.executeAgentPrompt.mockImplementation(async (_agentRoot: string, _config: HarnessProjectConfig, _contract: TaskContract, agent: AgentExecutionSelection, _prompt: string, options: { participantId?: string }) => {
      if (agent.role === "Repairer") return session(agent.logicalAgent, options.participantId);
      expect(agent.role).toBe("Reviewer");
      return { ...session(agent.logicalAgent, options.participantId), id: "ses_reviewer_permission_stop", exitCode: 1, stderr: "provider session stopped on an unapproved 'permission' prompt (external_directory scope /control/.harness/*)" };
    });

    const result = await runReviewLifecycle({
      root,
      stateRoot: root,
      config,
      contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" } satisfies ResolvedRoute,
      reviewerSelections: { reviewer },
      repairerSelection: repairer,
      executionCatalog: compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } } }),
      implementationSelection: implementer,
      report: await validate(root, config, task),
      revalidate: () => validate(root, config, task)
    });

    expect(mocks.executeAgentPrompt.mock.calls.map((call) => call[3].role)).toEqual(["Reviewer"]);
    expect(result.status).toBe("FAIL");
    expect(result.finalState).toBe("SYSTEM_FAILURE");
    expect(result.humanRequired).toBe(false);
    expect(result.rounds).toBe(0);
    const failure = result.checks.find((check) => check.id === "agent.system-failure");
    expect(failure?.message).toContain("RUNTIME");
    expect(failure?.message).toContain("ses_reviewer_permission_stop");
    expect(failure?.message).toContain("external_directory");
    // A terminal failure path must still carry a quality state for the run summary (AEH-V2-0120).
    expect(result.qualityHistory.length).toBeGreaterThan(0);
    // The review prompt states the authorized boundary so a read-only reviewer cannot wander into
    // an unprojected provider sandbox scope and stop on a permission prompt (AEH-V2-0119).
    const reviewerPrompt = mocks.executeAgentPrompt.mock.calls[0]?.[4] as string;
    expect(reviewerPrompt).toContain("do not attempt to access paths outside this candidate workspace and the operation control root");
  });

  it("terminalizes a SYSTEM_FAILURE-typed reviewer finding instead of remediating it", async () => {
    const root = await createRepo();
    const operationId = "RUN-REVIEW-SYSTEM-FAILURE-FINDING";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;
    const reviewer = selection("reviewer", "Reviewer");
    const repairer = selection("repairer", "Repairer");
    const implementer = selection("implementer", "Implementer");
    mocks.executeAgentPrompt.mockImplementation(async (_agentRoot: string, _config: HarnessProjectConfig, _contract: TaskContract, agent: AgentExecutionSelection, _prompt: string, options: { participantId?: string }) => {
      if (agent.role === "Repairer") return session(agent.logicalAgent, options.participantId);
      expect(agent.role).toBe("Reviewer");
      const findings = [{ ...finding(), severity: "critical" as const, category: "provider-boundary", exceptionType: "SYSTEM_FAILURE" as const, evidence: "The review could not inspect the control plane because the provider sandbox denied it." }];
      return { ...session(agent.logicalAgent, options.participantId), stdout: `AEH_RESULT_JSON=${JSON.stringify({ verdict: "FAIL", findings, finalizationSafety: "BLOCKED" })}` };
    });

    const result = await runReviewLifecycle({
      root,
      stateRoot: root,
      config,
      contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" } satisfies ResolvedRoute,
      reviewerSelections: { reviewer },
      repairerSelection: repairer,
      executionCatalog: compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } } }),
      implementationSelection: implementer,
      report: await validate(root, config, task),
      revalidate: () => validate(root, config, task)
    });

    expect(mocks.executeAgentPrompt.mock.calls.map((call) => call[3].role)).toEqual(["Reviewer"]);
    expect(result.status).toBe("FAIL");
    expect(result.finalState).toBe("SYSTEM_FAILURE");
    expect(result.humanRequired).toBe(false);
    expect(result.checks.find((check) => check.id === "agent.system-failure")?.message).toContain("SYSTEM_FAILURE");
  });

  it("routes quality remediation through Repairer assembly, revalidates, and reviews the new candidate", async () => {
    const root = await createRepo();
    const operationId = "RUN-REVIEW-REPAIR";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    const initialCandidate = (await loadOperation(root, operationId)).candidateRevision!;
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;

    const repairer = selection("repairer", "Repairer");
    const reviewer = selection("reviewer", "Reviewer");
    const implementer = selection("implementer", "Implementer");
    const catalog = compileExecutionCatalog({
      runtimes: { test: { adapter: "codex" } },
      models: { test: { runtime: "test", model: "fake" } },
      roleBindings: { Repairer: { runtimeId: "test", modelAlias: "test", transport: "direct", outputContract: "repair-result", args: [] } }
    });
    let reviewerCalls = 0;
    mocks.executeAgentPrompt.mockImplementation(async (agentRoot: string, _config: HarnessProjectConfig, _contract: TaskContract, agent: AgentExecutionSelection, _prompt: string, options: { participantId?: string }) => {
      if (agent.role === "Repairer") {
        await fs.writeFile(path.join(agentRoot, "src", "value.ts"), "export const value = 2;\n");
        return session(agent.logicalAgent, options.participantId);
      }
      if (agent.role !== "Reviewer") throw new Error(`Unexpected review lifecycle role ${agent.role}.`);
      reviewerCalls += 1;
      const findings = reviewerCalls === 1 ? [finding()] : [];
      const output = { verdict: findings.length ? "FAIL" : "PASS", findings, finalizationSafety: "SAFE" };
      return { ...session(agent.logicalAgent, options.participantId), stdout: `AEH_RESULT_JSON=${JSON.stringify(output)}` };
    });

    const initialReport = await validate(root, config, task);
    expect(initialReport.status).toBe("PASS");
    let validationCount = 1;
    const result = await runReviewLifecycle({
      root,
      stateRoot: root,
      config,
      contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" } satisfies ResolvedRoute,
      reviewerSelections: { reviewer },
      repairerSelection: repairer,
      executionCatalog: catalog,
      implementationSelection: implementer,
      report: initialReport,
      revalidate: async () => { validationCount += 1; return validate(root, config, task); }
    });

    const operation = await loadOperation(root, operationId);
    expect(result.status).toBe("PASS");
    expect(result.report.candidate?.revision).toBe(2);
    expect(operation.candidateRevision?.revision).toBe(2);
    expect(result.report.candidate?.sourceDigest).toBe(await computeWorktreeDigest(root));
    expect(validationCount).toBe(2);
    expect(reviewerCalls).toBe(2);
    expect(mocks.executeAgentPrompt.mock.calls.map((call) => call[3].role)).toEqual(["Reviewer", "Repairer", "Reviewer"]);
    expect(result.checks.some((check) => check.id === "candidate.workspace-identity.reviewer-1-reviewer")).toBe(true);
  });

  it("fails closed instead of falling back to the Implementer for quality remediation", async () => {
    const root = await createRepo();
    const operationId = "RUN-REVIEW-NO-REPAIRER";
    const task = contract();
    const config = projectConfig();
    const now = "2026-01-01T00:00:00.000Z";
    await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "review", root, payload: { taskId: task.task.id }, createdAt: now, updatedAt: now });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROL_ROOT = root;
    const reviewer = selection("reviewer", "Reviewer");
    const implementer = selection("implementer", "Implementer");
    const catalog = compileExecutionCatalog({ runtimes: { test: { adapter: "codex" } }, models: { test: { runtime: "test", model: "fake" } }, roleBindings: { Implementer: { runtimeId: "test", modelAlias: "test", transport: "direct", args: [] } } });
    mocks.executeAgentPrompt.mockResolvedValue({ ...session("reviewer"), stdout: `AEH_RESULT_JSON=${JSON.stringify({ verdict: "FAIL", findings: [finding()], finalizationSafety: "SAFE" })}` });

    await expect(runReviewLifecycle({
      root,
      stateRoot: root,
      config,
      contract: task,
      route: { ruleIds: ["test"], review: [], reviewers: ["reviewer"], reasons: [], implementationRoute: "DELEGATED", assurance: "STANDARD" },
      reviewerSelections: { reviewer },
      repairerSelection: undefined,
      executionCatalog: catalog,
      implementationSelection: implementer,
      report: await validate(root, config, task),
      revalidate: () => validate(root, config, task)
    })).rejects.toThrow("REPAIR_AUTHORITY_REQUIRED");
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-review-repair-") );
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "check.mjs"), "import fs from 'node:fs'; process.exit(/value = [12]/.test(fs.readFileSync('src/value.ts','utf8')) ? 0 : 1);\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm initial", { cwd: root });
  return root;
}

function projectConfig(): HarnessProjectConfig {
  return { version: 1, project: { name: "review-repair-test" }, validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } }, telemetry: { enabled: false }, workflow: { reviews: { leadAcceptance: true } } };
}

function contract(): TaskContract {
  return { version: 1, task: { id: "REVIEW-REPAIR", title: "Review a repaired candidate" }, git: { baseRef: "HEAD" }, scope: { allowed: ["src/**"], forbidden: [], frozen: [] }, routing: { route: "DELEGATED", assurance: "STANDARD" }, verification: { commands: [{ id: "candidate-check", command: "node check.mjs" }] } };
}

function selection(logicalAgent: string, role: AgentExecutionSelection["role"]): AgentExecutionSelection {
  return { logicalAgent, role, domains: [], runtimeName: "test", runtimeAdapter: "codex", paseoProvider: "codex", modelAlias: "test", modelId: "fake", modelName: "fake", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: role === "Reviewer" ? "deny" : "allow", shell: role === "Reviewer" ? "deny" : "allow", network: "deny", delegate: "deny", review: role === "Reviewer" ? "allow" : "deny" }, outputContract: role === "Repairer" ? "repair-result" : role === "Reviewer" ? "reviewer" : "implementer", args: [], runtimeCapabilities: {} };
}

function finding() {
  return { id: "F-MEDIUM", severity: "medium" as const, category: "correctness", location: { file: "src/value.ts" }, evidence: "A correctness issue remains.", impact: "The behavior is wrong.", recommendedFix: "Correct the behavior.", requiredCompetencies: ["typescript"], reviewDimensions: ["correctness"] };
}

function session(logicalAgent: string, participantId?: string): WorkerSession {
  return { provider: "test", logicalAgent, participantId, exitCode: 0, stdout: "", stderr: "" };
}

async function validate(root: string, config: HarnessProjectConfig, task: TaskContract): Promise<ValidationReport> {
  const { verifyTask } = await import("../src/core/verify.js");
  return verifyTask(root, config, task, { stateRoot: root, policyRoot: root });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
