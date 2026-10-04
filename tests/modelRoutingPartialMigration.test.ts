import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentTopologySource, resolveAgentTopology } from "../src/agents/config.js";
import { executionSelectionForAgent, resolveRoute, selectAgentNames, selectModelFallbackExecutionV1 } from "../src/agents/routing.js";
import { describeModelFallbackV1, modelFallbackRegistryV1, noModelFallbackV1 } from "../src/agents/modelFallback.js";
import { modelFallbackObservationV2FromV1, modelFallbackObservationV2Schema } from "../src/telemetry/efficiency.js";
import { resolveSemanticAssessor } from "../src/semantic/assessment.js";
import {
  assertSemanticStructuredOutputCapabilityV1,
  certifiedSemanticStructuredOutputModelsV1
} from "../src/semantic/structuredOutput.js";
import { loadProjectConfig } from "../src/core/config.js";
import { PACKAGE_ROOT } from "../src/version.js";

const WORKHORSE_LANES = ["planner", "spec-manager", "explorer", "librarian", "implementer", "reviewer", "repairer"] as const;

async function defaultTopology(profile = "balanced") {
  const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "aeh-model-routing-"));
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), '{"version":1,"extends":["aeh:default"]}');
  const config = { version: 1, project: { name: "routing-test" }, agents: { configPath: ".harness/agents.source.jsonc" } } as never;
  const source = await loadAgentTopologySource(root, config);
  return resolveAgentTopology(source, profile);
}

describe("partial model-routing migration (owner-approved)", () => {
  it("(i) ships no MiMo default outside evidence/history records", async () => {
    const shipped = [
      "presets/agents/default.jsonc",
      "presets/agents/orchestration.jsonc",
      "templates/agents.source.jsonc",
      "templates/project.yaml",
      ".harness/project.yaml",
      "docs/V0.4.13.md"
    ];
    for (const relative of shipped) {
      const content = await fs.readFile(path.join(PACKAGE_ROOT, relative), "utf8");
      expect(content.toLowerCase()).not.toContain("mimo-v2.6-flash");
      expect(content).not.toContain("MiMo-V2.6-Flash");
    }
  });

  it("(ii) ships no OpenCode-routed GPT-6 Luna where Codex Luna is intended", async () => {
    const defaultPreset = await fs.readFile(path.join(PACKAGE_ROOT, "presets/agents/default.jsonc"), "utf8");
    expect(defaultPreset).not.toMatch(/"runtime"\s*:\s*"opencode"[^}]*"model"\s*:\s*"gpt-6-luna"/s);
    expect(defaultPreset).not.toContain("opencode-go/gpt-6-luna");
    const topology = await defaultTopology();
    expect(topology.models["structured-assessor"]).toMatchObject({ runtime: "codex", provider: "openai", model: "gpt-6-luna", variant: "xhigh" });
  });

  it("(iii) resolves the Semantic Assessor to certified Codex-channel Luna and stays fail-closed on genuine errors", async () => {
    const topology = await defaultTopology();
    expect(topology.models["structured-assessor"]).toMatchObject({ runtime: "codex", provider: "openai", model: "gpt-6-luna", variant: "xhigh" });
    // Certified on the strict-reformulated schema by the bounded Codex-channel probe (see
    // docs/evidence/model-routing/codex-requalification-2026-10-04.json): the canonical
    // Codex route resolves instead of failing closed.
    const assessor = resolveSemanticAssessor(topology);
    expect(assessor.identity.modelId).toBe("openai/gpt-6-luna");
    expect(() => assertSemanticStructuredOutputCapabilityV1("openai/gpt-6-luna")).not.toThrow();
    expect(certifiedSemanticStructuredOutputModelsV1()).toContain("openai/gpt-6-luna");
    expect(certifiedSemanticStructuredOutputModelsV1()).not.toContain("opencode-go/muse-spark-1.3-contributor");
    // Fail-closed is preserved for genuine errors: uncertified models still refuse.
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/muse-spark-1.3-contributor")).toThrow(/UNCERTIFIED/);
  });

  it("(iv) resolves workhorse lanes to Muse via OpenCode Go", async () => {
    const topology = await defaultTopology();
    for (const lane of WORKHORSE_LANES) {
      const selection = executionSelectionForAgent(topology, lane);
      expect(selection.modelId).toBe("opencode-go/muse-spark-1.3-contributor");
      expect(selection.runtimeAdapter).toBe("opencode");
      expect(selection.paseoProvider).toBe("opencode");
    }
    const lead = executionSelectionForAgent(topology, "lead");
    expect(lead.modelId).toBe("openai/gpt-6-luna");
    const supervisor = executionSelectionForAgent(topology, "operation-supervisor");
    expect(supervisor.modelId).toBe("openai/gpt-6-luna");
  });

  it("(v) fails stale configs with explicit migration errors", async () => {
    const staleAssessor = {
      version: 1,
      runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode" }, codex: { adapter: "codex", paseoProvider: "codex" } },
      models: {
        workhorse: { runtime: "opencode", provider: "opencode-go", model: "muse-spark-1.3-contributor" },
        "structured-assessor": { runtime: "opencode", provider: "opencode-go", model: "gpt-6-luna" }
      },
      agents: {
        assessor: {
          role: "Semantic Assessor",
          execution: { model: "@structured-assessor", transport: "paseo" },
          permissions: { read: "deny", write: "deny", shell: "deny", network: "deny", delegate: "deny", review: "deny", validate: "deny", gitWrite: "deny" },
          contextRequirements: { repositoryMap: "FORBIDDEN", semanticRetrieval: "FORBIDDEN", rawRetrieval: "FORBIDDEN", compression: "FORBIDDEN" },
          outputContract: "semantic-assessment"
        }
      }
    } as never;
    expect(() => resolveAgentTopology(staleAssessor)).toThrow(/UNSUPPORTED_LEGACY_ASSESSOR_ROUTING/);

    const staleWorkhorse = {
      version: 1,
      runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode" }, codex: { adapter: "codex", paseoProvider: "codex" } },
      models: {
        workhorse: { runtime: "opencode", provider: "opencode-go", model: "mimo-v2.6-flash" },
        brain: { runtime: "codex", provider: "openai", model: "gpt-6-luna", variant: "xhigh" }
      },
      agents: { worker: { role: "Implementer", execution: { model: "@workhorse" } } }
    } as never;
    expect(() => resolveAgentTopology(staleWorkhorse)).toThrow(/UNSUPPORTED_LEGACY_WORKHORSE_MODEL/);

    const tmp = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "aeh-stale-worker-"));
    await fs.mkdir(path.join(tmp, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".harness", "project.yaml"),
      "version: 1\nproject:\n  name: stale\norchestration:\n  provider: paseo\n  worker:\n    provider: opencode\n    model: MiMo-V2.6-Flash\n"
    );
    await expect(loadProjectConfig(tmp)).rejects.toThrow(/UNSUPPORTED_LEGACY_WORKER_MODEL/);
  });

  it("(vi) exposes observable fallbackUsed/from/to/reason via the registry", async () => {
    const topology = await defaultTopology();
    const registry = modelFallbackRegistryV1(topology);
    expect(registry.workhorseToBrain).toMatchObject({ from: "@workhorse", to: "@brain", reason: "explicit-provider-fallback" });
    const from = executionSelectionForAgent(topology, "implementer");
    const to = executionSelectionForAgent(topology, "lead");
    const used = describeModelFallbackV1({ from, to, reason: registry.workhorseToBrain!.reason, fallbackUsed: true });
    expect(used).toMatchObject({ version: 1, fallbackUsed: true, reason: "explicit-provider-fallback" });
    expect(used.from?.modelId).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(used.to?.modelId).toBe("openai/gpt-6-luna");
    expect(noModelFallbackV1()).toEqual({ version: 1, fallbackUsed: false });
  });

  it("(vii) wires workhorseToBrain through the escalation selector with observable fallbackUsed/from/to/reason", async () => {
    const topology = await defaultTopology();
    const base = executionSelectionForAgent(topology, "implementer");
    expect(base.modelId).toBe("opencode-go/muse-spark-1.3-contributor");
    const fired = selectModelFallbackExecutionV1(topology, base, "difficult-diagnosis");
    expect(fired.observation).toMatchObject({ version: 1, fallbackUsed: true, reason: "explicit-provider-fallback" });
    expect(fired.observation.from?.modelId).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(fired.observation.to?.modelId).toBe("openai/gpt-6-luna");
    expect(fired.selection.modelId).toBe("openai/gpt-6-luna");
    expect(fired.selection.runtimeAdapter).toBe("codex");
    expect(fired.selection.paseoProvider).toBe("codex");
    // Efficiency telemetry carries the observation (the V1 version discriminator is dropped).
    const mapped = modelFallbackObservationV2FromV1(fired.observation);
    expect(mapped).toMatchObject({ fallbackUsed: true, reason: "explicit-provider-fallback" });
    expect(mapped.from?.modelId).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(mapped.to?.modelId).toBe("openai/gpt-6-luna");
    expect(() => modelFallbackObservationV2Schema.parse(mapped)).not.toThrow();
  });

  it("(viii) stays fail-closed with no silent fallback outside explicit registry matches", async () => {
    const topology = await defaultTopology();
    const base = executionSelectionForAgent(topology, "implementer");
    const unknownReason = selectModelFallbackExecutionV1(topology, base, "not-a-registry-reason");
    expect(unknownReason.observation).toEqual({ version: 1, fallbackUsed: false });
    expect(unknownReason.selection).toBe(base);
    const brain = executionSelectionForAgent(topology, "lead");
    expect(brain.modelId).toBe("openai/gpt-6-luna");
    const alreadyBrain = selectModelFallbackExecutionV1(topology, brain, "difficult-diagnosis");
    expect(alreadyBrain.observation).toEqual({ version: 1, fallbackUsed: false });
    expect(alreadyBrain.selection).toBe(brain);
    expect(modelFallbackObservationV2FromV1(undefined)).toEqual({ fallbackUsed: false });
    expect(modelFallbackObservationV2FromV1(noModelFallbackV1())).toEqual({ fallbackUsed: false });
  });

  it("(ix) routes high-risk review to the Luna high-assurance reviewer while normal review stays workhorse", async () => {
    for (const profile of ["economy", "balanced", "maximum-quality"]) {
      const topology = await defaultTopology(profile);
      const highAssurance = executionSelectionForAgent(topology, "high-assurance-reviewer");
      expect(highAssurance.role).toBe("Reviewer");
      expect(highAssurance.modelId).toBe("openai/gpt-6-luna");
      expect(highAssurance.runtimeAdapter).toBe("codex");
      expect(highAssurance.paseoProvider).toBe("codex");
    }
    const topology = await defaultTopology();
    const highRisk = resolveRoute(topology, { intent: "implement", domains: [], files: [], risk: "high" });
    expect(highRisk.ruleIds).toContain("high-risk-review");
    expect(highRisk.ruleIds).toContain("default-implementation");
    // Canonical rule composition: high-risk tasks carry the Luna high-assurance review plus
    // the normal workhorse review; normal tasks carry only the workhorse review.
    const highRiskReviewers = new Set(highRisk.review.flatMap((selector) => selectAgentNames(topology, selector)));
    expect(highRiskReviewers).toEqual(new Set(["high-assurance-reviewer", "reviewer"]));
    const normal = resolveRoute(topology, { intent: "implement", domains: [], files: [] });
    const normalReviewers = new Set(normal.review.flatMap((selector) => selectAgentNames(topology, selector)));
    expect(normalReviewers).toEqual(new Set(["reviewer"]));
  });
});
