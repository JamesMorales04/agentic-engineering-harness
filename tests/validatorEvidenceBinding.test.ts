import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";

const state = vi.hoisted(() => ({ runIsolatedCommand: vi.fn() }));

vi.mock("../src/security/isolation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security/isolation.js")>();
  return { ...actual, runIsolatedCommand: state.runIsolatedCommand };
});

import { runExternalToolValidator } from "../src/validators/external.js";
import { runSpecCommand } from "../src/validators/toolCommand.js";
import { runValidationCommand } from "../src/validators/commands.js";
import { extractReporterTestsFromExecutionV1 } from "../src/validation/testAttribution.js";
import { parseToolEvidenceResult } from "../src/validators/toolEvidence.js";

const contract: TaskContract = { version: 1, task: { id: "U4", title: "validator evidence binding" } };
const roots: string[] = [];

function baseConfig(): HarnessProjectConfig {
  return { version: 1, project: { name: "u4" }, evidence: { outputDir: ".harness/evidence" } };
}

function isolatedConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "u4-iso" },
    evidence: { outputDir: ".harness/evidence" },
    security: { isolation: { required: true } }
  };
}

beforeEach(() => {
  state.runIsolatedCommand.mockReset();
  state.runIsolatedCommand.mockResolvedValue({
    exitCode: 0,
    stdout: '{"results":[]}',
    stderr: "",
    durationMs: 5,
    timedOut: false,
    isolation: { version: 1, provider: "bwrap" }
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("validator evidence binding (Unit 4)", () => {
  it("B-D4: external validator persists bounded stdout so reporter extraction never depends on file I/O alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d4-"));
    roots.push(root);
    const report = { suites: [{ title: "s", specs: [{ title: "alpha passing", tests: [{ results: [{ status: "passed" }] }] }] }] };
    const check = await runExternalToolValidator({
      root,
      config: baseConfig(),
      contract,
      spec: { id: "ext-mutation", adapter: "mutation", command: `node -e 'console.log(${JSON.stringify(JSON.stringify(report))})'`, required: true },
      baseRef: "HEAD",
      changedFiles: []
    });
    const details = (check.details ?? {}) as Record<string, unknown>;
    expect(typeof details.stdout).toBe("string");
    expect(String(details.stdout)).toContain("alpha passing");
    expect(typeof details.rawArtifact).toBe("string");
    // Extraction succeeds from details.stdout even when the raw file is gone.
    const tests = await extractReporterTestsFromExecutionV1(root, { ...check, details: { ...details, rawArtifact: undefined } });
    expect(tests?.length).toBe(1);
    expect(tests?.[0]?.title).toContain("alpha passing");
  });

  it("B-D4: pact JUnit stdout is preserved and parses to contract findings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d4junit-"));
    roots.push(root);
    const junit = `<testsuite name="contract"><testcase classname="c" name="pact one"><failure message="mismatch">expected 200 got 500</failure></testcase></testsuite>`;
    const check = await runExternalToolValidator({
      root,
      config: baseConfig(),
      contract,
      spec: { id: "ext-pact", adapter: "pact", command: `node -e 'process.stdout.write(${JSON.stringify(junit)})'`, required: true },
      baseRef: "HEAD",
      changedFiles: []
    });
    const details = (check.details ?? {}) as Record<string, unknown>;
    expect(typeof details.stdout).toBe("string");
    expect(String(details.stdout)).toContain("<testsuite");
    const parsed = parseToolEvidenceResult("pact", String(details.stdout));
    expect(parsed.valid).toBe(true);
    expect(parsed.findings.length).toBeGreaterThan(0);
    // A failing contract finding still fails closed for a required validator.
    expect(check.status).toBe("FAIL");
  });

  it("B-D1: isolated external validator threads the candidate binding through the sandbox allowlist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d1-"));
    roots.push(root);
    const candidate = { candidateId: "CAND-U4", revision: 1, identityDigest: "a".repeat(64) } as never;
    await runExternalToolValidator({
      root,
      config: isolatedConfig(),
      contract,
      spec: { id: "ext-iso", adapter: "mutation", command: "echo hi", required: true },
      baseRef: "HEAD",
      changedFiles: [],
      candidate
    });
    expect(state.runIsolatedCommand).toHaveBeenCalledTimes(1);
    const [request, options] = state.runIsolatedCommand.mock.calls[0] as [
      { environment?: Record<string, string> },
      { environmentAllowlist?: string[] }
    ];
    expect(request.environment?.AEH_VALIDATION_CANDIDATE_JSON).toBe(JSON.stringify(candidate));
    expect(options.environmentAllowlist).toContain("AEH_VALIDATION_CANDIDATE_JSON");
  });

  it("B-D1: no candidate means no candidate variable in the sandbox environment or allowlist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d1none-"));
    roots.push(root);
    await runExternalToolValidator({
      root,
      config: isolatedConfig(),
      contract,
      spec: { id: "ext-iso-none", adapter: "mutation", command: "echo hi", required: true },
      baseRef: "HEAD",
      changedFiles: []
    });
    expect(state.runIsolatedCommand).toHaveBeenCalledTimes(1);
    const [request, options] = state.runIsolatedCommand.mock.calls[0] as [
      { environment?: Record<string, string> },
      { environmentAllowlist?: string[] }
    ];
    expect(request.environment?.AEH_VALIDATION_CANDIDATE_JSON).toBeUndefined();
    expect(options.environmentAllowlist ?? []).not.toContain("AEH_VALIDATION_CANDIDATE_JSON");
  });

  it("B-D2: every validator kind shares one writable policy (evidence dir only, never the workspace root)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d2-"));
    roots.push(root);
    const config = isolatedConfig();
    const evidenceDir = path.resolve(root, ".harness/evidence");
    await runValidationCommand(root, { id: "c", command: "echo hi", required: true }, { config });
    const commandPaths = (state.runIsolatedCommand.mock.calls[0][0] as { writablePaths: string[] }).writablePaths;
    state.runIsolatedCommand.mockClear();
    await runSpecCommand(
      { root, config, contract, spec: { id: "s", adapter: "command", command: "echo hi", required: true }, baseRef: "HEAD", changedFiles: [] },
      "echo hi",
      "custom"
    );
    const specPaths = (state.runIsolatedCommand.mock.calls[0][0] as { writablePaths: string[] }).writablePaths;
    state.runIsolatedCommand.mockClear();
    await runExternalToolValidator({
      root, config, contract,
      spec: { id: "e", adapter: "mutation", command: "echo hi", required: true },
      baseRef: "HEAD", changedFiles: []
    });
    const externalPaths = (state.runIsolatedCommand.mock.calls[0][0] as { writablePaths: string[] }).writablePaths;
    expect([...commandPaths].sort()).toEqual([evidenceDir]);
    expect([...specPaths].sort()).toEqual([evidenceDir]);
    expect([...externalPaths].sort()).toEqual([evidenceDir]);
  });

  it("B-D2: a declared in-workspace evidenceFile adds exactly its directory, and an escaping path adds nothing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d2ef-"));
    roots.push(root);
    const config = isolatedConfig();
    const evidenceDir = path.resolve(root, ".harness/evidence");
    await runExternalToolValidator({
      root, config, contract,
      spec: { id: "e-ef", adapter: "mutation", command: "echo hi", required: true, options: { evidenceFile: "reports/out.json" } },
      baseRef: "HEAD", changedFiles: []
    });
    const withFile = (state.runIsolatedCommand.mock.calls[0][0] as { writablePaths: string[] }).writablePaths;
    expect([...withFile].sort()).toEqual([evidenceDir, path.resolve(root, "reports")].sort());
    state.runIsolatedCommand.mockClear();
    await runExternalToolValidator({
      root, config, contract,
      spec: { id: "e-escape", adapter: "mutation", command: "echo hi", required: true, options: { evidenceFile: "../outside/out.json" } },
      baseRef: "HEAD", changedFiles: []
    });
    const escaped = (state.runIsolatedCommand.mock.calls[0][0] as { writablePaths: string[] }).writablePaths;
    expect([...escaped].sort()).toEqual([evidenceDir]);
  });

  it("B-D6: assembler patch accounting shares the provider-generated excludes with DIRECT (generated scratch never counts)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-u4-d6-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, ".serena"), { recursive: true });
    await fs.mkdir(path.join(root, "graphify-out"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, ".serena", "scratch.json"), '{"v":1}\n');
    await fs.writeFile(path.join(root, "graphify-out", "graph.json"), '{"v":1}\n');
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
    const current = createCandidateRevisionV1({
      operationId: "OP-D6", candidateId: "candidate:OP-D6:r1", taskId: "TASK-D6",
      revision: 1, sourceDigest: await computeWorktreeDigest(root)
    });
    // Worker regenerates provider scratch alongside the product change.
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    await fs.writeFile(path.join(root, ".serena", "scratch.json"), '{"v":2}\n');
    await fs.writeFile(path.join(root, "graphify-out", "graph.json"), '{"v":2}\n');
    const patch = (await runShell("git diff --binary HEAD --", { cwd: root })).stdout;
    expect(patch).toContain("graphify-out");
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, ".serena", "scratch.json"), '{"v":1}\n');
    await fs.writeFile(path.join(root, "graphify-out", "graph.json"), '{"v":1}\n');
    // Declared product scope only: succeeds because generated scratch is
    // excluded from observed patch paths, exactly like DIRECT ChangeSets.
    const changeSet = {
      version: 1 as const, operationId: "OP-D6", taskId: "TASK-D6", workUnitId: "WU-1", participantId: "participant:WU-1",
      baseCandidateRevision: 1, baseCandidateDigest: current.identityDigest,
      changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8(patch)
    };
    const result = await assembleCandidateChangeSet({
      root, operationId: "OP-D6", taskId: "TASK-D6", currentCandidate: current,
      changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-D6:r2"
    });
    expect(result.candidate.revision).toBe(2);
    expect(result.changeSet.changedFiles).toEqual(["src/value.ts"]);
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toContain("value = 2");
  });
});
