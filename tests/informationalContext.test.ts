import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerInformationalRequest } from "../src/informational/answer.js";
import { retrieveInformationalEvidence } from "../src/informational/evidence.js";
import { resolveInformationalContextBudget } from "../src/context/budget.js";
import { estimateLegacyInformationalTokens, projectInformationalContext, type InformationalProjectionSourceInput } from "../src/context/projectors/informational.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { sha256 } from "../src/context/provenance.js";
import { initializeProject } from "../src/core/init.js";
import { createIntentDecision } from "../src/audit/intentDecision.js";
import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import type { ContextCompressionProvider } from "../src/context/compression/types.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

function config(): HarnessProjectConfig {
  return { version: 1, project: { name: "informational-test" }, telemetry: { enabled: false }, context: { informational: { targetTokens: 8_000, softLimitTokens: 12_000, exceptionalTokens: 15_000, maxSources: 8, sourceSummaryTokens: 180 }, semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false } } };
}

describe("repository-grounded informational projection", () => {
  it("keeps the real informational route operation-free and substantially smaller than its former payload", async () => {
    const root = await fixtureRoot(8);
    const answer = await answerInformationalRequest(root, config(), "Explain how the validation system works.");
    expect(answer.intent).toBe("informational");
    expect(answer.sources).toHaveLength(8);
    expect(answer.sources[0]).not.toHaveProperty("excerpt");
    expect(answer.sources[0]).toEqual(expect.objectContaining({ path: expect.any(String), ref: expect.stringMatching(/^repo:\/\/.+#sha256=/), summary: expect.any(String) }));
    expect(answer.human).not.toContain("export const duplicate");
    expect(answer.telemetry.projectedTokens).toBeLessThan(answer.telemetry.rawEvidenceTokens);
    expect(answer.telemetry.injectedTokens).toBeLessThan(answer.telemetry.legacyEstimatedTokens);
    expect(answer.telemetry.injectedTokens).toBeLessThan(answer.telemetry.legacyEstimatedTokens * 0.4);
    expect(answer.telemetry.injectedTokens).toBeLessThan(estimateLegacyInformationalTokens(answer.sources.map((source) => ({ ...source, content: "export const duplicate = true;\n".repeat(80) }))));
    expect(answer.telemetry.duplicateTokensAvoided).toBeGreaterThan(0);
    expect(await fs.readdir(path.join(root, ".harness", "operations")).catch(() => [])).toEqual([]);
    expect(await fs.readdir(path.join(root, ".harness", "informational", "evidence"))).toHaveLength(8);
  });

  it("keeps authoritative raw evidence addressable and hash-verified", async () => {
    const root = await fixtureRoot(1);
    const answer = await answerInformationalRequest(root, config(), "Explain validation.");
    const source = answer.sources[0]!;
    const retrieved = await retrieveInformationalEvidence(root, source.ref, 10_000);
    expect(retrieved.path).toBe(source.path);
    expect(retrieved.sha256).toBe(source.sha256);
    expect(retrieved.content).toContain("validation command");
    expect(retrieved.truncated).toBe(false);
  });

  it("keeps MCP structured content compact and exposes raw evidence only on explicit request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-mcp-")); roots.push(root);
    await initializeProject(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "validation.ts"), "export const validation = true;\n");
    vi.stubEnv("AEH_CONTROL_ROOT", root);
    const context = await handleOperationMcpRequest({ method: "tools/call", params: { name: "aeh_informational_context", arguments: { request: "Explain validation", intentDecision: createIntentDecision("informational", "explain validation", "lead-semantic") } } });
    const value = context.structuredContent as { sources: Array<Record<string, unknown>>; human: string };
    expect(value.sources[0]).not.toHaveProperty("excerpt");
    expect(value.human).not.toContain("[bounded informational evidence;");
    const evidenceRef = (value.sources.find((source) => source.path === "src/validation.ts") ?? value.sources[0])?.ref as string;
    const evidence = await handleOperationMcpRequest({ method: "tools/call", params: { name: "aeh_informational_evidence", arguments: { evidenceRef, maxTokens: 60 } } });
    expect((evidence.content?.[0] as { text: string }).text).toContain("export const");
    expect(evidence.structuredContent).not.toHaveProperty("content");
  });

  it("deduplicates equivalent source representations without semantic or provenance loss", () => {
    const content = "export const check = 'FAIL';\nconsole.warn('uncertain security behavior');\n";
    const source = input("src/check.ts", content, "validation");
    const projection = projectInformationalContext("Explain validation", "filesystem", [source, source, { ...source, ref: `${source.ref}-duplicate` }], resolveInformationalContextBudget(config()));
    expect(projection.sources).toHaveLength(1);
    expect(projection.claims.some((claim) => claim.text.includes("FAIL"))).toBe(true);
    expect(projection.claims.some((claim) => claim.text.includes("security"))).toBe(true);
    expect(projection.claims.find((claim) => claim.text.includes("FAIL"))?.evidenceRefs).toEqual([source.ref]);
    expect(projection.human).not.toContain(content);
  });

  it("retains PASS, FAIL, WARN, security and uncertainty signals under projection", () => {
    const content = ["PASS command check", "FAIL policy check", "WARN incomplete evidence", "security finding requires review", "uncertain provider result"].join("\n");
    const source = input("src/security-validation.ts", content, "validation and security");
    const projection = projectInformationalContext("Explain validation", "filesystem", [source], resolveInformationalContextBudget(config()));
    for (const signal of ["PASS", "FAIL", "WARN", "security", "uncertain"]) expect(JSON.stringify(projection)).toContain(signal);
  });

  it("invokes Headroom only after deterministic projection and keeps claims/refs outside compression", async () => {
    const root = await fixtureRoot(1);
    const compressor: ContextCompressionProvider = { name: "headroom", doctor: async () => ({ ok: true, message: "fixture" }), compress: async (request) => ({ content: "compressed supporting summary", provider: "headroom", providerVersion: "fixture", reversible: false, originalTokens: 100, compressedTokens: 4 }) };
    const answer = await answerInformationalRequest(root, { ...config(), context: { ...config().context, informational: { targetTokens: 1, softLimitTokens: 100, exceptionalTokens: 1000 }, compression: { provider: "headroom", required: true } } }, "Explain validation", { compressor });
    expect(answer.telemetry.headroomAttempted).toBe(true);
    expect(answer.telemetry.headroomApplied).toBe(true);
    expect(answer.summary).toBe("compressed supporting summary");
    expect(answer.sources[0]?.ref).toMatch(/^repo:\/\//);
    expect(answer.claims.some((claim) => claim.evidenceRefs?.length)).toBe(true);
  });

  it("scales with summarized evidence rather than full source content", () => {
    const budget = resolveInformationalContextBudget(config());
    const make = (count: number, size: number): InformationalProjectionSourceInput[] => Array.from({ length: count }, (_, index) => input(`src/file-${index}.ts`, `export const validation${index} = true;\n${"supporting source line\n".repeat(size)}`, "validation"));
    const one = projectInformationalContext("Explain validation", "filesystem", make(1, 300), budget);
    const five = projectInformationalContext("Explain validation", "filesystem", make(5, 300), budget);
    const ten = projectInformationalContext("Explain validation", "filesystem", make(10, 300), budget);
    expect(one.metrics.projectedTokens).toBeLessThan(five.metrics.projectedTokens);
    expect(five.metrics.projectedTokens).toBeLessThan(ten.metrics.projectedTokens);
    expect(ten.metrics.projectedTokens).toBeLessThan(ten.metrics.rawEvidenceTokens * 0.4);
  });
});

async function fixtureRoot(count: number): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-")); roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < count; index += 1) await fs.writeFile(path.join(root, "src", `validation-${index}.ts`), `export const validation${index} = true;\n// validation command maps PASS/WARN/FAIL results to a report\n${"supporting source line\n".repeat(80)}`);
  return root;
}

function input(filePath: string, content: string, relevance: string): InformationalProjectionSourceInput {
  const digest = sha256(content);
  return { path: filePath, ref: `repo://${filePath}#sha256=${digest}`, sha256: digest, relevance, content };
}
