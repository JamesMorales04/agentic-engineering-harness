import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentContextFragments } from "../src/workers/agentPrompt.js";
import { ContextBudgetGateway } from "../src/context/gateway.js";
import { EngramMemoryProvider } from "../src/providers/engram.js";
import { GraphifyCodeIntelligenceProvider } from "../src/providers/graphify.js";
import { normalizeOpengrepOutput, normalizeTrivyOutput, normalizePlaywrightOutput } from "../src/validators/toolEvidence.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

const selection: AgentExecutionSelection = {
  logicalAgent: "worker", role: "implementer", description: "Bounded implementation charter.", domains: ["backend"], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "workhorse", modelId: "test/model", modelName: "model", transport: "direct", skills: [], mcps: [], permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", gitWrite: "deny" }, args: [], runtimeCapabilities: {}
};

describe("architecture closure contracts", () => {
  it("builds multiple typed fragments and consumes RepoMap only when enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-path-"));
    const base: HarnessProjectConfig = { version: 1, project: { name: "context-test" }, context: { repositoryMap: { enabled: true }, semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false } } };
    const contract: TaskContract = { version: 1, task: { id: "T-1", title: "typed context" }, scope: { allowed: ["src/**"] } };
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.writeFile(path.join(root, "src", "main.ts"), "export const main = true;\n");
      const enabled = await buildAgentContextFragments(root, base, contract, selection, "Implement the task", { phase: "implementation" });
      expect(enabled.fragments.map((item) => item.kind)).toEqual(expect.arrayContaining(["execution-envelope", "agent-charter", "instruction", "repository-map", "raw-evidence"]));
      expect(enabled.fragments.find((item) => item.id === "repository-map")?.content).toContain("src/main.ts");
      const disabled = await buildAgentContextFragments(root, { ...base, context: { ...base.context, repositoryMap: { enabled: false } } }, contract, selection, "Implement the task", { phase: "implementation" });
      expect(disabled.fragments.some((item) => item.id === "repository-map")).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps normative content byte-for-byte and does not advertise unavailable retrieval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-normative-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
      const exact = "version: 1\r\nrequirements:\r\n  - id: exact\r\n"; await fs.writeFile(path.join(root, ".harness", "contracts", "T-2.yaml"), exact);
      const config: HarnessProjectConfig = { version: 1, project: { name: "normative" }, context: { semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false }, repositoryMap: { enabled: false } } };
      const contract: TaskContract = { version: 1, task: { id: "T-2", title: "exact" } };
      const fragments = await buildAgentContextFragments(root, config, contract, { ...selection, runtimeAdapter: "codex", transport: "direct" }, "task", { phase: "implementation" });
      expect(fragments.fragments.find((item) => item.id === "task-contract")?.content).toBe(exact);
      const prepared = await new ContextBudgetGateway(root, config, { persist: false, telemetry: false }).prepare({ operationId: "T-2", logicalAgent: "worker", phase: "implementation", fragments: [{ id: "retrievable", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "secret raw evidence" }], capabilities: { authorizedRetrieval: false } });
      expect(prepared.rendered).not.toContain("aeh_context_retrieve");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("provides bounded, scoped memory with deduplication and supersession", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-memory-"));
    const execute = async (command: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> => ({ exitCode: 0, stdout: command.includes("recall") ? "" : "stored", stderr: "", durationMs: 1 });
    try {
      const provider = new EngramMemoryProvider(root, { executor: execute });
      const first = { project: "p", type: "decision", title: "Use Graphify", content: "Use the graph for topology", source: "README.md" } as const;
      const id = await provider.remember(first); expect(id).toBeTruthy(); expect(await provider.remember(first)).toBe(id);
      const records = await provider.recall("p", "topology"); expect(records).toHaveLength(1); expect(records[0].content).toContain("topology");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("normalizes security and browser findings with stable fingerprints", () => {
    const opengrep = normalizeOpengrepOutput({ results: [{ check_id: "xss", path: "src/a.ts", start: { line: 4, col: 2 }, extra: { message: "unsafe", metadata: { severity: "HIGH", cwe: ["CWE-79"] } } }] });
    const trivy = normalizeTrivyOutput({ Results: [{ Target: "package-lock.json", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "x", InstalledVersion: "1", FixedVersion: "2", Severity: "HIGH" }] }] });
    const playwright = normalizePlaywrightOutput({ suites: [{ specs: [{ title: "login", tests: [{ projectName: "chromium", results: [{ status: "failed", duration: 12, error: { message: "boom" } }] }] }] }] });
    expect(opengrep[0]).toMatchObject({ rule: "xss", file: "src/a.ts", line: 4, severity: "HIGH" });
    expect(trivy[0]).toMatchObject({ rule: "CVE-1", package: "x", installedVersion: "1", fixedVersion: "2" });
    expect(playwright[0]).toMatchObject({ kind: "failed-test", durationMs: 12 });
    expect(new Set([opengrep[0].fingerprint, trivy[0].fingerprint, playwright[0].fingerprint]).size).toBe(3);
  });

  it("loads Graphify through the provider's canonical model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-graphify-"));
    try {
      await fs.mkdir(path.join(root, "graphify-out"), { recursive: true }); await fs.writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "a", file: "src/a.ts" }], edges: [] }));
      const provider = new GraphifyCodeIntelligenceProvider({ version: 1, project: { name: "p" }, codeIntelligence: { provider: "graphify", required: true } });
      expect((await provider.load(root))).toBeTruthy(); await provider.refresh(root); expect(await provider.isFresh(root)).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
