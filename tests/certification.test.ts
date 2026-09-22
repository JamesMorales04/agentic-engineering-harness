import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CertificationCore, type AgentProvider } from "../src/certification/core.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCertificationOracleResult, oracleCanAccept } from "../src/certification/oracle.js";
import { defaultCertificationPolicy } from "../src/certification/policy.js";
import { buildProviderEnvironment, executeArgv, LocalAgentProvider, parseJsonl } from "../src/certification/provider.js";
import { codexCommandPreview, resolveCodexCapabilities } from "../src/certification/codex.js";
import { createCommandOracle } from "../src/certification/bootstrap.js";
import type { AgentProviderRequest, AgentProviderResult, CandidateRevision, CertificationOracle, CertificationPolicy } from "../src/certification/types.js";

function policy(overrides: Partial<CertificationPolicy> = {}): CertificationPolicy {
  return defaultCertificationPolicy({
    ...overrides,
    assurance: { ...defaultCertificationPolicy().assurance, ...overrides.assurance },
    budget: { ...defaultCertificationPolicy().budget, ...overrides.budget },
    repair: { ...defaultCertificationPolicy().repair, ...overrides.repair },
    review: { ...defaultCertificationPolicy().review, ...overrides.review },
    security: { ...defaultCertificationPolicy().security, ...overrides.security }
  });
}

async function candidate(): Promise<{ root: string; value: CandidateRevision }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cert-test-"));
  await fs.writeFile(path.join(root, "state.txt"), "bad\n");
  return { root, value: { version: 1, id: "candidate-1", root, sourceDigest: await computeWorktreeDigest(root) } };
}

function oracleForFile(expected: string): CertificationOracle {
  return { id: "fixture-oracle", independent: true, async evaluate({ candidate: revision }) {
    const actual = await fs.readFile(path.join(revision.root, "state.txt"), "utf8");
    return createCertificationOracleResult({ oracleId: "fixture-oracle", checks: [{ id: "state", status: actual === expected ? "PASS" : "FAIL", required: true, message: actual === expected ? "state accepted" : `expected ${expected} but found ${actual}` }] });
  } };
}

function providerResult(request: AgentProviderRequest, status: AgentProviderResult["status"] = "COMPLETED"): AgentProviderResult {
  return { version: 1, provider: "test-provider", requestId: request.requestId, role: request.role, status, exitCode: status === "COMPLETED" ? 0 : 1, stdout: "{\"type\":\"result\"}\n", stderr: "", events: [], structuredOutput: { type: "result" }, usage: { totalTokens: 3 }, usageKnown: true, durationMs: 1, outputTruncated: false };
}

/** Resolve the Codex CLI executable from CODEX_BIN or PATH so the capability test is portable across developer and CI environments. */
async function resolveCodexBinary(): Promise<string | undefined> {
  const explicit = process.env.CODEX_BIN?.trim();
  if (explicit) return explicit;
  const names = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* keep searching */ }
    }
  }
  return undefined;
}

describe("CertificationCore", () => {
  it("rejects a workspace that no longer materializes its candidate before oracle execution", async () => {
    const fixture = await candidate();
    let oracleCalls = 0;
    const oracle: CertificationOracle = { id: "identity-oracle", independent: true, async evaluate() { oracleCalls += 1; return createCertificationOracleResult({ oracleId: "identity-oracle", checks: [{ id: "state", status: "PASS", required: true, message: "accepted" }] }); } };
    await fs.writeFile(path.join(fixture.root, "state.txt"), "changed after candidate binding\n");
    try {
      await expect(new CertificationCore(oracle).certify({ candidate: fixture.value, policy: policy() })).rejects.toThrow("CANDIDATE_WORKSPACE_MISMATCH");
      expect(oracleCalls).toBe(0);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("accepts only deterministic oracle evidence and does not need a provider", async () => {
    const fixture = await candidate();
    try {
      const result = await new CertificationCore(oracleForFile("bad\n")).certify({ candidate: fixture.value, policy: policy() });
      expect(result.state).toBe("ACCEPTED");
      expect(result.accepted).toBe(true);
      expect(result.assurance).toBe("DETERMINISTIC");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("cannot turn a provider failure into a PASS", async () => {
    const fixture = await candidate();
    const provider: AgentProvider = { name: "failure", networkIsolation: "enforced", async execute(request) { return providerResult(request, "FAILED"); } };
    try {
      const request: AgentProviderRequest = { version: 1, requestId: "actor-1", role: "actor", prompt: "act", cwd: fixture.root, command: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false };
      const result = await new CertificationCore(oracleForFile("bad\n"), provider).certify({ candidate: fixture.value, policy: policy(), actor: request });
      expect(result.state).toBe("HUMAN_REQUIRED");
      expect(result.accepted).toBe(false);
      expect(result.failurePacket?.reason).toBe("PROVIDER_FAILURE");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects model observations after the actor changes the bound candidate workspace", async () => {
    const fixture = await candidate();
    let oracleCalls = 0;
    const oracle: CertificationOracle = { id: "identity-after-actor", independent: true, async evaluate() { oracleCalls += 1; return createCertificationOracleResult({ oracleId: "identity-after-actor", checks: [{ id: "state", status: "PASS", required: true, message: "accepted" }] }); } };
    const provider: AgentProvider = { name: "mutating-actor", networkIsolation: "enforced", async execute(request) { await fs.writeFile(path.join(fixture.root, "state.txt"), "actor changed source\n"); return providerResult(request); } };
    const actor: AgentProviderRequest = { version: 1, requestId: "actor-mutates-candidate", role: "actor", prompt: "act", cwd: fixture.root, command: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false };
    try {
      const result = await new CertificationCore(oracle, provider).certify({ candidate: fixture.value, policy: policy(), actor });
      expect(result.accepted).toBe(false);
      expect(result.oracle.failures.some((failure) => failure.message.includes("CANDIDATE_WORKSPACE_MISMATCH"))).toBe(true);
      expect(oracleCalls).toBe(0);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not certify an in-place repair under the prior CandidateRevision", async () => {
    const fixture = await candidate();
    const provider: AgentProvider = { name: "repair", networkIsolation: "enforced", async execute(request) { await fs.writeFile(path.join(fixture.root, "state.txt"), "good\n"); return providerResult(request); } };
    try {
      const result = await new CertificationCore(oracleForFile("good\n"), provider).certify({
        candidate: fixture.value,
        policy: policy({ budget: { maxAttempts: 1, maxDurationMs: 10_000 }, repair: { enabled: true, maxAttempts: 1, humanOnExhaustion: true } }),
        repair: { create: (attempt, failures, revision) => ({ version: 1, requestId: `repair-${attempt}`, role: "repair", prompt: failures[0]?.message ?? "repair", cwd: revision.root, command: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false }) }
      });
      expect(result.state).toBe("BLOCKED");
      expect(result.accepted).toBe(false);
      expect(result.oracle.failures.some((failure) => failure.message.includes("CANDIDATE_WORKSPACE_MISMATCH"))).toBe(true);
      expect(result.budget.attempts).toBe(1);
      expect(result.failurePacket?.candidateId).toBe(fixture.value.id);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not treat unavailable provider usage as zero under a configured token budget", async () => {
    const fixture = await candidate();
    const provider: AgentProvider = { name: "unknown-usage", networkIsolation: "enforced", async execute(request) { return { ...providerResult(request), usage: {}, usageKnown: false }; } };
    try {
      const result = await new CertificationCore(oracleForFile("bad\n"), provider).certify({
        candidate: fixture.value,
        policy: policy({ budget: { maxAttempts: 1, maxDurationMs: 10_000, maxTotalTokens: 100 } }),
        actor: { version: 1, requestId: "actor-unknown", role: "actor", prompt: "act", cwd: fixture.root, command: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false }
      });
      expect(result.state).toBe("HUMAN_REQUIRED");
      expect(result.failurePacket?.reason).toBe("BUDGET_EXHAUSTED");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("fails closed when recursive certification is inherited", async () => {
    const fixture = await candidate();
    const previous = process.env.AEH_CERTIFICATION_DEPTH;
    process.env.AEH_CERTIFICATION_DEPTH = "1";
    try { await expect(new CertificationCore(oracleForFile("bad\n")).certify({ candidate: fixture.value, policy: policy() })).rejects.toThrow("Recursive certification"); }
    finally { if (previous === undefined) delete process.env.AEH_CERTIFICATION_DEPTH; else process.env.AEH_CERTIFICATION_DEPTH = previous; await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("cannot promote contract PASS plus blocked model E2E to PASS", async () => {
    const fixture = await candidate();
    const provider: AgentProvider = { name: "mocked-model", networkIsolation: "enforced", async execute(request) { return providerResult(request); } };
    try {
      const result = await new CertificationCore(oracleForFile("bad\n"), provider).certify({
        candidate: fixture.value,
        policy: policy(),
        capability: "informational",
        requireModelE2E: true,
        actor: { version: 1, requestId: "actor-mock", role: "actor", prompt: "answer", cwd: fixture.root, command: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false }
      });
      expect(result.oracle.status).toBe("PASS");
      expect(result.capability).toMatchObject({ contract: { status: "INSUFFICIENT" }, modelE2E: { status: "BLOCKED" }, overall: "FAIL" });
      expect(result.accepted).toBe(false);
      expect(result.state).toBe("BLOCKED");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("requires oracle-verified journey evidence whenever model E2E is required", async () => {
    const fixture = await candidate();
    const provider: AgentProvider = { name: "started-model", networkIsolation: "enforced", async execute(request) { return { ...providerResult(request), executionEvidence: { started: true, provider: "test", command: request.command, startedAt: new Date().toISOString() } }; } };
    try {
      const result = await new CertificationCore(oracleForFile("bad\n"), provider).certify({
        candidate: fixture.value,
        policy: policy(),
        capability: "informational",
        requireModelE2E: true,
        actor: { version: 1, requestId: "actor-no-oracle-evidence", role: "actor", prompt: "answer", cwd: fixture.root, command: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false }
      });
      expect(result.capability?.modelE2E.status).toBe("INSUFFICIENT");
      expect(result.accepted).toBe(false);
      expect(result.state).toBe("BLOCKED");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not treat configuration alone as model execution evidence", async () => {
    const fixture = await candidate();
    try {
      const result = await new CertificationCore(oracleForFile("bad\n")).certify({ candidate: fixture.value, policy: policy(), capability: "audit", requireModelE2E: true });
      expect(result.capability?.modelE2E.status).toBe("NOT_TESTED");
      expect(result.capability?.overall).toBe("FAIL");
      expect(result.accepted).toBe(false);
      expect(result.state).toBe("BLOCKED");
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("records nonzero oracle timing", async () => {
    const fixture = await candidate();
    try {
      const oracle: CertificationOracle = { id: "slow", independent: true, async evaluate(context) { await new Promise((resolve) => setTimeout(resolve, 5)); return oracleForFile("bad\n").evaluate(context); } };
      const result = await new CertificationCore(oracle).certify({ candidate: fixture.value, policy: policy() });
      expect(result.attempts.find((attempt) => attempt.role === "oracle")?.durationMs).toBeGreaterThan(0);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects empty deterministic oracle evidence", () => {
    const result = createCertificationOracleResult({ oracleId: "empty", checks: [] });
    expect(result.status).toBe("FAIL");
    expect(oracleCanAccept(result, { allowRequiredSkippedChecks: false })).toBe(false);
  });

  it("blocks when a policy requires unavailable network isolation", async () => {
    const fixture = await candidate();
    try {
      const result = await new CertificationCore(oracleForFile("bad\n")).certify({ candidate: fixture.value, policy: policy({ security: { requireNetworkIsolation: true } }) });
      expect(result.state).toBe("BLOCKED");
      expect(result.networkPolicy).toMatchObject({ requested: "DENY", enforced: false, enforcement: "unavailable" });
      expect(result.accepted).toBe(false);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not invoke a direct provider when denied-network isolation is unproven", async () => {
    const fixture = await candidate();
    const marker = path.join(fixture.root, "provider-ran");
    try {
      const result = await new CertificationCore(oracleForFile("bad\n"), new LocalAgentProvider()).certify({
        candidate: fixture.value,
        policy: policy(),
        actor: { version: 1, requestId: "actor-isolation", role: "actor", prompt: "act", cwd: fixture.root, command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false }
      });
      expect(result.state).toBe("HUMAN_REQUIRED");
      expect(result.providerResults[0]?.stderr).toContain("cannot prove network isolation");
      await expect(fs.access(marker)).rejects.toThrow();
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });
});

describe("certification provider boundary", () => {
  it("resolves installed Codex capabilities and uses supported reasoning configuration", async (context) => {
    const codex = await resolveCodexBinary();
    if (!codex) { context.skip(); return; }
    const capabilities = await resolveCodexCapabilities(codex, process.cwd());
    expect(capabilities.supportsJson).toBe(true);
    expect(capabilities.supportsConfigOverride).toBe(true);
    expect(capabilities.supportsReasoningFlag).toBe(false);
    expect(codexCommandPreview({}, { args: [], prompt: "test" }).join(" ")).not.toContain("--reasoning-effort");
  });

  it("uses argv execution, filters ambient credentials, parses JSONL, and bounds output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-provider-test-"));
    const previous = process.env.AEH_TEST_SECRET;
    process.env.AEH_TEST_SECRET = "do-not-pass";
    try {
      const environment = buildProviderEnvironment({ environmentAllowlist: [], credentialEnvAllowlist: [] });
      expect(environment.AEH_TEST_SECRET).toBeUndefined();
      expect(parseJsonl('{"ok":true}\nnot-json\n')).toEqual([{ ok: true }]);
      const result = await executeArgv(process.execPath, ["-e", "console.log(JSON.stringify({ok:true}))"], { cwd: root, timeoutMs: 1000, maxOutputBytes: 1024, allowNetwork: false });
      expect(result.status).toBe("COMPLETED");
      expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true });
      const limited = await executeArgv(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { cwd: root, timeoutMs: 1000, maxOutputBytes: 100 });
      expect(limited.status).toBe("OUTPUT_LIMIT");
    } finally { if (previous === undefined) delete process.env.AEH_TEST_SECRET; else process.env.AEH_TEST_SECRET = previous; await fs.rm(root, { recursive: true, force: true }); }
  });

  it("uses structured turn usage instead of guessing from arbitrary text", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-provider-usage-"));
    try {
      const result = await new LocalAgentProvider().execute({ version: 1, requestId: "usage-1", role: "actor", prompt: "usage", cwd: root, command: process.execPath, args: ["-e", "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:7}}))"], timeoutMs: 1000, maxOutputBytes: 4096, allowNetwork: false });
      expect(result.usage).toMatchObject({ inputTokens: 4, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 7 });
      expect(result.usageKnown).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("binds model evidence to the exact packed candidate intent command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-oracle-evidence-"));
    const oracleFile = path.join(root, "oracle.mjs");
    await fs.writeFile(oracleFile, "console.log(JSON.stringify({modelExecuted:true,intent:'informational'}));\n");
    const oracle = createCommandOracle({ command: process.execPath, args: ["oracle.mjs"], requireModelEvidence: true });
    try {
      await oracle.prepare?.({ candidate: { version: 1, id: "oracle-candidate", root }, policy: policy(), attempt: 0 });
      const actor = { ...providerResult({ version: 1, requestId: "actor", role: "actor", prompt: "", cwd: root, command: "codex", args: [], timeoutMs: 1_000, maxOutputBytes: 1024, allowNetwork: false }), events: [{ at: new Date().toISOString(), type: "json" as const, data: { type: "item.completed", item: { command: "rg intent .", exit_code: 0, aggregated_output: "INFORMATIONAL" } } }] };
      const result = await oracle.evaluate({ candidate: { version: 1, id: "oracle-candidate", root }, policy: policy(), attempt: 0, actor });
      expect(result.checks.find((check) => check.id === "model.evidence")?.status).toBe("FAIL");
    } finally { await oracle.dispose?.(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("executes a protected oracle snapshot after actor mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-oracle-snapshot-"));
    const oracleFile = path.join(root, "oracle.mjs");
    await fs.writeFile(oracleFile, "console.log('ORIGINAL');\n");
    const candidateValue = { version: 1 as const, id: "snapshot-candidate", root };
    const oracle = createCommandOracle({ command: process.execPath, args: ["oracle.mjs"] });
    try {
      await oracle.prepare?.({ candidate: candidateValue, policy: policy(), attempt: 0 });
      await fs.writeFile(oracleFile, "console.log('MUTATED');\n");
      const result = await oracle.evaluate({ candidate: candidateValue, policy: policy(), attempt: 0 });
      expect(result.checks[0]?.evidence?.stdout).toContain("ORIGINAL");
      expect(result.checks[0]?.evidence?.stdout).not.toContain("MUTATED");
    } finally { await oracle.dispose?.(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
