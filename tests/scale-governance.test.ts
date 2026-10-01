import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrganizationPolicyBundles, withOrganizationPolicies } from "../src/policy/bundles.js";
import { aggregateVariant, summarize, wilson } from "../src/evals/statistics.js";
import { submitDistributedJob, claimDistributedJob, completeDistributedJob, serveDistributedQueue, waitForDistributedResult, publishDistributedSessionReady, waitForDistributedSessionReady, releaseDistributedExecutionBinding, waitForDistributedExecutionRelease } from "../src/distributed/queue.js";
import { benchmarkMcpCatalog, resolveMcpPack } from "../src/mcp/benchmark.js";
import { extractMarkedJson } from "../src/agents/structuredOutput.js";
import { outputJsonSchema, plannerOutputSchema } from "../src/agents/outputContracts.js";
import type { DistributedDelegationJob, DistributedDelegationResult } from "../src/distributed/types.js";
import { sandboxPolicyDigest } from "../src/security/sandbox.js";
import { validateDistributedSandboxPolicy } from "../src/distributed/worker.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { EvalResult } from "../src/evals/types.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, createExecutionBlueprintV2 } from "../src/architecture/executionIdentity.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import { roleProfile } from "../src/participants/index.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCapabilityLease } from "../src/security/authorityV2.js";
import { createPromptManifest } from "../src/context/runtimeV2.js";

function sha(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function distributedSessionProtocolFixture(root: string, config: HarnessProjectConfig, jobId: string) {
  const operationId = `op-${jobId}`;
  const participantId = `participant-${jobId}`;
  const baseCandidate = createCandidateRevisionV1({ operationId, candidateId: `candidate-${jobId}`, revision: 1, sourceDigest: "a".repeat(64) });
  const selection = { logicalAgent: "worker", role: "Implementer", domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "worker", modelId: "provider/model", modelName: "model", modelProvider: "provider", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" }, args: [], runtimeCapabilities: {} } as never;
  const executionBlueprint = { digest: sha256Canonical(`${jobId}:blueprint`) } as never;
  const roleInvocationPolicy = { digest: sha256Canonical(`${jobId}:role`), participantId, outputContract: "implementer" } as never;
  const skillManifest = { digest: sha256Canonical(`${jobId}:skill`) } as never;
  const contextManifest = { version: 1, operationId, projectId: "test", fragments: [{ id: `${jobId}:context` }] };
  const contextManifestDigest = sha256Canonical(contextManifest);
  const promptManifestDigest = createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: "do work", role: "Implementer", source: "agent-prompt-projection" }] }).digest;
  const executionAuthority = { operationId, participantId, candidateDigest: baseCandidate.identityDigest, controllerEpoch: 0, leases: [] } as never;
  const job: DistributedDelegationJob = {
    version: 2, id: jobId, parentTaskId: jobId, createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "a".repeat(40), baseCandidate, candidatePatch: "",
    task: {} as never, contract: { version: 1, task: { id: jobId, title: jobId } }, selection, sandboxPolicySha256: "sandbox", executionAuthority, executionBlueprint, roleInvocationPolicy, skillManifest,
    sessionPreparation: { contextManifest, contextManifestDigest, promptManifestDigest }, config, prompt: "do work"
  };
  const executionBinding = compileExecutionBinding({ operationId, operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: baseCandidate.identityDigest, controllerEpoch: 0,
    executionBlueprintDigest: executionBlueprint.digest, operationPolicyDigest: sha256Canonical(`${jobId}:policy`), participantId, participantGeneration: `generation-${jobId}`,
    roleInvocationPolicyDigest: roleInvocationPolicy.digest, skillManifestDigest: skillManifest.digest,
    runtime: { runtimeId: "opencode", provider: "provider", modelId: "provider/model", model: "model", sessionId: `provider-session-${jobId}` },
    contextManifestDigest, promptManifestDigest, outputContract: "implementer", leaseIdentities: [] });
  return { job, executionBinding };
}

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
      const baseCandidate = createCandidateRevisionV1({ operationId: "op-1", candidateId: "candidate-1", revision: 1, sourceDigest: "a".repeat(64) });
      const queueContextManifest = { version: 1, operationId: "op-1", fragments: [{ id: "queue-context" }] };
      const queuePromptManifestDigest = createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: "do it", role: "implementer", source: "agent-prompt-projection" }] }).digest;
      const job: DistributedDelegationJob = { version: 2, id: "J-1", parentTaskId: "T", createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "abc", baseCandidate, candidatePatch: "", task: { id: "A", summary: "a", agent: "worker", scope: ["src/a.ts"], dependencies: [], acceptance: ["REQ-1"], risk: "low" }, contract: { version: 1, task: { id: "T", title: "t" } }, selection: { logicalAgent: "worker", role: "implementer", domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "w", modelId: "p/m", modelName: "m", modelProvider: "p", transport: "direct", skills: [], mcps: [], permissions: {}, args: [], runtimeCapabilities: {} }, sandboxPolicySha256: "", executionAuthority: {} as never, executionBlueprint: {} as never, roleInvocationPolicy: {} as never, skillManifest: {} as never, sessionPreparation: { contextManifest: queueContextManifest, contextManifestDigest: sha256Canonical(queueContextManifest), promptManifestDigest: queuePromptManifestDigest }, config, prompt: "do it" };
      job.sandboxPolicySha256 = sandboxPolicyDigest(config, job.selection, job.task.risk);
      await submitDistributedJob(root, config, job); const claimed = await claimDistributedJob(root, config, "W-1"); expect(claimed?.job.id).toBe("J-1");
      const result: DistributedDelegationResult = { version: 2, jobId: "J-1", workerId: "W-1", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "PASS", session: { provider: "opencode", exitCode: 0, stdout: "ok", stderr: "" }, changedFiles: ["src/a.ts"], patch: "patch" };
      await completeDistributedJob(root, config, claimed!.leaseId, result); expect((await waitForDistributedResult(root, config, "J-1", 100)).status).toBe("PASS");
      await submitDistributedJob(root, config, { ...job, id: "J-2" }); const claimed2 = await claimDistributedJob(root, config, "W-2");
      await expect(completeDistributedJob(root, config, claimed2!.leaseId, { ...result, jobId: "J-2", workerId: "forged-worker" })).rejects.toThrow("DISTRIBUTED_QUEUE_LEASE_OWNER_MISMATCH");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("freezes a distributed binding only after the filesystem worker prepares its actual runtime session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-queue-session-protocol-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, distributed: { enabled: true, provider: "filesystem", queueDir: ".harness/distributed", pollIntervalMs: 5 } };
      const { job, executionBinding } = distributedSessionProtocolFixture(root, config, "J-SESSION-FS");
      await submitDistributedJob(root, config, job);
      const claimed = await claimDistributedJob(root, config, "worker-session-fs");
      const ready = { version: 1 as const, jobId: job.id, workerId: "worker-session-fs", leaseId: claimed!.leaseId, preparedAt: new Date().toISOString(), runtime: executionBinding.runtime, contextManifestDigest: job.sessionPreparation.contextManifestDigest, promptManifestDigest: job.sessionPreparation.promptManifestDigest, sessionPreparation: "RUNTIME_MATERIALIZED" as const };
      await publishDistributedSessionReady(root, config, ready);
      await expect(waitForDistributedSessionReady(root, config, job.id, 100)).resolves.toEqual(ready);
      const release = { version: 1 as const, jobId: job.id, workerId: "worker-session-fs", leaseId: claimed!.leaseId, releasedAt: new Date().toISOString(), executionBinding };
      await releaseDistributedExecutionBinding(root, config, release);
      await expect(waitForDistributedExecutionRelease(root, config, job.id, "worker-session-fs", claimed!.leaseId, 100)).resolves.toEqual(release);
      const { version: _version, digest: _digest, ...bindingBody } = executionBinding;
      const replay = { ...release, executionBinding: compileExecutionBinding({ ...bindingBody, runtime: { ...executionBinding.runtime, sessionId: "different-provider-session" } }) };
      await expect(releaseDistributedExecutionBinding(root, config, replay)).rejects.toThrow("DISTRIBUTED_EXECUTION_RELEASE_IDENTITY_MISMATCH");
      await expect(submitDistributedJob(root, config, { ...job, version: 1 } as never)).rejects.toThrow("UNSUPPORTED_DISTRIBUTED_JOB_VERSION");
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
      const workerConfig: HarnessProjectConfig = { ...config, distributed: { ...config.distributed, provider: "http", endpoint, pollIntervalMs: 5 } };
      const { job, executionBinding } = distributedSessionProtocolFixture(root, workerConfig, "J-http-session");
      await submitDistributedJob(root, workerConfig, job);
      const claimed = await claimDistributedJob(root, workerConfig, "worker-http");
      expect(claimed?.job.id).toBe(job.id);
      const ready = { version: 1 as const, jobId: job.id, workerId: "worker-http", leaseId: claimed!.leaseId, preparedAt: new Date().toISOString(), runtime: executionBinding.runtime, contextManifestDigest: job.sessionPreparation.contextManifestDigest, promptManifestDigest: job.sessionPreparation.promptManifestDigest, sessionPreparation: "RUNTIME_MATERIALIZED" as const };
      await publishDistributedSessionReady(root, workerConfig, ready);
      await expect(waitForDistributedSessionReady(root, workerConfig, job.id, 100)).resolves.toEqual(ready);
      const release = { version: 1 as const, jobId: job.id, workerId: "worker-http", leaseId: claimed!.leaseId, releasedAt: new Date().toISOString(), executionBinding };
      await releaseDistributedExecutionBinding(root, workerConfig, release);
      await expect(waitForDistributedExecutionRelease(root, workerConfig, job.id, "worker-http", claimed!.leaseId, 100)).resolves.toEqual(release);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.AEH_TEST_QUEUE_TOKEN; else process.env.AEH_TEST_QUEUE_TOKEN = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects distributed jobs with tampered or weakened sandbox policy", () => {
    const config: HarnessProjectConfig = { version: 1, project: { name: "sandbox-test" }, security: { sandbox: { required: true, provider: "podman", image: "aeh:test" } } };
    const operationId = "op-sandbox";
    const candidate = createCandidateRevisionV1({ operationId, candidateId: "candidate-sandbox", projectId: "project:sandbox", taskId: "T", revision: 1, sourceDigest: "a".repeat(64) });
    const participantId = "participant:worker";
    const selection = { logicalAgent: "worker", role: "Implementer" as const, domains: ["*"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "w", modelId: "p/m", modelName: "m", modelProvider: "p", transport: "direct" as const, skills: [], mcps: [], permissions: { read: "allow" as const, write: "allow" as const, shell: "allow" as const, network: "deny" as const, delegate: "deny" as const }, outputContract: "implementer", args: [], runtimeCapabilities: {} };
    const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: 0, intent: "sandbox test", route: "DELEGATED", minimumAssurance: "STANDARD", policyVersions: { policy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
    const roleInvocationPolicy = compileRoleInvocationPolicy({ operationId, operationPolicyDigest: policy.digest, participantId, role: "Implementer", workUnitIds: ["A"], scope: ["src/a.ts"], competencies: [], toolPack: roleProfile("Implementer").toolPack, resourceClaims: [], outputContract: "implementer", constraints: {} });
    const skillManifest = compileSkillManifest({ scope: { operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: 0, participantId, workUnitIds: ["A"], competencies: [] }, skills: [] });
    const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: sha256Canonical({}) };
    const executionBlueprint = createExecutionBlueprintV2({ projectId: candidate.projectId!, operationId, operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: candidate.identityDigest, controllerEpoch: 0, resolvedOperationPolicy: policy, workGraph: createWorkGraph({ taskId: "T", objective: "t", route: "DELEGATED", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] }), participantPlan: { version: 1, taskId: "T", assignments: [participantId] }, executionCatalog: { version: 1 }, participants: [{ participantId, role: "Implementer", specialization: "general", roleInvocationPolicy, toolPack: roleInvocationPolicy.toolPack, resourceClaims: [], validationResolution, outputContract: "implementer", skillManifestDigest: skillManifest.digest }], validationResolution });
    const issuedAt = new Date();
    const lease = createCapabilityLease({ version: 1, requestId: "request:sandbox-read", operationId, participantId, projectId: candidate.projectId, candidate, capability: "read", requestedEnvelope: { version: 1, level: 50, capabilities: ["read"] }, requestedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString() }, { operationId, projectId: candidate.projectId, candidate, now: issuedAt });
    const executionAuthority = { version: 1 as const, operationId, participantId, projectId: candidate.projectId, candidateRevision: candidate, candidateDigest: candidate.identityDigest, controllerEpoch: 0, leases: [lease] };
    const contextManifest = { version: 1, operationId: "OP-SANDBOX", fragments: [{ id: "sandbox-context" }] };
    const job = { version: 2 as const, id: "J-SANDBOX", parentTaskId: "T", createdAt: new Date().toISOString(), repositoryUrl: "https://example.invalid/repo.git", baseRef: "a".repeat(40), baseCandidate: candidate, candidatePatch: "", task: { id: "A", objective: "a", scope: ["src/a.ts"], dependencies: [], requirementRefs: [], acceptanceRefs: ["REQ-1"], competencies: [], riskTags: [], changeKinds: ["source"] as const, risk: "low" as const, resourceClaims: [] }, contract: { version: 1 as const, task: { id: "T", title: "t" } }, selection, sandboxPolicySha256: sandboxPolicyDigest(config, selection, "low"), executionAuthority, executionBlueprint, roleInvocationPolicy, skillManifest, sessionPreparation: { contextManifest, contextManifestDigest: sha256Canonical(contextManifest), promptManifestDigest: createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: "do it", role: selection.role, source: "agent-prompt-projection" }] }).digest }, config, prompt: "do it" } satisfies DistributedDelegationJob;
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
    const payload = { workUnits: [], affectedAreas: [], reviewDimensions: [], validationRequirements: [], outOfScopeImprovements: [] };
    const stdout = `${JSON.stringify({ type: "event", session_id: "s1" })}\nAEH_RESULT_JSON=${JSON.stringify(payload)}\n`;
    expect(plannerOutputSchema.parse(extractMarkedJson(stdout))).toEqual(payload); expect(outputJsonSchema("planner")?.type).toBe("object");
  });

  it("keeps planner native required fields aligned with Zod defaults", () => {
    const schema = outputJsonSchema("planner");
    expect(schema?.required).toEqual(["workUnits", "affectedAreas", "reviewDimensions", "validationRequirements", "outOfScopeImprovements"]);
    expect(plannerOutputSchema.parse({ workUnits: [] })).toEqual({
      workUnits: [],
      affectedAreas: [],
      reviewDimensions: [],
      validationRequirements: [],
      outOfScopeImprovements: []
    });
  });
});
