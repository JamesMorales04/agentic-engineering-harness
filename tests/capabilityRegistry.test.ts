import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { compileCapabilityRegistryV1, discoverCapabilityRegistryV1, loadOperationCapabilityRegistryV1, persistOperationCapabilityRegistryV1 } from "../src/capabilities/registry.js";
import { OPERATIONAL_SKILLS_V1, projectOperationalSkillsV1, type OperationalSkillV1 } from "../src/capabilities/operationalSkills.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { ToolchainConfig, ToolchainLock } from "../src/toolchain/types.js";

const config = {
  version: 1,
  project: { name: "capability-fixture" },
  orchestration: { provider: "paseo" },
  mcp: { servers: {
    serena: { type: "local", command: ["serena"], enabled: true },
    unused: { type: "remote", url: "https://example.invalid/mcp", enabled: true },
    disabled: { type: "local", command: ["off"], enabled: false }
  } },
  context: { semanticRetrieval: { provider: "serena" }, repositoryMap: { enabled: true } },
  delivery: { github: { enabled: true }, paseo: { enabled: false } },
  validation: { validators: [{ id: "browser", adapter: "playwright" }] }
} as HarnessProjectConfig;

const catalog = compileExecutionCatalog({
  runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode", capabilities: { mcp: true } } },
  models: { worker: { runtime: "opencode", provider: "test-provider", model: "test-model" } },
  roleBindings: {
    Implementer: { runtimeId: "opencode", modelAlias: "worker", transport: "paseo" },
    Reviewer: { runtimeId: "opencode", modelAlias: "worker", transport: "paseo" }
  }
});

const topology = {
  version: 1,
  skillRoots: [],
  runtimes: {},
  models: {},
  agents: {
    implementer: { name: "implementer", role: "Implementer", execution: {}, runtime: {}, model: {}, mcps: ["serena"] },
    reviewer: { name: "reviewer", role: "Reviewer", execution: {}, runtime: {}, model: {}, mcps: ["disabled"], disabled: true }
  },
  routing: [],
  recovery: {},
  councils: {}
} as unknown as ResolvedAgentTopology;

const toolchain = {
  version: 1,
  manager: { provider: "mise", lockFile: ".harness/toolchain.lock.json" },
  tools: {
    node: { kind: "mise", command: "node", source: "node", version: "22" },
    playwright: { kind: "mise", command: "playwright", source: "npm:@playwright/test", version: "1.62.1" }
  }
} as ToolchainConfig;
const lock = {
  version: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  profile: "fixture",
  tools: { node: { command: "node", provisioning: "mise", resolvedVersion: "22.23.2" } }
} as ToolchainLock;

function registry() {
  return compileCapabilityRegistryV1({
    operationId: "op-fixture",
    config,
    executionCatalog: catalog,
    topology,
    toolchain,
    toolchainLock: lock,
    providerVersions: { playwright: "1.62.1" }
  });
}

describe("CapabilityRegistryV1", () => {
  it("derives enabled surfaces from execution, MCP, toolchain, validator, context, and delivery sources", () => {
    const result = registry();
    const byId = new Map(result.capabilities.map((item) => [item.id, item]));
    expect(byId.get("runtime:opencode")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT", roles: ["Implementer", "Reviewer"] });
    expect(byId.get("model:worker")).toMatchObject({ provider: "test-provider", audience: "PARTICIPANT" });
    expect(byId.get("mcp:serena")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT", roles: ["Implementer"] });
    expect(byId.get("mcp:unused")).toMatchObject({ availability: "CONFIGURED", audience: "CONTROLLER_ONLY", roles: [] });
    expect(byId.get("mcp:disabled")).toMatchObject({ availability: "DISABLED", audience: "CONTROLLER_ONLY" });
    expect(byId.get("toolchain:node")).toMatchObject({ availability: "CONFIGURED", version: "22.23.2", audience: "CONTROLLER_ONLY" });
    expect(byId.get("toolchain:playwright")).toMatchObject({ availability: "UNKNOWN", audience: "CONTROLLER_ONLY" });
    expect(byId.get("validator:playwright")).toMatchObject({ availability: "CONFIGURED", audience: "CONTROLLER_ONLY" });
    expect(byId.get("aeh:browser-validation")).toMatchObject({ availability: "CONFIGURED", audience: "CONTROLLER_ONLY" });
    expect(byId.get("delivery:github")).toMatchObject({ availability: "CONFIGURED", audience: "CONTROLLER_ONLY", sideEffectClass: "EXTERNAL_EFFECT" });
    expect(byId.get("aeh:structured-result-submission")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT" });
    expect(byId.get("aeh:supervisor-recovery")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT", roles: ["Operation Supervisor"], sideEffectClass: "CONTROLLER_INTERNAL" });
    expect(byId.get("aeh:lead-recovery")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT", roles: ["Lead/Director"], sideEffectClass: "CONTROLLER_INTERNAL" });
    expect(byId.get("aeh:operation-control")).toMatchObject({ availability: "CONFIGURED", audience: "PARTICIPANT", roles: ["Lead/Director"], skillRefs: ["aeh-operation-control"] });
    expect(byId.get("toolpack:Lead/Director:operation-control")).toMatchObject({ audience: "PARTICIPANT", roles: ["Lead/Director"], skillRefs: ["aeh-operation-control"] });
    expect(byId.get("toolpack:Operation Supervisor:operation-control")).toBeUndefined();
    expect(byId.get("aeh:validation-invocation")).toMatchObject({ audience: "CONTROLLER_ONLY", roles: [] });
    expect(JSON.stringify(result)).not.toContain("https://example.invalid/mcp");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("discovers toolchain and provider versions from project-local source files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-capability-registry-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), [
        "version: 1",
        "manager: { provider: mise, lockFile: .harness/toolchain.lock.json }",
        "tools:",
        "  node: { kind: mise, command: node, source: node, version: '22' }"
      ].join("\n"));
      await fs.writeFile(path.join(root, ".harness", "toolchain.lock.json"), JSON.stringify({
        version: 1, generatedAt: "2026-10-02T00:00:00.000Z", profile: "core",
        tools: { node: { command: "node", provisioning: "mise", resolvedVersion: "22.23.2" } }
      }));
      await fs.writeFile(path.join(root, ".harness", "provider-versions.json"), JSON.stringify({ serena: "1.6.1" }));
      const discovered = await discoverCapabilityRegistryV1(root, { config, executionCatalog: catalog, topology });
      expect(discovered.capabilities.find((item) => item.id === "toolchain:node")).toMatchObject({ version: "22.23.2", availability: "CONFIGURED" });
      expect(discovered.capabilities.find((item) => item.id === "context:semantic-retrieval")).toMatchObject({ version: "1.6.1", provider: "serena" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists and loads the frozen operation registry from the control root for an isolated Change workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-capability-workspace-"));
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-capability-control-"));
    const previous = {
      operationId: process.env.AEH_OPERATION_ID,
      controlRoot: process.env.AEH_CONTROL_ROOT,
      redirect: process.env.AEH_OPERATION_STATE_REDIRECT
    };
    process.env.AEH_OPERATION_ID = "op-fixture";
    process.env.AEH_CONTROL_ROOT = controlRoot;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    try {
      const frozen = registry();
      const persisted = await persistOperationCapabilityRegistryV1(workspaceRoot, frozen);
      const controlArtifact = path.join(controlRoot, ".harness", "operations", "op-fixture", "capability-registry-v1.json");
      const workspaceArtifact = path.join(workspaceRoot, ".harness", "operations", "op-fixture", "capability-registry-v1.json");

      expect(persisted.digest).toBe(frozen.digest);
      expect(JSON.parse(await fs.readFile(controlArtifact, "utf8"))).toMatchObject({ operationId: "op-fixture", digest: frozen.digest });
      await expect(fs.access(workspaceArtifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(loadOperationCapabilityRegistryV1(workspaceRoot, "op-fixture")).resolves.toMatchObject({ digest: frozen.digest, operationId: "op-fixture" });
    } finally {
      if (previous.operationId === undefined) delete process.env.AEH_OPERATION_ID; else process.env.AEH_OPERATION_ID = previous.operationId;
      if (previous.controlRoot === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previous.controlRoot;
      if (previous.redirect === undefined) delete process.env.AEH_OPERATION_STATE_REDIRECT; else process.env.AEH_OPERATION_STATE_REDIRECT = previous.redirect;
      await Promise.all([
        fs.rm(workspaceRoot, { recursive: true, force: true }),
        fs.rm(controlRoot, { recursive: true, force: true })
      ]);
    }
  });

  it("projects only role- and WorkUnit-relevant guidance, without projecting controller capabilities as tools", () => {
    const projection = projectOperationalSkillsV1({
      role: "Implementer",
      workUnitCapabilityIds: ["aeh:browser-validation"],
      capabilityRegistry: registry()
    });
    expect(projection.skills.map((item) => item.id)).toEqual(["playwright-browser-validation"]);
    expect(projection.skills[0]).toMatchObject({ accessMode: "CONTROLLER_GUIDANCE", certificationStatus: "UNCERTIFIED", projectionReasons: ["WORK_UNIT_CAPABILITY"] });
    expect(projection).toMatchObject({ operationId: "op-fixture", capabilityRegistryDigest: registry().digest });
    expect(projection.skills[0]).not.toHaveProperty("tools");
    const browserCapability = registry().capabilities.find((item) => item.id === "aeh:browser-validation");
    expect(browserCapability?.audience).toBe("CONTROLLER_ONLY");

    const nodeSkills = projectOperationalSkillsV1({
      role: "Implementer",
      toolPack: ["repository-read", "command-execute"],
      capabilityRegistry: registry()
    });
    expect(nodeSkills.skills.map((item) => item.id)).toEqual(["npm-node-validation"]);

    const deliverySkills = projectOperationalSkillsV1({
      role: "Operation Supervisor",
      workUnitCapabilityIds: ["delivery:github"],
      capabilityRegistry: registry()
    });
    expect(deliverySkills.skills.map((item) => item.id)).toEqual(["aeh-delivery", "github-pr-delivery"]);
  });

  it("projects operation-control guidance to the interactive Lead role only", () => {
    const registryValue = registry();
    const lead = projectOperationalSkillsV1({ role: "Lead/Director", workUnitCapabilityIds: ["aeh:operation-control"], capabilityRegistry: registryValue });
    const supervisor = projectOperationalSkillsV1({ role: "Operation Supervisor", workUnitCapabilityIds: ["aeh:operation-control"], capabilityRegistry: registryValue });
    const explorer = projectOperationalSkillsV1({ role: "Explorer", workUnitCapabilityIds: ["aeh:operation-control"], capabilityRegistry: registryValue });

    expect(lead.skills.map((item) => item.id)).toContain("aeh-operation-control");
    expect(supervisor.skills.map((item) => item.id)).not.toContain("aeh-operation-control");
    expect(explorer.skills.map((item) => item.id)).not.toContain("aeh-operation-control");
    expect(lead.skills.find((item) => item.id === "aeh-operation-control")).toMatchObject({ accessMode: "CONTROLLER_GUIDANCE", capabilityRefs: ["aeh:operation-control", "toolpack:Lead/Director:operation-control"] });
  });

  it("uses observed failures for just-in-time recovery and exposes certification drift", () => {
    const skills = OPERATIONAL_SKILLS_V1.filter((skill) => skill.id === "playwright-browser-validation");
    const recovery = projectOperationalSkillsV1({
      role: "Implementer",
      observedFailure: { capabilityId: "aeh:browser-validation", failureClass: "UNAVAILABLE" },
      capabilityRegistry: registry(),
      skills
    });
    expect(recovery.skills.map((item) => item.id)).toEqual(["playwright-browser-validation"]);
    expect(recovery.skills[0]).toMatchObject({ relevantFailures: ["UNAVAILABLE"], projectionReasons: ["OBSERVED_FAILURE"] });
    expect(recovery.skills[0]?.recovery).toEqual([{ failureClass: "UNAVAILABLE", steps: ["Report the exact missing browser capability to the Supervisor for toolchain or session recovery."] }]);

    const certifiedFixture: OperationalSkillV1 = {
      version: 1,
      id: "fixture-versioned-skill",
      skillVersion: "1.0.0",
      name: "Versioned fixture",
      description: "Fixture for certification drift.",
      applicableCapabilities: ["toolchain:node"],
      roles: ["Implementer"],
      preconditions: [],
      procedure: ["Inspect the configured version."],
      failureModes: [],
      evidenceRequirements: ["tool version"],
      forbiddenUses: ["Do not gain tools."],
      guidanceOnly: false,
      procedureVersion: "1.0.0",
      certificationEvidence: [{ capabilityId: "toolchain:node", capabilityVersion: "20.0.0", procedureVersion: "1.0.0", evidenceRef: "cert://fixture/node20" }]
    };
    const drift = projectOperationalSkillsV1({
      role: "Implementer",
      workUnitCapabilityIds: ["toolchain:node"],
      capabilityRegistry: registry(),
      skills: [certifiedFixture]
    });
    expect(drift.skills[0]?.certificationStatus).toBe("VERSION_MISMATCH");
    expect(drift.skills[0]?.certificationEvidenceRefs).toEqual(["cert://fixture/node20"]);
  });
});
