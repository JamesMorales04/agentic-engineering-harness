import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Utf8 } from "../src/core/digest.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { persistCommandDiagnosticV1 } from "../src/operations/forensics.js";
import { terminalizeOperation } from "../src/operations/controller.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";
import { reconcileOperationResources, listOperationResources, registerOperationResource } from "../src/runtime/operationResources.js";
import { runExecutable } from "../src/utils/process.js";
import { setupToolchain } from "../src/toolchain/setup.js";
import { installMiseTools } from "../src/toolchain/mise.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const roots: string[] = [];
const envNames = ["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "NPM_TOKEN", "PATH"] as const;
const oldEnv = new Map<string, string | undefined>();

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  for (const name of envNames) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  oldEnv.clear();
});

function saveEnv(name: string): void { if (!oldEnv.has(name)) oldEnv.set(name, process.env[name]); }

async function makeRoot(prefix = "aeh-forensics-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function record(root: string, id: string, candidate?: OperationRecordV2["candidateRevision"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "change", status: "FAILED", phase: "finished", root,
    payload: { request: "forensics fixture" }, revision: 2, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now, startedAt: now, finishedAt: now,
    intent: { classification: "CHANGE", route: "DIRECT" },
    supervision: { required: false, materialized: false, generations: [] },
    stages: { validate: { name: "validate", status: "FAILED", revision: 1, finishedAt: now, artifact: ".harness/reports/validation.json" } },
    participants: { impl: { id: "impl", role: "Implementer", phase: "implementation", status: "FAILED", registeredAt: now, startedAt: now, finishedAt: now } },
    progress: { expected: 1, registered: 1, running: 0, completed: 0, failed: 1, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    ...(candidate ? { candidateRevision: candidate } : {})
  } as OperationRecordV2;
}

describe("durable command and candidate forensics", () => {
  it("captures bounded stdout/stderr tails and complete stream digests", async () => {
    const root = await makeRoot();
    const result = await runExecutable(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(90000));"], {
      cwd: root, timeoutMs: 10_000, captureOutputLimitBytes: 256
    });
    expect(result.stdout.length).toBe(256);
    expect(result.stderr.length).toBe(256);
    expect(result.stdoutBytes).toBe(100_000);
    expect(result.stderrBytes).toBe(90_000);
    expect(result.stdoutDigest).toBe(sha256Utf8("x".repeat(100_000)));
    expect(result.stderrDigest).toBe(sha256Utf8("y".repeat(90_000)));
  });

  it("retains npm ci TypeScript stdout and npm stderr diagnostics before setup failure returns", async () => {
    const root = await makeRoot();
    const workspace = await makeRoot("aeh-npm-install-");
    const operationId = "CHANGE-NPM-DIAGNOSTIC";
    await fs.mkdir(path.join(workspace, ".harness"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".harness", "toolchain.yaml"), [
      "version: 1", "manager:", "  provider: mise", "profiles:", "  core:", "    tools: []", "tools: {}", "projectDependencies:", "  autoDetect: false", "  commands:", "    - npm ci --token=command-secret-token", ""
    ].join("\n"));
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}\n");
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    const candidate = createCandidateRevisionV1({
      operationId, candidateId: `candidate:${operationId}:r1`, projectId: "fixture", taskId: "npm-ci", revision: 1,
      sourceDigest: await computeWorktreeDigest(workspace), worktree: workspace, createdAt: new Date().toISOString()
    });
    await saveOwnedOperation(root, { ...record(root, operationId, candidate), status: "RUNNING", phase: "implementation" });
    await registerOperationResource(root, operationId, { kind: "staging-root", identity: workspace, path: workspace });
    const bin = path.join(root, "fake-bin"); await fs.mkdir(bin, { recursive: true });
    const npm = path.join(bin, "npm");
    await fs.writeFile(npm, "#!/bin/sh\nif [ \"${1:-}\" = --version ]; then echo '10.8.2'; exit 0; fi\nprintf '%s\\n' 'src/App.tsx(12,3): error TS2322: Type string is not assignable to number' 'NPM_TOKEN=must-not-be-persisted' 'Authorization: Bearer sk-secret-bearer-value'\nprintf '%s\\n' 'npm error code EUSAGE' 'Authorization: Bearer sk-secret-stderr-value' 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync' >&2\nexit 2\n", { mode: 0o755 });
    await fs.chmod(npm, 0o755);
    saveEnv("PATH"); process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    saveEnv("AEH_OPERATION_ID"); process.env.AEH_OPERATION_ID = operationId;
    saveEnv("AEH_CONTROL_ROOT"); process.env.AEH_CONTROL_ROOT = root;
    saveEnv("AEH_OPERATION_STATE_REDIRECT"); process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    saveEnv("NPM_TOKEN"); process.env.NPM_TOKEN = "must-not-be-persisted";

    const setupFailure = await setupToolchain(workspace, {
      version: 1, project: { name: "npm-failure-fixture" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    } as HarnessProjectConfig).then(() => undefined, (error: unknown) => error);
    expect(setupFailure).toBeInstanceOf(Error);
    const rawSetupError = setupFailure instanceof Error ? setupFailure.stack ?? setupFailure.message : String(setupFailure);
    expect(rawSetupError).toContain("Project dependency setup failed");
    expect(rawSetupError).not.toContain("command-secret-token");
    expect(rawSetupError).not.toContain("must-not-be-persisted");
    expect(rawSetupError).not.toContain("sk-secret");
    expect(rawSetupError).not.toContain("TS2322");
    const terminal = await terminalizeOperation(root, operationId, {
      status: "FAILED", phase: "failed", error: rawSetupError, finishedAt: new Date().toISOString()
    }, { trace: vi.fn(async () => undefined) as never, notifyCompletion: vi.fn(async () => undefined) as never });
    expect(terminal.error).not.toContain("command-secret-token");
    expect(terminal.error).not.toContain("must-not-be-persisted");
    expect(terminal.error).not.toContain("sk-secret");

    const directory = path.join(root, ".harness", "operations", operationId, "diagnostics");
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const diagnostic = JSON.parse(await fs.readFile(path.join(directory, files[0]!), "utf8")) as {
      version: number; command: { display: string; digest: string }; cwd: string; exitCode: number;
      stdout: { diagnosticTail: string; digest: string; bytes: number }; stderr: { diagnosticTail: string };
      environment: { digest: string; keys: string[] }; tool: { version: string | null }; candidate: unknown;
    };
    expect(diagnostic.version).toBe(1);
    expect(diagnostic.command.display).toBe("npm ci --token=[REDACTED]");
    expect(diagnostic.cwd).toBe(workspace);
    expect(diagnostic.exitCode).toBe(2);
    expect(diagnostic.stdout.diagnosticTail).toContain("TS2322");
    expect(diagnostic.stdout.diagnosticTail).toContain("NPM_TOKEN=[REDACTED]");
    expect(diagnostic.stdout.diagnosticTail).toContain("Authorization: [REDACTED]");
    expect(diagnostic.stderr.diagnosticTail).toContain("Authorization: [REDACTED]");
    expect(diagnostic.stderr.diagnosticTail).toContain("EUSAGE");
    expect(diagnostic.stdout.bytes).toBeGreaterThan(0);
    expect(diagnostic.stdout.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnostic.tool.version).toBe("10.8.2");
    expect(diagnostic.environment.keys).toContain("NPM_TOKEN");
    expect(JSON.stringify(diagnostic)).not.toContain("must-not-be-persisted");
    expect(JSON.stringify(diagnostic)).not.toContain("sk-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("command-secret-token");
    expect(await loadOperation(root, operationId)).toBeTruthy();
    const receipt = await reconcileOperationResources(root, operationId);
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.terminalOrphansRemaining).toBe(0);
    await expect(fs.access(workspace)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, files[0]!), "utf8")).toContain("TS2322");
    expect((await listOperationResources(root, operationId)).every((resource) => resource.state !== "OWNED")).toBe(true);
  });

  it("keeps mise failure output out of the operation record while preserving a redacted diagnostic", async () => {
    const root = await makeRoot();
    const workspace = await makeRoot("aeh-mise-workspace-");
    const operationId = "CHANGE-MISE-DIAGNOSTIC";
    const bin = path.join(root, "fake-bin");
    await fs.mkdir(bin, { recursive: true });
    const mise = path.join(bin, "mise");
    await fs.writeFile(mise, "#!/bin/sh\nprintf '%s\\n' 'src/App.tsx(8,2): error TS2322: compiler failure' 'Authorization: Bearer sk-mise-secret-value' >&2\nexit 2\n", { mode: 0o755 });
    await fs.chmod(mise, 0o755);
    saveEnv("PATH"); process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    saveEnv("AEH_OPERATION_ID"); process.env.AEH_OPERATION_ID = operationId;
    saveEnv("AEH_CONTROL_ROOT"); process.env.AEH_CONTROL_ROOT = root;
    saveEnv("AEH_OPERATION_STATE_REDIRECT"); process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    const candidate = createCandidateRevisionV1({
      operationId, candidateId: `candidate:${operationId}:r1`, projectId: "fixture", taskId: "mise", revision: 1,
      sourceDigest: await computeWorktreeDigest(workspace), worktree: workspace, createdAt: new Date().toISOString()
    });
    await saveOwnedOperation(root, { ...record(root, operationId, candidate), status: "RUNNING", phase: "toolchain-setup" });
    await registerOperationResource(root, operationId, { kind: "staging-root", identity: workspace, path: workspace });
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";

    const setupFailure = await installMiseTools(workspace, { command: "mise", version: "2026.10.1" }, ["node"], false, false)
      .then(() => undefined, (error: unknown) => error);
    expect(setupFailure).toBeInstanceOf(Error);
    const rawSetupError = setupFailure instanceof Error ? setupFailure.stack ?? setupFailure.message : String(setupFailure);
    expect(rawSetupError).toContain("Toolchain command failed");
    expect(rawSetupError).not.toContain("TS2322");
    expect(rawSetupError).not.toContain("sk-mise-secret-value");
    const terminal = await terminalizeOperation(root, operationId, {
      status: "FAILED", phase: "failed", error: rawSetupError, finishedAt: new Date().toISOString()
    }, { trace: vi.fn(async () => undefined) as never, notifyCompletion: vi.fn(async () => undefined) as never });
    expect(terminal.error).not.toContain("TS2322");
    expect(terminal.error).not.toContain("sk-mise-secret-value");

    const directory = path.join(root, ".harness", "operations", operationId, "diagnostics");
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const diagnostic = JSON.parse(await fs.readFile(path.join(directory, files[0]!), "utf8")) as { command: { display: string }; stderr: { diagnosticTail: string } };
    expect(diagnostic.command.display).toBe("mise trust");
    expect(diagnostic.stderr.diagnosticTail).toContain("TS2322");
    expect(diagnostic.stderr.diagnosticTail).toContain("Authorization: [REDACTED]");
    expect(JSON.stringify(diagnostic)).not.toContain("sk-mise-secret-value");
    const cleanup = await reconcileOperationResources(root, operationId);
    expect(cleanup.terminalOrphansRemaining).toBe(0);
    await expect(fs.access(workspace)).rejects.toThrow();
  });

  it("persists changed-file forensics before terminal cleanup removes an owned staging workspace", async () => {
    const root = await makeRoot();
    const workspace = await makeRoot("aeh-candidate-forensics-");
    const operationId = "CHANGE-CANDIDATE-FORENSICS";
    await runExecutable("git", ["init", "-q"], { cwd: workspace, timeoutMs: 10_000 });
    await fs.writeFile(path.join(workspace, "App.tsx"), "export const app = 1;\n");
    await runExecutable("git", ["add", "App.tsx"], { cwd: workspace, timeoutMs: 10_000 });
    await runExecutable("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"], { cwd: workspace, timeoutMs: 10_000 });
    await fs.writeFile(path.join(workspace, "App.tsx"), "export const app = 2;\n");
    const candidate = createCandidateRevisionV1({
      operationId, candidateId: `candidate:${operationId}:r1`, projectId: "fixture", taskId: "home", revision: 1,
      sourceDigest: sha256Utf8("candidate-source"), worktree: workspace, createdAt: new Date().toISOString()
    });
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "reports", "validation.json"), JSON.stringify({ status: "FAIL", diagnostics: ["TypeScript TS2322 candidate check failed"] }));
    const currentCandidate = createCandidateRevisionV1({
      operationId, candidateId: candidate.candidateId, projectId: "fixture", taskId: "home", revision: 1,
      sourceDigest: await computeWorktreeDigest(workspace), worktree: workspace, createdAt: new Date().toISOString()
    });
    const running = { ...record(root, operationId, currentCandidate), status: "RUNNING" as const, phase: "implementation" };
    await saveOwnedOperation(root, running);
    await registerOperationResource(root, operationId, { kind: "staging-root", identity: workspace, path: workspace });

    const terminal = await terminalizeOperation(root, operationId, { status: "FAILED", phase: "failed", error: "fixture validation failure", finishedAt: new Date().toISOString() }, {
      trace: vi.fn(async () => undefined) as never,
      notifyCompletion: vi.fn(async () => undefined)
    });
    expect(terminal.status).toBe("FAILED");
    const receipt = await reconcileOperationResources(root, operationId);
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.terminalOrphansRemaining).toBe(0);
    await expect(fs.access(workspace)).rejects.toThrow();
    const forensicFile = path.join(root, ".harness", "operations", operationId, "forensics", `candidate-${candidate.candidateId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
    const forensic = JSON.parse(await fs.readFile(forensicFile, "utf8")) as {
      changedFiles: string[]; diffDigest: string | null; diffDigestCoverage: string;
      validationReferences: Array<{ artifact?: string }>; validationDiagnostics: Array<{ reference: string; diagnosticTail: string }>;
      lastActivity: { participantId: string | null };
    };
    expect(forensic.changedFiles).toContain("App.tsx");
    expect(forensic.diffDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(forensic.diffDigestCoverage).toBe("COMPLETE");
    expect(forensic.validationReferences).toContainEqual(expect.objectContaining({ artifact: ".harness/reports/validation.json" }));
    expect(forensic.validationDiagnostics).toContainEqual(expect.objectContaining({ reference: ".harness/reports/validation.json", diagnosticTail: expect.stringContaining("TS2322") }));
    expect(forensic.lastActivity.participantId).toBe("impl");
    expect((await listOperationResources(root, operationId)).every((resource) => resource.state !== "OWNED")).toBe(true);
    await reconcileOperationResources(root, operationId);
    expect(await fs.readFile(forensicFile, "utf8")).toContain("TS2322");
  });
});
