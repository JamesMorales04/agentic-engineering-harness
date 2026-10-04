import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { launchManagedPaseoAgent } from "../src/paseo/runtime.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1, parseSemanticAssessmentOutputV1 } from "../src/semantic/runtime.js";
import { semanticPayload, semanticTestRequest, semanticAssessorTopologySource } from "./semanticAssessmentSupport.js";

describe("Paseo Semantic Assessor runtime", () => {
  it("extracts a typed assessment from a real provider reply that wraps its JSON", () => {
    const payload = { assessmentType: "INTENT", classification: "INFORMATIONAL" };
    expect(parseSemanticAssessmentOutputV1(JSON.stringify(payload))).toEqual(payload);
    expect(parseSemanticAssessmentOutputV1(`assessment follows\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nend`)).toEqual(payload);
    expect(parseSemanticAssessmentOutputV1(`prefix {"assessmentType":"INTENT"} suffix`)).toEqual({ assessmentType: "INTENT" });
    expect(() => parseSemanticAssessmentOutputV1("no json here")).toThrow("not a structured JSON result");
    expect(() => parseSemanticAssessmentOutputV1("   ")).toThrow("no structured result");
  });

  it("recovers a complete object followed by bounded stray closing braces without repairing fields", () => {
    const payload = { assessmentType: "STACK", judgment: { type: "STACK" } };
    const complete = JSON.stringify(payload);
    expect(parseSemanticAssessmentOutputV1(`${complete}}`)).toEqual(payload);
    expect(parseSemanticAssessmentOutputV1(`${complete}}}\n`)).toEqual(payload);
    expect(parseSemanticAssessmentOutputV1(`answer follows\n${complete}}}\nend`)).toEqual(payload);
    expect(() => parseSemanticAssessmentOutputV1("{ not json }")).toThrow("not a structured JSON result");
  });

  it("does not repair interior JSON syntax: an interior stray brace stays invalid", () => {
    expect(() => parseSemanticAssessmentOutputV1('{"judgment":{"type":"STACK"}},"claims":[{"id":"c1"}]}')).toThrow("not a structured JSON result");
    expect(() => parseSemanticAssessmentOutputV1('{"judgment":{"type":"STACK"}},"claims":[]} trailing prose')).toThrow("not a structured JSON result");
  });

  it("classifies a real provider timeout in typed error details and retries exactly once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-timeout-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
      const config: HarnessProjectConfig = { version: 1, project: { name: "runtime-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
      const launch = vi.fn<typeof launchManagedPaseoAgent>(async () => ({
        id: "paseo-timeout-session",
        exitCode: 124,
        stdout: "",
        stderr: "",
        status: "timeout",
        transport: "sdk"
      }));
      const runtime = await createSemanticAssessmentRuntimeV1(root, config, { launch });

      await expect(runtime.service.assess(semanticTestRequest("ROUTE"))).rejects.toMatchObject({
        code: "SEMANTIC_ASSESSMENT_UNAVAILABLE",
        details: { timeout: true, exitCode: 124, status: "timeout" }
      });
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records a bounded rejected-reply fingerprint, the assessor session id, and a trace event for an unparseable reply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-fingerprint-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
      const config: HarnessProjectConfig = { version: 1, project: { name: "runtime-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
      const rawReply = "I cannot return JSON; here is prose instead.";
      const launch = vi.fn<typeof launchManagedPaseoAgent>(async () => ({
        id: "paseo-prose-session",
        exitCode: 0,
        stdout: rawReply,
        stderr: "",
        status: "completed",
        transport: "sdk"
      }));
      const runtime = await createSemanticAssessmentRuntimeV1(root, config, { launch });

      let failure: { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
      try { await runtime.service.assess(semanticTestRequest("ROUTE")); } catch (error) { failure = error as typeof failure; }
      expect(failure?.code).toBe("SEMANTIC_ASSESSMENT_INVALID");
      expect(failure?.details?.sessionId).toBe("paseo-prose-session");
      expect(failure?.details?.fingerprint).toMatchObject({ version: 1, lengthBytes: Buffer.byteLength(rawReply, "utf8"), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), head: rawReply });
      expect(failure?.message).toContain("assessorSession=paseo-prose-session");
      expect(launch).toHaveBeenCalledTimes(2);
      const traceFile = await fs.readFile(path.join(root, ".harness", "telemetry", "paseo.ndjson"), "utf8");
      const rejection = traceFile.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { name: string; attributes?: Record<string, unknown> }).find((entry) => entry.name.endsWith("semantic.assessor.reply.rejected"));
      expect(rejection?.attributes).toMatchObject({ agentId: "paseo-prose-session", lengthBytes: Buffer.byteLength(rawReply, "utf8") });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds the canonical realpath when the repository root is addressed through a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-binding-root-"));
    const alias = `${root}-alias`;
    try {
      await fs.writeFile(path.join(root, "source.txt"), "bound repository bytes\n");
      await fs.symlink(root, alias, "dir");
      const config: HarnessProjectConfig = { version: 1, project: { name: "binding-test" } };
      const binding = await createSemanticRepositoryBindingV1(alias, config);
      const canonicalRoot = await fs.realpath(root);

      expect(binding.repositoryRootDigest).toBe(sha256Canonical(canonicalRoot));
      expect(binding.repositoryDigest).toBe(await computeWorktreeDigest(canonicalRoot));
      expect(binding.projectId).toBe(`project:${sha256Canonical({ root: canonicalRoot, name: config.project.name }).slice(0, 24)}`);
    } finally {
      await fs.rm(alias, { force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("executes the topology-selected agent through Paseo with denied tools and durable session provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-runtime-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
    const config: HarnessProjectConfig = { version: 1, project: { name: "runtime-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
    const launch = vi.fn<typeof launchManagedPaseoAgent>(async (_cwd, options) => ({
      id: "paseo-actual-session-7",
      exitCode: 0,
      stdout: JSON.stringify(semanticPayload(semanticTestRequest("STACK"))),
      stderr: "",
      status: "completed",
      workspaceId: "paseo-workspace-4",
      transport: "sdk"
    }));

    const runtime = await createSemanticAssessmentRuntimeV1(root, config, { launch });
    const request = semanticTestRequest("STACK");
    const assessment = await runtime.service.assess(request);
    const options = launch.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    expect(launch.mock.calls[0]?.[0]).toBe(root);
    expect(options?.provider).toBe("codex");
    expect(options?.model).toBe("openai/gpt-6-luna");
    expect(options?.outputSchema).toBeDefined();
    expect(options?.labels).toMatchObject({ "aeh.kind": "semantic-assessment", "aeh.role": "Semantic Assessor", "aeh.semantic.assessment.type": "STACK" });
    expect(options?.labels).not.toHaveProperty("aeh.task");
    expect(options?.labels).not.toHaveProperty("aeh.participant");
    expect(options?.labels).not.toHaveProperty("aeh.output.contract");
    // Codex assessor carries no OpenCode runtime projection.
    expect(options?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(assessment).toMatchObject({
      assessmentType: "STACK",
      assessor: { logicalAgent: "assessor", modelId: "openai/gpt-6-luna" },
      paseoSession: { provider: "codex", agentId: "paseo-actual-session-7", workspaceId: "paseo-workspace-4", transport: "sdk" },
      cacheDisposition: "FRESH"
    });
    expect(await fs.readFile(path.join(root, ".harness", "cache", "semantic-assessments-v1", `${assessment.cacheIdentity}.json`), "utf8")).toContain("paseo-actual-session-7");
  });

  it("reuses only a complete cached assessment with matching evidence and profile identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-cache-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
    const config: HarnessProjectConfig = { version: 1, project: { name: "cache-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
    const launch = vi.fn<typeof launchManagedPaseoAgent>(async (_cwd, _options) => ({ id: "paseo-cache-session", exitCode: 0, stdout: JSON.stringify(semanticPayload(semanticTestRequest("STACK"))), stderr: "", transport: "cli" }));
    const firstRuntime = await createSemanticAssessmentRuntimeV1(root, config, { launch });
    const first = await firstRuntime.service.assess(semanticTestRequest("STACK"));
    const secondRuntime = await createSemanticAssessmentRuntimeV1(root, config, { launch });
    const second = await secondRuntime.service.assess(semanticTestRequest("STACK"));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(second.cacheDisposition).toBe("HIT");
    expect(second.assessmentDigest).toBe(first.assessmentDigest);
  });
});
