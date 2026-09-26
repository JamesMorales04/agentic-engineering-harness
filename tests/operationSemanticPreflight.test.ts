import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";
import { sha256Canonical } from "../src/core/digest.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { initializeProject } from "../src/core/init.js";
import { triageChange, type TriageDecision } from "../src/core/triage.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import * as changeModule from "../src/operations/change.js";
import { startDetachedOperation } from "../src/operations/controller.js";
import { loadOperation, type ChangeOperationPayload } from "../src/operations/state.js";
import { launchManagedPaseoAgent } from "../src/paseo/runtime.js";
import type { SemanticAssessmentTypeV1 } from "../src/semantic/assessment.js";
import { createSemanticRepositoryBindingV1 } from "../src/semantic/runtime.js";
import { semanticAssessorTopologySource, semanticPayload, semanticTestRequest } from "./semanticAssessmentSupport.js";

interface ChangePreflightBindingV1 {
  projectId: string;
  repositoryDigest: string;
  repositoryRootDigest: string;
  intentDigest: string;
}

interface ChangePreflightV1 {
  version: 1;
  triage: TriageDecision;
  binding: ChangePreflightBindingV1;
}

type ResolveChangePreflightV1 = (
  root: string,
  config: HarnessProjectConfig,
  payload: ChangeOperationPayload,
  options?: { launch?: typeof launchManagedPaseoAgent }
) => Promise<ChangePreflightV1>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-semantic-preflight-"));
  roots.push(root);
  return root;
}

async function operationRecordFiles(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, ".harness", "operations"))).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function resolveChangePreflightV1Export(): ResolveChangePreflightV1 {
  const candidate = (changeModule as unknown as Record<string, unknown>).resolveChangePreflightV1;
  expect(candidate, "src/operations/change.ts must export resolveChangePreflightV1(root, config, payload, { launch? })").toBeTypeOf("function");
  return candidate as ResolveChangePreflightV1;
}

function routeLaunch(recommendedRoute: "DIRECT" | "DELEGATED" | "FORMAL_SDD" = "DIRECT") {
  return vi.fn<typeof launchManagedPaseoAgent>(async (_root, options) => {
    const prompt = JSON.parse(options.prompt ?? "{}") as { assessmentType?: SemanticAssessmentTypeV1; evidenceRefs?: string[] };
    const assessmentType = prompt.assessmentType ?? "ROUTE";
    const evidenceRefs = prompt.evidenceRefs?.length ? prompt.evidenceRefs : ["request"];
    const request = semanticTestRequest(assessmentType, { evidence: evidenceRefs.map((ref) => ({ ref, content: "Preflight supplied bounded evidence." })) });
    const payload = assessmentType === "ROUTE"
      ? semanticPayload(request, {
          judgment: {
            type: "ROUTE",
            recommendedRoute,
            scopeClarity: "HIGH",
            decompositionNeed: false,
            coordinationNeed: false,
            architectureUncertainty: false,
            productUncertainty: false,
            formalizationNeed: "NONE",
            semanticRiskSignals: [],
            evidenceRefs: request.evidenceRefs,
            unknowns: []
          }
        })
      : semanticPayload(request);
    return {
      id: "paseo-preflight-session",
      exitCode: 0,
      stdout: JSON.stringify(payload),
      stderr: "",
      status: "completed",
      workspaceId: "workspace-preflight",
      transport: "sdk" as const
    };
  });
}

describe("semantic route/assurance preflight before detached operation creation", () => {
  it("resolves a repository/request-bound route preflight through a read-only semantic assessor launch", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), JSON.stringify(semanticAssessorTopologySource), "utf8");
    const config: HarnessProjectConfig = { version: 1, project: { name: "preflight-test" }, agents: { configPath: ".harness/agents.source.jsonc" } };
    const payload: ChangeOperationPayload = { request: "Change the button padding from 12px to 16px", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" };
    const launch = routeLaunch("DIRECT");
    const resolveChangePreflightV1 = resolveChangePreflightV1Export();

    const preflight = await resolveChangePreflightV1(root, config, payload, { launch });

    expect(preflight.version).toBe(1);
    expect(preflight.triage).toMatchObject({ route: "DIRECT", assurance: "NONE", mechanism: "HYBRID" });
    expect(preflight.triage.assessmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(preflight.triage.routeEvidence.length).toBeGreaterThan(0);

    const canonicalRoot = await fs.realpath(root);
    const expectedIntentDigest = sha256Canonical({ request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk, flags: [] });
    expect(preflight.binding).toMatchObject({
      projectId: `project:${sha256Canonical({ root: canonicalRoot, name: config.project.name }).slice(0, 24)}`,
      repositoryDigest: await computeWorktreeDigest(canonicalRoot),
      repositoryRootDigest: sha256Canonical(canonicalRoot),
      intentDigest: expectedIntentDigest
    });
    expect(preflight.binding).not.toHaveProperty("operationId");
    expect(preflight.binding).not.toHaveProperty("candidateId");
    expect(preflight.binding).not.toHaveProperty("candidateRevision");
    expect(preflight.binding).not.toHaveProperty("candidateDigest");

    const routeCall = launch.mock.calls.find(([, options]) => options.labels?.["aeh.semantic.assessment.type"] === "ROUTE");
    expect(routeCall, "preflight must invoke the injected launch with a ROUTE assessment").toBeDefined();
    const [launchRoot, launchOptions] = routeCall!;
    expect(launchRoot).toBe(root);
    expect(launchOptions.labels).toMatchObject({
      "aeh.kind": "semantic-assessment",
      "aeh.role": "Semantic Assessor",
      "aeh.project": "preflight-test",
      "aeh.semantic.assessment.type": "ROUTE"
    });
    for (const key of Object.keys(launchOptions.labels ?? {})) expect(key).not.toMatch(/aeh\.(operation|candidate|participant|task|lead)(\.|$)/);
    expect(launchOptions.title ?? "").not.toMatch(/lead/i);

    const prompt = JSON.parse(launchOptions.prompt ?? "{}") as { assessmentType?: string; binding?: Record<string, unknown> };
    expect(prompt.assessmentType).toBe("ROUTE");
    expect(prompt.binding).toMatchObject({ ...preflight.binding });
    expect(prompt.binding).not.toHaveProperty("operationId");
    expect(prompt.binding).not.toHaveProperty("candidateDigest");

    const runtimeConfig = JSON.parse(launchOptions.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as { permission?: Record<string, string> };
    expect(runtimeConfig.permission).toMatchObject({ "*": "deny", read: "deny", edit: "deny", webfetch: "deny", websearch: "deny", task: "deny" });
  });

  it("resolves the injected preflight before any operation record or spawn and persists the typed triage and binding", async () => {
    const root = await tempRoot();
    await initializeProject(root);
    const config = await loadProjectConfig(root);
    const payload: ChangeOperationPayload = { request: "Change the button padding from 12px to 16px", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" };
    const triage = triageChange(config, { request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk });
    const repositoryBinding = await createSemanticRepositoryBindingV1(root, config);
    const binding: ChangePreflightBindingV1 = {
      projectId: repositoryBinding.projectId,
      repositoryDigest: repositoryBinding.repositoryDigest,
      repositoryRootDigest: repositoryBinding.repositoryRootDigest!,
      intentDigest: sha256Canonical({ request: payload.request, files: payload.files, domains: payload.domains, risk: payload.risk, flags: [] })
    };
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    let recordsAtPreflight: string[] | undefined;
    const resolveChangePreflight = vi.fn<ResolveChangePreflightV1>(async (preflightRoot, preflightConfig, preflightPayload) => {
      expect(preflightRoot).toBe(root);
      expect(preflightConfig.project.name).toBe(config.project.name);
      expect(preflightPayload).toEqual(payload);
      expect(spawnProcess).not.toHaveBeenCalled();
      recordsAtPreflight = await operationRecordFiles(root);
      return { version: 1, triage, binding };
    });
    const options = {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: spawnProcess as never,
      resolveChangePreflight
    };

    const record = await startDetachedOperation(root, "change", payload, options);

    expect(resolveChangePreflight).toHaveBeenCalledTimes(1);
    expect(recordsAtPreflight).toEqual([]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(resolveChangePreflight.mock.invocationCallOrder[0]).toBeLessThan(spawnProcess.mock.invocationCallOrder[0]!);
    expect(record).toMatchObject({
      kind: "change",
      changePreflight: { version: 1, triage, binding },
      intent: { classification: "CHANGE", route: triage.route, assurance: triage.assurance }
    });
    const durable = await loadOperation(root, record.id);
    expect(durable).toMatchObject({
      changePreflight: { version: 1, triage, binding },
      intent: { route: triage.route, assurance: triage.assurance }
    });
  });

  it("leaves no operation record and never spawns when the preflight fails", async () => {
    const root = await tempRoot();
    await initializeProject(root);
    const payload: ChangeOperationPayload = { request: "Change the button padding from 12px to 16px", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" };
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const resolveChangePreflight = vi.fn<ResolveChangePreflightV1>(async () => {
      throw new Error("preflight exploded");
    });
    const options = {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: spawnProcess as never,
      resolveChangePreflight
    };

    await expect(startDetachedOperation(root, "change", payload, options)).rejects.toThrow("preflight exploded");

    expect(resolveChangePreflight).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await operationRecordFiles(root)).toEqual([]);
  });
});
