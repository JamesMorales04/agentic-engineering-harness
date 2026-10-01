import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CertificationCore, type AgentProvider } from "../src/certification/core.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { parsePackFilename } from "../src/certification/bootstrap.js";
import { actorCommandExecutions, createCapabilityJourneyOracle } from "../src/certification/journeys.js";
import { defaultCertificationPolicy } from "../src/certification/policy.js";
import type { AgentProviderRequest, AgentProviderResult, CandidateRevision, CertificationPolicy } from "../src/certification/types.js";

function policy(overrides: Partial<CertificationPolicy> = {}): CertificationPolicy {
  return defaultCertificationPolicy({
    ...overrides,
    assurance: { ...defaultCertificationPolicy().assurance, ...overrides.assurance },
    budget: { ...defaultCertificationPolicy().budget, ...overrides.budget },
    security: { ...defaultCertificationPolicy().security, ...overrides.security }
  });
}

async function candidate(id = "journey-candidate"): Promise<CandidateRevision> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-journey-test-"));
  await fs.writeFile(path.join(root, "artifact.txt"), "packed\n");
  return { version: 1, id, root, sourceDigest: await computeWorktreeDigest(root) };
}

function actorResult(request: AgentProviderRequest, commands: Array<{ command: string; exitCode: number; output?: string }>): AgentProviderResult {
  return {
    version: 1,
    provider: "codex",
    requestId: request.requestId,
    role: request.role,
    status: "COMPLETED",
    exitCode: 0,
    stdout: "{\"type\":\"turn.completed\"}\n",
    stderr: "",
    events: [
      { at: new Date().toISOString(), type: "started", data: {} },
      ...commands.map((command) => ({
        at: new Date().toISOString(),
        type: "json" as const,
        data: { type: "item.completed", item: { type: "command_execution", command: command.command, exit_code: command.exitCode, aggregated_output: command.output ?? "" } }
      }))
    ],
    structuredOutput: [{ type: "item.completed" }],
    usage: { totalTokens: 7 },
    usageKnown: true,
    durationMs: 1,
    outputTruncated: false,
    executionEvidence: { started: true, provider: "codex", command: "codex", startedAt: new Date().toISOString() }
  };
}

describe("packed bootstrap npm pack parsing", () => {
  it("tolerates a package prepare build before the JSON payload", () => {
    const stdout = "vite v7 building...\nBuilt release-1-2-3\n[\n  {\n    \"filename\": \"agentic-engineering-harness-0.8.4.tgz\"\n  }\n]\n";
    expect(parsePackFilename(stdout)).toBe("agentic-engineering-harness-0.8.4.tgz");
  });

  it("still rejects unsafe or missing artifacts", () => {
    expect(() => parsePackFilename("no json here")).toThrow("npm pack did not return JSON.");
    expect(() => parsePackFilename("[\n{\"filename\":\"../escape.tgz\"}\n]")).toThrow("unsafe artifact filename");
  });
});

describe("capability journey oracle", () => {
  it("passes only when every required evidence id and the provider command are verified", async () => {
    const fixture = await candidate();
    const oracle = createCapabilityJourneyOracle({
      id: "journey:startup",
      capability: "startup",
      verify: async () => ({ install: { ok: true }, doctor: { ok: true }, startup: { ok: true } }),
      actorCommands: [{ label: "init", contains: "dist/main.js init" }]
    });
    try {
      const request: AgentProviderRequest = { version: 1, requestId: "actor", role: "actor", prompt: "", cwd: fixture.root, command: "codex", args: [], timeoutMs: 1_000, maxOutputBytes: 1024, allowNetwork: true };
      const result = await oracle.evaluate({ candidate: fixture, policy: policy(), attempt: 0, actor: actorResult(request, [{ command: "node node_modules/agentic-engineering-harness/dist/main.js init .", exitCode: 0 }]) });
      expect(result.status).toBe("PASS");
      expect(result.checks.find((check) => check.id === "model.evidence")?.status).toBe("PASS");
      expect(result.checks.filter((check) => check.category === "journey").map((check) => check.id).sort()).toEqual(["doctor", "install", "startup"]);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("fails required evidence that the verifier did not confirm", async () => {
    const fixture = await candidate();
    const oracle = createCapabilityJourneyOracle({
      id: "journey:startup",
      capability: "startup",
      verify: async () => ({ install: { ok: true }, doctor: { ok: true }, startup: { ok: false, detail: "config missing" } })
    });
    try {
      const result = await oracle.evaluate({ candidate: fixture, policy: policy(), attempt: 0 });
      expect(result.status).toBe("FAIL");
      expect(result.failures.some((failure) => failure.id === "startup")).toBe(true);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not accept a provider transcript claim in place of the declared command", async () => {
    const fixture = await candidate();
    const oracle = createCapabilityJourneyOracle({
      id: "journey:startup",
      capability: "startup",
      verify: async () => ({ install: { ok: true }, doctor: { ok: true }, startup: { ok: true } }),
      actorCommands: [{ contains: "dist/main.js init" }]
    });
    try {
      const request: AgentProviderRequest = { version: 1, requestId: "actor", role: "actor", prompt: "", cwd: fixture.root, command: "codex", args: [], timeoutMs: 1_000, maxOutputBytes: 1024, allowNetwork: true };
      const failed = await oracle.evaluate({ candidate: fixture, policy: policy(), attempt: 0, actor: actorResult(request, [{ command: "dist/main.js init .", exitCode: 1 }]) });
      expect(failed.status).toBe("FAIL");
      expect(failed.checks.find((check) => check.id === "model.evidence")?.status).toBe("FAIL");
      const missing = await oracle.evaluate({ candidate: fixture, policy: policy(), attempt: 0 });
      expect(missing.failures.some((failure) => failure.id === "model.evidence")).toBe(true);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("extracts command executions from the provider transcript", () => {
    const executions = actorCommandExecutions({
      version: 1, provider: "codex", requestId: "r", role: "actor", status: "COMPLETED", exitCode: 0, stdout: "", stderr: "", usage: {}, usageKnown: false, durationMs: 1, outputTruncated: false,
      events: [{ at: new Date().toISOString(), type: "json", data: { type: "item.completed", item: { command: "echo hi", exit_code: 0, aggregated_output: "hi" } } }]
    });
    expect(executions).toEqual([{ command: "echo hi", exitCode: 0, output: "hi" }]);
  });
});

describe("certification core with a capability journey oracle", () => {
  it("accepts a capability only with verified journey evidence and a started provider", async () => {
    const fixture = await candidate();
    const oracle = createCapabilityJourneyOracle({
      id: "journey:project-home",
      capability: "project-home",
      verify: async () => ({ "project-id": { ok: true }, health: { ok: true } }),
      actorCommands: [{ contains: "dist/main.js home" }]
    });
    const provider: AgentProvider = {
      name: "recorded-real-provider",
      networkIsolation: "enforced",
      async execute(request) { return actorResult(request, [{ command: "node node_modules/agentic-engineering-harness/dist/main.js home --once", exitCode: 0, output: "AEH Home ready at http://127.0.0.1:43111" }]); }
    };
    try {
      const result = await new CertificationCore(oracle, provider).certify({
        candidate: fixture,
        policy: policy({ security: { ...defaultCertificationPolicy().security, allowNetwork: true } }),
        capability: "project-home",
        requireModelE2E: true,
        actor: { version: 1, requestId: "actor", role: "actor", prompt: "run", cwd: fixture.root, command: "codex", args: [], timeoutMs: 1_000, maxOutputBytes: 1024, allowNetwork: true }
      });
      expect(result.state).toBe("ACCEPTED");
      expect(result.capability).toMatchObject({ overall: "PASS", contract: { status: "PASS" }, modelE2E: { status: "PASS" } });
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });

  it("cannot promote missing capability evidence to a capability PASS", async () => {
    const fixture = await candidate();
    const oracle = createCapabilityJourneyOracle({ id: "journey:project-home", capability: "project-home", verify: async () => ({ "project-id": { ok: true } }) });
    try {
      const result = await new CertificationCore(oracle).certify({ candidate: fixture, policy: policy(), capability: "project-home", requireModelE2E: true });
      expect(result.capability?.contract.status).toBe("FAIL");
      expect(result.capability?.overall).toBe("FAIL");
      expect(result.accepted).toBe(false);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });
});
