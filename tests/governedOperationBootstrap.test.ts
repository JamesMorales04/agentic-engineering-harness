import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/core/init.js";
import type { AuditReport } from "../src/audit/run.js";
import { executeOperation } from "../src/operations/controller.js";
import { claimControllerEpoch, currentOperationContext, loadOperation, recordParticipantReceipt, registerOperationAgent, saveOperation, type OperationRecordV2 } from "../src/operations/state.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";

vi.mock("../src/operations/change.js", () => ({
  prepareChangeOperation: vi.fn(async () => ({
    triage: {
      route: "DELEGATED",
      assurance: "STANDARD",
      mechanism: "DETERMINISTIC",
      routeEvidence: [{ route: "DELEGATED", source: "test", statement: "test route" }],
      reasons: ["test"],
      evidence: { request: "governed change", files: [], domains: [], risk: "low", flags: [] }
    },
    semanticRuntime: {}
  })),
  runChangeOperation: vi.fn()
}));

const environmentKeys = [
  "AEH_CONTROL_ROOT", "AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_STATE_REDIRECT",
  "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"
] as const;

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

beforeEach(() => { previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]])); for (const key of environmentKeys) delete process.env[key]; });
afterEach(async () => {
  for (const key of environmentKeys) { const value = previousEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => execFile("git", args, { cwd: root }, (error) => error ? reject(error) : resolve()));
}

async function fixtureRoot(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${name}-`));
  roots.push(root);
  await initializeProject(root);
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), `version: 1\nproject:\n  name: ${name}\nvalidation:\n  baseRef: master\n`);
  await git(root, ["init", "-q", "-b", "master"]);
  await git(root, ["config", "user.email", "governed@aeh.invalid"]);
  await git(root, ["config", "user.name", "Governed Test"]);
  return root;
}

function operationRecord(root: string, id: string, kind: "audit" | "change", payload: { request: string }): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind, status: "QUEUED", phase: "queued", root, payload,
    revision: 1, operationExecutionRevision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
    intent: kind === "audit" ? { request: String(payload.request), classification: "AUDIT", risk: "low", priority: 50 } : { request: String(payload.request), classification: "CHANGE", priority: 50 },
    supervision: { required: kind === "audit", materialized: false, generations: [] },
    stages: { queued: { name: "queued", status: "RUNNING", revision: 1, startedAt: now } },
    participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

describe("governed operation bootstrap policy", () => {
  it("binds the AUDIT bootstrap policy to the audit contract route and assurance before any participant launch", async () => {
    const root = await fixtureRoot("audit-bootstrap");
    const operation = operationRecord(root, "AUDIT-BOOTSTRAP", "audit", { request: "audit fixture" });
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    let captured: OperationRecordV2 | undefined;
    const report = {
      version: 1, auditId: operation.id, intent: "audit", request: "audit fixture", status: "CLEAN",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      repository: { root, baseRef: "master", dirtyPaths: [] }, reviewers: [], validationChecks: [], findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, note: 0 }, debtPoints: 0, debtScore: 0,
      qualityGate: { pass: true }, productionSafe: true, sessions: [], restoredPaths: []
    } as unknown as AuditReport;
    const result = await executeOperation(root, operation.id, {
      run: vi.fn(async (command: string) => command.includes("workspace create")
        ? { exitCode: 0, stdout: JSON.stringify({ workspaceId: "wks_audit_test", cwd: root }), stderr: "", durationMs: 1 }
        : { exitCode: 1, stdout: "", stderr: "unexpected command", durationMs: 1 }),
      trace: vi.fn(async () => undefined),
      startWatchdog: () => () => undefined,
      notifyCompletion: vi.fn(async () => undefined),
      runAudit: vi.fn(async (targetRoot) => { captured = await loadOperation(targetRoot, operation.id) as OperationRecordV2; return report; })
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(captured?.resolvedOperationPolicy).toBeDefined();
    expect(captured?.resolvedOperationPolicy?.route).toBe("DELEGATED");
    expect(captured?.resolvedOperationPolicy?.minimumAssurance).toBe("STANDARD");
    expect(captured?.intent?.route).toBe("DELEGATED");
    expect(captured?.intent?.assurance).toBe("STANDARD");
  });

  it("terminalizes a successful audit when bounded work is receipted and supervision/assessor identities are exempt", async () => {
    const root = await fixtureRoot("audit-terminal");
    const operation = operationRecord(root, "AUDIT-TERMINAL", "audit", { request: "audit fixture" });
    operation.supervision = { required: true, materialized: true, generations: [{ generation: 1, status: "ACTIVE", agentId: "supervisor-session-1", materialized: true }] };
    operation.participants = {
      "supervisor-session-1": { id: "supervisor-session-1", status: "REGISTERED", registeredAt: new Date().toISOString() },
      "assessor-session-1": { id: "assessor-session-1", role: "Semantic Assessor", status: "REGISTERED", registeredAt: new Date().toISOString() }
    };
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    const candidate = (await loadOperation(root, operation.id)).candidateRevision!;
    await registerOperationAgent(root, operation.id, { id: "worker-reviewer-1", role: "Reviewer" });
    const now = new Date().toISOString();
    await recordParticipantReceipt(root, operation.id, {
      version: 1, receiptId: "receipt:audit-terminal", operationId: operation.id, participantId: "worker-reviewer-1", candidate, outcome: "SUCCEEDED", createdAt: now,
      runtimeTerminal: { kind: "runtime-terminal", eventId: "event-terminal", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
      contract: { contractId: "reviewer", contractDigest: "b".repeat(64), valid: true },
      artifact: { artifactId: "artifact-terminal", artifactDigest: "c".repeat(64), persisted: true, persistedAt: now },
      provenance: { provenanceId: "provenance-terminal", provenanceDigest: "d".repeat(64), source: "test", valid: true }
    });
    const report = {
      version: 1, auditId: operation.id, intent: "audit", request: "audit fixture", status: "CLEAN",
      startedAt: now, finishedAt: now, repository: { root, baseRef: "master", dirtyPaths: [] }, reviewers: [], validationChecks: [], findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, note: 0 }, debtPoints: 0, debtScore: 0,
      qualityGate: { pass: true }, productionSafe: true, sessions: [], restoredPaths: []
    } as unknown as AuditReport;
    const result = await executeOperation(root, operation.id, {
      run: vi.fn(async (command: string) => command.includes("workspace create")
        ? { exitCode: 0, stdout: JSON.stringify({ workspaceId: "wks_audit_terminal", cwd: root }), stderr: "", durationMs: 1 }
        : { exitCode: 1, stdout: "", stderr: "unexpected command", durationMs: 1 }),
      trace: vi.fn(async () => undefined),
      startWatchdog: () => () => undefined,
      notifyCompletion: vi.fn(async () => undefined),
      runAudit: vi.fn(async () => report)
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.result?.auditId).toBe(operation.id);
  });

  it("converts a terminalization gate rejection into a durable FAILED instead of escaping the controller", async () => {
    const root = await fixtureRoot("audit-gate-failure");
    const operation = operationRecord(root, "AUDIT-GATE-FAILURE", "audit", { request: "audit fixture" });
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    await registerOperationAgent(root, operation.id, { id: "unreceipted-worker", role: "Implementer" });
    const report = {
      version: 1, auditId: operation.id, intent: "audit", request: "audit fixture", status: "CLEAN",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), repository: { root, baseRef: "master", dirtyPaths: [] },
      reviewers: [], validationChecks: [], findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0, note: 0 },
      debtPoints: 0, debtScore: 0, qualityGate: { pass: true }, productionSafe: true, sessions: [], restoredPaths: []
    } as unknown as AuditReport;
    const result = await executeOperation(root, operation.id, {
      run: vi.fn(async (command: string) => command.includes("workspace create")
        ? { exitCode: 0, stdout: JSON.stringify({ workspaceId: "wks_audit_gate", cwd: root }), stderr: "", durationMs: 1 }
        : { exitCode: 1, stdout: "", stderr: "unexpected command", durationMs: 1 }),
      trace: vi.fn(async () => undefined),
      startWatchdog: () => () => undefined,
      notifyCompletion: vi.fn(async () => undefined),
      runAudit: vi.fn(async () => report)
    });
    expect(result.status).toBe("FAILED");
    expect(String(result.error)).toContain("V2_TERMINAL_GATE_REJECTED");
  });

  it("imports a GitHub issue through a managed controller operation with controller-issued Planner authority", async () => {
    const root = await fixtureRoot("issue-intake-managed");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const operation = operationRecord(root, "CHANGE-ISSUE-INTAKE", "change", { request: "Import GitHub issue #5" });
    (operation.payload as Record<string, unknown>).issueIntake = { number: 5 };
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    const plannerSelection = { logicalAgent: "planner", role: "Planner", transport: "paseo", runtimeName: "opencode", modelId: "test-model", permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" }, skills: [], mcps: [] } as never;
    const now = new Date().toISOString();
    const runIssueIntake = vi.fn(async (intakeRoot: string, intakeConfig: never, issueNumber: number) => {
      expect(issueNumber).toBe(5);
      const context = currentOperationContext();
      expect(context.id).toBe(operation.id);
      expect(context.controlRoot).toBe(root);
      const authority = await prepareExecutionAuthority(intakeRoot, plannerSelection, { required: true, phase: "planning" });
      expect(authority?.operationId).toBe(operation.id);
      expect(authority?.candidateRevision).toBeDefined();
      const snapshot = { version: 1, provider: "github", repository: "owner/repo", number: issueNumber, url: "https://github.com/owner/repo/issues/5", title: "fixture", body: "body", state: "open", labels: [], createdAt: now, updatedAt: now, fetchedAt: now, contentSha256: "a".repeat(64) };
      const snapshotPath = ".harness/issues/GH-5.json";
      await fs.mkdir(path.join(intakeRoot, ".harness", "issues"), { recursive: true });
      await fs.writeFile(path.join(intakeRoot, snapshotPath), `${JSON.stringify(snapshot, null, 2)}\n`);
      const contract = { version: 1, task: { id: "GH-5", title: "fixture" }, git: { baseRef: "master" }, scope: { allowed: ["**"], forbidden: [], frozen: [] }, routing: { intent: "implement", route: "DELEGATED", assurance: "STANDARD" }, requirements: [] };
      const contractPath = ".harness/contracts/GH-5.yaml";
      await fs.mkdir(path.join(intakeRoot, ".harness", "contracts"), { recursive: true });
      await fs.writeFile(path.join(intakeRoot, contractPath), "version: 1\n");
      const stateRoot = context.controlRoot ?? intakeRoot;
      const candidate = (await loadOperation(stateRoot, operation.id)).candidateRevision!;
      await recordParticipantReceipt(stateRoot, operation.id, {
        version: 1, receiptId: "receipt:planner:fixture", operationId: operation.id, participantId: authority!.participantId, sessionId: "planner-session-1", role: "Planner", phase: "planning", outcome: "SUCCEEDED", candidate, settled: true, createdAt: now,
        runtimeTerminal: { kind: "runtime-terminal", eventId: "event-planner", observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
        contract: { contractId: "task:GH-5", contractDigest: "b".repeat(64), valid: true },
        artifact: { artifactId: "artifact-planner", artifactDigest: "c".repeat(64), persisted: true, persistedAt: now },
        provenance: { provenanceId: "provenance-planner", provenanceDigest: "d".repeat(64), source: "test", valid: true }
      });
      // FORMAL_SDD authoring writes non-ignored specification artifacts after the Planner turn,
      // so the controller advances the candidate lineage explicitly.
      await fs.mkdir(path.join(intakeRoot, "specs", "changes", "GH-5"), { recursive: true });
      await fs.writeFile(path.join(intakeRoot, "specs", "changes", "GH-5", "proposal.md"), "# GH-5\n");
      void intakeConfig;
      return { taskId: "GH-5", route: "DELEGATED", contract: contract as never, snapshot, normalizedBy: "planner+semantic-assessment" as const, plannerParticipantId: authority!.participantId, plannerSessionId: "planner-session-1" };
    });
    const result = await executeOperation(root, operation.id, {
      trace: vi.fn(async () => undefined),
      startWatchdog: () => () => undefined,
      notifyCompletion: vi.fn(async () => undefined),
      createSemanticRuntime: vi.fn(async () => ({} as never)),
      runIssueIntake,
      run: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "intake must not materialize a workspace", durationMs: 1 }))
    });
    expect(runIssueIntake).toHaveBeenCalledTimes(1);
    
    expect(result.status).toBe("SUCCEEDED");
    expect(result.phase).toBe("issue-intake-finished");
    expect(result.result?.issueIntake).toMatchObject({ taskId: "GH-5", route: "DELEGATED", normalizedBy: "planner+semantic-assessment" });
    expect(result.candidateRevision?.revision).toBe(2);
    expect((result.result?.issueIntake as { candidateAdvanced?: boolean } | undefined)?.candidateAdvanced).toBe(true);
  });

  it("rebinds the frozen policy to the workspace candidate revision before the change runner starts", async () => {
    const root = await fixtureRoot("change-policy-rebind");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const worktree = path.join(root, "..", `${path.basename(root)}-worktree`);
    roots.push(worktree);
    await fs.mkdir(worktree, { recursive: true });
    const operation = operationRecord(root, "CHANGE-POLICY-REBIND", "change", { request: "governed change" });
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    let captured: OperationRecordV2 | undefined;
    const result = await executeOperation(root, operation.id, {
      run: vi.fn(async (command: string) => command.includes("workspace create")
        ? { exitCode: 0, stdout: JSON.stringify({ workspaceId: "wks_change_test", isolation: "worktree", cwd: worktree }), stderr: "", durationMs: 1 }
        : { exitCode: 1, stdout: "", stderr: "unexpected command", durationMs: 1 }),
      trace: vi.fn(async () => undefined),
      startWatchdog: () => () => undefined,
      notifyCompletion: vi.fn(async () => undefined),
      runChange: vi.fn(async () => {
        captured = await loadOperation(root, operation.id) as OperationRecordV2;
        // A FAILED change run carries its owning failing checks in the durable terminal error
        // (AEH-V2-0118), so the fixture report must be present and failing.
        return { taskId: operation.id, route: "DELEGATED", triageReasons: [], run: { status: "FAIL", attempts: 0, report: { version: 1, taskId: operation.id, status: "FAIL", checks: [{ id: "fixture-check", status: "FAIL", message: "fixture failure", required: true }], generatedAt: new Date().toISOString() } } };
      }) as never
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("OPERATION_FAILED");
    expect(result.error).toContain("fixture-check");
    expect(captured?.candidateRevision?.revision).toBe(2);
    expect(captured?.resolvedOperationPolicy).toBeDefined();
    expect(captured?.resolvedOperationPolicy?.candidateRevision).toBe(2);
    expect(captured?.resolvedOperationPolicy?.candidateDigest).toBe(captured?.candidateRevision?.identityDigest);
    expect(captured?.resolvedOperationPolicy?.route).toBe("DELEGATED");
  });
});
