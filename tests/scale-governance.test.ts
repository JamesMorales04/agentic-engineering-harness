import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrganizationPolicyBundles, withOrganizationPolicies } from "../src/policy/bundles.js";
import { aggregateVariant, summarize, wilson } from "../src/evals/statistics.js";
import { submitDistributedJob, claimDistributedJob, completeDistributedJob, serveDistributedQueue, waitForDistributedResult } from "../src/distributed/queue.js";
import { benchmarkMcpCatalog, resolveMcpPack } from "../src/mcp/benchmark.js";
import { extractMarkedJson } from "../src/agents/structuredOutput.js";
import { outputJsonSchema, plannerOutputSchema } from "../src/agents/outputContracts.js";
import type { DistributedDelegationJob, DistributedDelegationResult } from "../src/distributed/types.js";
import { sandboxPolicyDigest } from "../src/security/sandbox.js";
import { validateDistributedSandboxPolicy } from "../src/distributed/worker.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { EvalResult } from "../src/evals/types.js";

function sha(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

describe("v0.5 scale and governance", () => {
  it("verifies and inherits local organization policy bundles by content hash", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-policy-"));
    try {
      const baseDir = path.join(root, "org", "base"); const childDir = path.join(root, "org", "child"); await fs.mkdir(path.join(baseDir, "policies"), { recursive: true }); await fs.mkdir(path.join(childDir, "policies"), { recursive: true });
      const basePolicy = Buffer.from("package org.base\ndefault allow := true\n"); const childPolicy = Buffer.from("package org.child\ndefault allow := true\n"); await fs.writeFile(path.join(baseDir, "policies", "base.rego"), basePolicy); await fs.writeFile(path.join(childDir, "policies", "child.rego"), childPolicy);
      const baseManifest = Buffer.from(JSON.stringify({ version: 1, name: "base", policyDirs: ["policies"], files: [{ path: "policies/base.rego", sha256: sha(basePolicy) }] })); const childManifest = Buffer.from(JSON.stringify({ version: 1, name: "child", extends: ["base"], policyDirs: ["policies"], files: [{ path: "policies/child.rego", sha256: sha(childPolicy) }] })); await fs.writeFile(path.join(baseDir, "bundle.json"), baseManifest); await fs.writeFile(path.join(childDir, "bundle.json"), childManifest);
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, organization: { policyBundles: { cacheDir: ".harness/policy-bundles", sources: [{ name: "base", path: "org/base", sha256: sha(baseManifest) }, { name: "child", path: "org/child", sha256: sha(childManifest) }] } } };
      const resolution = await resolveOrganizationPolicyBundles(root, config);
      expect(resolution.bundles.map((bundle) => bundle.name)).toEqual(["base", "child"]);
      expect(resolution.policyDirs).toHaveLength(2);
      const effective = withOrganizationPolicies(config, resolution);
      expect(effective.validation?.opa?.enabled).toBe(true);
      expect(effective.validation?.opa?.policyDirs).toHaveLength(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("computes repeated-run statistics and Wilson confidence intervals", () => {
    const metric = summarize([10, 12, 14, 16, 18]); expect(metric.mean).toBe(14); expect(metric.median).toBe(14); expect(metric.confidence.low).toBeLessThan(metric.mean); expect(metric.confidence.high).toBeGreaterThan(metric.mean);
    const pass = wilson(8, 10); expect(pass.low).toBeGreaterThan(0); expect(pass.high).toBeLessThanOrEqual(1);
    const results = [0, 1, 2].map((index): EvalResult => ({ version: 1, caseId: "E", variant: "v", taskId: "T", baseRef: "main", status: index === 2 ? "FAIL" : "PASS", commandExitCode: index === 2 ? 1 : 0, score: 100 - index * 10, scoreBreakdown: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), metrics: { firstPassSuccess: index === 0, repairCount: index, humanInterventions: 0, durationMs: 100 + index, usage: { totalTokens: 1000 + index } } }));
    const aggregate = aggregateVariant("v", results); expect(aggregate.runs).toBe(3); expect(aggregate.passRate).toBeCloseTo(2 / 3); expect(aggregate.repairs?.mean).toBe(1);
  });

  it("leases filesystem distributed jobs and returns completed results", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-queue-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, distributed: { enabled: true, provider: "filesystem", queueDir: ".harness/distributed", leaseSeconds: 60, pollIntervalMs: 5 } };
      const job: DistributedDelegationJob = { version: 1, id: "J-1", parentTaskId: "T", createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "abc", priorPatches: [], task: { id: "A", summary: "a", agent: "worker", scope: ["src/a.ts"], dependencies: [], acceptance: ["REQ-1"], risk: "low" }, contract: { version: 1, task: { id: "T", title: "t" } }, selection: { logicalAgent: "worker", role: "implementer", domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "w", modelId: "p/m", modelName: "m", modelProvider: "p", transport: "direct", skills: [], mcps: [], permissions: {}, args: [], runtimeCapabilities: {} }, sandboxPolicySha256: "", config, prompt: "do it" };
      job.sandboxPolicySha256 = sandboxPolicyDigest(config, job.selection, job.task.risk);
      await submitDistributedJob(root, config, job); const claimed = await claimDistributedJob(root, config, "W-1"); expect(claimed?.job.id).toBe("J-1");
      const result: DistributedDelegationResult = { version: 1, jobId: "J-1", workerId: "W-1", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "PASS", session: { provider: "opencode", exitCode: 0, stdout: "ok", stderr: "" }, changedFiles: ["src/a.ts"], patch: "patch" };
      await completeDistributedJob(root, config, claimed!.leaseId, result); expect((await waitForDistributedResult(root, config, "J-1", 100)).status).toBe("PASS");
      await submitDistributedJob(root, config, { ...job, id: "J-2" }); const claimed2 = await claimDistributedJob(root, config, "W-2");
      await expect(completeDistributedJob(root, config, claimed2!.leaseId, { ...result, jobId: "J-2", workerId: "forged-worker" })).rejects.toThrow("DISTRIBUTED_QUEUE_LEASE_OWNER_MISMATCH");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("requires authentication even on a loopback HTTP queue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-http-queue-"));
    const previous = process.env.AEH_TEST_QUEUE_TOKEN;
    process.env.AEH_TEST_QUEUE_TOKEN = "queue-secret";
    const config: HarnessProjectConfig = { version: 1, project: { name: "http-test" }, distributed: { enabled: true, provider: "filesystem", queueDir: ".harness/distributed", tokenEnv: "AEH_TEST_QUEUE_TOKEN" } };
    const server = await serveDistributedQueue(root, config, { port: 0, host: "127.0.0.1" });
    try {
      const address = server.address(); expect(address).toBeTruthy();
      const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const unauthorized = await fetch(`${endpoint}/v1/jobs`, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);
      const authorized = await fetch(`${endpoint}/v1/jobs`, { method: "POST", headers: { authorization: "Bearer queue-secret", "content-type": "application/json" }, body: JSON.stringify({ version: 1, id: "J-http", parentTaskId: "T", createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "abc", priorPatches: [], task: { id: "A", summary: "a", agent: "worker", scope: ["src/a.ts"], dependencies: [], acceptance: ["REQ-1"], risk: "low" }, contract: { version: 1, task: { id: "T", title: "t" } }, selection: {}, sandboxPolicySha256: "", config, prompt: "do it" }) });
      expect(authorized.status).toBe(202);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.AEH_TEST_QUEUE_TOKEN; else process.env.AEH_TEST_QUEUE_TOKEN = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects distributed jobs with tampered or weakened sandbox policy", () => {
    const config: HarnessProjectConfig = { version: 1, project: { name: "sandbox-test" }, security: { sandbox: { required: true, provider: "podman", image: "aeh:test" } } };
    const selection = { logicalAgent: "worker", role: "implementer", domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "w", modelId: "p/m", modelName: "m", modelProvider: "p", transport: "direct" as const, skills: [], mcps: [], permissions: {}, args: [], runtimeCapabilities: {} };
    const job = { version: 1 as const, id: "J-SANDBOX", parentTaskId: "T", createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "abc", priorPatches: [], task: { id: "A", summary: "a", agent: "worker", scope: ["src/a.ts"], dependencies: [], acceptance: ["REQ-1"], risk: "low" as const }, contract: { version: 1 as const, task: { id: "T", title: "t" } }, selection, sandboxPolicySha256: sandboxPolicyDigest(config, selection, "low"), config, prompt: "do it" } satisfies DistributedDelegationJob;
    expect(() => validateDistributedSandboxPolicy(job, config)).toThrow("DISTRIBUTED_SANDBOX_POLICY_WEAKENED");
    expect(() => validateDistributedSandboxPolicy({ ...job, sandboxPolicySha256: "0".repeat(64) }, config)).toThrow("DISTRIBUTED_SANDBOX_POLICY_TAMPERED");
  });

  it("benchmarks an MCP catalog and resolves least-privilege packs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-mcp-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, mcp: { servers: { nodeprobe: { type: "local", command: ["node"], description: "local test server" } }, packs: { research: { servers: ["nodeprobe"], enabled: true } }, benchmark: { resultsDir: ".harness/mcp-benchmarks", repetitions: 1 } } };
      expect(resolveMcpPack(config, "research")).toEqual(["nodeprobe"]); const report = await benchmarkMcpCatalog(root, config); expect(report.results[0].available).toBe(true); expect(report.results[0].baselineConfigTokens).toBeGreaterThan(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("prefers explicit structured markers over runtime event JSON and exposes JSON schemas", () => {
    const payload = { tasks: [], affectedAreas: [], requiredReviewers: [], validationGates: [], fallbackRouting: [], outOfScopeImprovements: [] };
    const stdout = `${JSON.stringify({ type: "event", session_id: "s1" })}\nAEH_RESULT_JSON=${JSON.stringify(payload)}\n`;
    expect(plannerOutputSchema.parse(extractMarkedJson(stdout))).toEqual(payload); expect(outputJsonSchema("planner")?.type).toBe("object");
  });

  it("keeps planner native required fields aligned with Zod defaults", () => {
    const schema = outputJsonSchema("planner");
    expect(schema?.required).toEqual(["tasks"]);
    expect(plannerOutputSchema.parse({ tasks: [] })).toEqual({
      tasks: [],
      affectedAreas: [],
      requiredReviewers: [],
      validationGates: [],
      fallbackRouting: [],
      outOfScopeImprovements: []
    });
  });
});
