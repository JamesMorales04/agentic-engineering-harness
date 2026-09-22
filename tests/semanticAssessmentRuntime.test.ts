import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { launchManagedPaseoAgent } from "../src/paseo/runtime.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1 } from "../src/semantic/runtime.js";
import { semanticPayload, semanticTestRequest, semanticAssessorTopologySource } from "./semanticAssessmentSupport.js";

describe("Paseo Semantic Assessor runtime", () => {
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
    expect(options?.provider).toBe("opencode");
    expect(options?.model).toBe("openai/small-structured");
    expect(options?.outputSchema).toBeDefined();
    expect(options?.labels).toMatchObject({ "aeh.kind": "semantic-assessment", "aeh.role": "Semantic Assessor", "aeh.semantic.assessment.type": "STACK" });
    expect(options?.labels).not.toHaveProperty("aeh.task");
    expect(options?.labels).not.toHaveProperty("aeh.participant");
    expect(options?.labels).not.toHaveProperty("aeh.output.contract");
    const runtimeConfig = JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
    expect(runtimeConfig.permission).toMatchObject({ "*": "deny", read: "deny", edit: "deny", webfetch: "deny", websearch: "deny", task: "deny", skill: "deny" });
    expect(runtimeConfig.mcp).toBeUndefined();
    expect(runtimeConfig.tools).toBeUndefined();
    expect(assessment).toMatchObject({
      assessmentType: "STACK",
      assessor: { logicalAgent: "assessor", modelId: "openai/small-structured" },
      paseoSession: { provider: "opencode", agentId: "paseo-actual-session-7", workspaceId: "paseo-workspace-4", transport: "sdk" },
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
