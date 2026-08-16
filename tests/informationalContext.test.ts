import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerInformationalRequest } from "../src/informational/answer.js";
import { informationalEvidenceRef, parseInformationalEvidenceRef, retrieveInformationalEvidence } from "../src/informational/evidence.js";
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
  return { version: 1, project: { name: "informational-test" }, telemetry: { enabled: true }, context: { informational: { targetTokens: 8_000, softLimitTokens: 12_000, exceptionalTokens: 15_000, maxSources: 8, sourceSummaryTokens: 180, maxInitialBytesPerSource: 4_000, maxInitialBytesTotal: 20_000 }, semanticRetrieval: { provider: "none", required: false }, compression: { provider: "none", required: false } } };
}

describe("repository-grounded informational projection", () => {
  it("is operation-free, read-only, and substantially smaller than the faithful legacy payload estimate", async () => {
    const root = await fixtureRoot(8);
    const before = await snapshot(root);
    const answer = await answerInformationalRequest(root, config(), "Explain how the validation system works.");
    expect(await snapshot(root)).toEqual(before);
    expect(answer.intent).toBe("informational");
    expect(answer.sources).toHaveLength(8);
    expect(answer.sources[0]).not.toHaveProperty("excerpt");
    expect(answer.sources[0]).toEqual(expect.objectContaining({ path: expect.any(String), fileSha256: expect.stringMatching(/^[a-f0-9]{64}$/), ref: expect.stringMatching(/^repo:\/\/.+#sha256=[a-f0-9]{64}&file-sha256=[a-f0-9]{64}&range=\d+-\d+$/), summary: expect.any(String) }));
    expect(answer.human).not.toContain("export const duplicate");
    expect(answer.telemetry.projectedPayloadTokens).toBeLessThan(answer.telemetry.rawEvidenceTokens);
    expect(answer.telemetry.informationalPayloadTokens).toBeLessThan(answer.telemetry.legacyPayloadTokens);
    expect(answer.telemetry.informationalPayloadTokens).toBeLessThan(answer.telemetry.legacyPayloadTokens * 0.4);
    expect(answer.telemetry.duplicatePayloadTokensAvoided).toBeGreaterThan(0);
    await expect(fs.access(path.join(root, ".harness"))).rejects.toThrow();
  });

  it("uses the exact former source caps and response shape for the legacy benchmark", async () => {
    const fixture = JSON.parse(await fs.readFile(path.join(process.cwd(), "tests/fixtures/informational/h01.json"), "utf8")) as { request: string; sources: Array<{ path: string; content: string }> };
    const sources = fixture.sources.map((source) => input(source.path, source.content, "validation"));
    const budget = resolveInformationalContextBudget(config());
    const projection = projectInformationalContext(fixture.request, "filesystem", sources, budget);
    expect(projection.metrics.legacyPayloadTokens).toBe(estimateLegacyInformationalTokens(sources, "filesystem"));
    expect(projection.metrics.legacyPayloadTokens).toBeGreaterThan(projection.metrics.informationalPayloadTokens);
    expect(projection.metrics.legacyPayloadTokens).toBeGreaterThan(0);
    expect(projection.metrics.projectedPayloadTokens).toBeLessThan(projection.metrics.legacyPayloadTokens);
  });

  it("retrieves direct live evidence and rejects stale and forged path/hash references", async () => {
    const root = await fixtureRoot(2);
    const answer = await answerInformationalRequest(root, config(), "Explain validation.");
    const source = answer.sources[0]!;
    const retrieved = await retrieveInformationalEvidence(root, source.ref, 10_000);
    expect(retrieved.path).toBe(source.path);
    expect(retrieved.sha256).toBe(source.sha256);
    expect(retrieved.content).toContain("validation command");
    expect(retrieved.truncated).toBe(false);
    const otherPath = source.path.endsWith("0.ts") ? source.path.replace("0.ts", "1.ts") : "src/validation-1.ts";
    const range = retrieved.range ?? { startByte: 0, endByte: Buffer.byteLength(retrieved.content) };
    const forged = informationalEvidenceRef(otherPath, source.sha256, range);
    await expect(retrieveInformationalEvidence(root, forged)).rejects.toThrow(/INFORMATIONAL_EVIDENCE_STALE|INFORMATIONAL_EVIDENCE_SOURCE_UNAVAILABLE/);
    await fs.writeFile(path.join(root, source.path), "export const changed = true;\n");
    await expect(retrieveInformationalEvidence(root, source.ref)).rejects.toThrow("INFORMATIONAL_EVIDENCE_STALE");
  });

  it("progresses from the selected range to a later bounded range without changing file provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-locator-")); roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const prefix = "export const validation = true;\n";
    const content = `${prefix}${"padding\n".repeat(900)}export const laterImplementation = true;\n`;
    await fs.writeFile(path.join(root, "src", "validation.ts"), content);
    const answer = await answerInformationalRequest(root, config(), "Explain validation.");
    const source = answer.sources.find((candidate) => candidate.path === "src/validation.ts")!;
    const parsed = parseInformationalEvidenceRef(source.ref);
    const laterStart = Buffer.byteLength(`${prefix}${"padding\n".repeat(900)}`);
    const laterEnd = Buffer.byteLength(content);
    const laterRef = informationalEvidenceRef(source.path, source.sha256, parsed.range, { fileSha256: source.fileSha256, requestedRange: { startByte: laterStart, endByte: laterEnd } });
    const later = await retrieveInformationalEvidence(root, laterRef, 100);
    expect(later.content).toContain("laterImplementation");
    expect(later.range).toEqual({ startByte: laterStart, endByte: laterEnd });
    expect(later.selectedRange).toEqual(parsed.range);
    expect(later.fileSha256).toBe(source.fileSha256);
  });

  it("rejects mutation outside the initially selected range", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-mutation-")); roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "validation.ts");
    await fs.writeFile(file, `export const validation = true;\n${"stable padding\n".repeat(700)}original tail\n`);
    const answer = await answerInformationalRequest(root, config(), "Explain validation.");
    const source = answer.sources.find((candidate) => candidate.path === "src/validation.ts")!;
    const current = await fs.readFile(file, "utf8");
    await fs.writeFile(file, `${current.slice(0, 4_000)}mutated tail\n`);
    await expect(retrieveInformationalEvidence(root, source.ref)).rejects.toThrow("INFORMATIONAL_EVIDENCE_STALE");
  });

  it("rejects traversal, absolute, and symlink-escape evidence paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-paths-")); roots.push(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-outside-")); roots.push(outside);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(outside, "secret.ts"), "export const secret = true;\n");
    await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src", "linked.ts"));
    const digest = sha256("export const secret = true;\n");
    for (const ref of [
      informationalEvidenceRef("../secret.ts", digest),
      informationalEvidenceRef("/tmp/secret.ts", digest),
      informationalEvidenceRef("src/linked.ts", digest)
    ]) await expect(retrieveInformationalEvidence(root, ref)).rejects.toThrow(/INFORMATIONAL_EVIDENCE_REF_INVALID|INFORMATIONAL_EVIDENCE_SOURCE_UNAVAILABLE/);
  });

  it("deduplicates repository-map symbols before consuming source slots and read budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-map-")); roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all(["a", "b", "c"].map((name) => fs.writeFile(path.join(root, "src", `${name}.ts`), `export const validation${name} = true;\n`)));
    await fs.mkdir(path.join(root, "graphify-out"), { recursive: true });
    const nodes = [
      ...Array.from({ length: 20 }, (_, index) => ({ id: `a-${index}`, label: `validation-a-${index}`, file: "src/a.ts" })),
      { id: "b", label: "validation-b", file: "src/b.ts" },
      { id: "c", label: "validation-c", file: "src/c.ts" }
    ];
    await fs.writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes, edges: [] }));
    const answer = await answerInformationalRequest(root, { ...config(), context: { ...config().context, informational: { ...config().context?.informational, maxSources: 2, maxInitialBytesPerSource: 100, maxInitialBytesTotal: 200 } } }, "Explain validation.");
    expect(answer.sources.map((source) => source.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(answer.inspected.fileCount).toBe(2);
    expect(answer.telemetry.rawEvidenceTokens).toBeLessThanOrEqual(50);
  });

  it("keeps MCP structured content compact and exposes raw evidence only on explicit request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-mcp-")); roots.push(root);
    await initializeProject(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "validation.ts"), "export const validation = true;\n");
    const before = await snapshot(root);
    vi.stubEnv("AEH_CONTROL_ROOT", root);
    const context = await handleOperationMcpRequest({ method: "tools/call", params: { name: "aeh_informational_context", arguments: { request: "Explain validation", intentDecision: createIntentDecision("informational", "explain validation", "lead-semantic") } } });
    expect(await snapshot(root)).toEqual(before);
    const value = context.structuredContent as { sources: Array<Record<string, unknown>>; human: string };
    expect(value.sources[0]).not.toHaveProperty("excerpt");
    expect(value.human).not.toContain("[bounded informational evidence;");
    const evidenceRef = (value.sources.find((source) => source.path === "src/validation.ts") ?? value.sources[0])?.ref as string;
    const evidence = await handleOperationMcpRequest({ method: "tools/call", params: { name: "aeh_informational_evidence", arguments: { evidenceRef, maxTokens: 60 } } });
    expect((evidence.content?.[0] as { text: string }).text).toContain("export const");
    expect(evidence.structuredContent).not.toHaveProperty("artifact");
    expect(evidence.structuredContent).not.toHaveProperty("content");
  });

  it("deduplicates equivalent source representations without inventing verified runtime findings", () => {
    const content = "export const check = 'FAIL';\nconsole.warn('uncertain security behavior');\n";
    const source = input("src/check.ts", content, "validation");
    const projection = projectInformationalContext("Explain validation", "filesystem", [source, source, { ...source, ref: `${source.ref}-duplicate` }], resolveInformationalContextBudget(config()));
    expect(projection.sources).toHaveLength(1);
    expect(projection.claims.every((claim) => !/\b(PASS|FAIL|WARN|security|uncertain)\b/i.test(claim.text))).toBe(true);
    expect(projection.sources[0]?.summary).toContain("Implementation signals");
    expect(projection.human).not.toContain(content);
  });

  it("keeps path and digest identity distinct when either component changes", () => {
    const first = input("src/a.ts", "export const same = true;\n", "repository");
    const secondContent = "export const changed = false;\n";
    const samePathDifferentHash = { ...input("src/a.ts", secondContent, "repository") };
    const differentPathSameHash = { ...first, path: "src/b.ts", ref: informationalEvidenceRef("src/b.ts", first.sha256) };
    const projection = projectInformationalContext("Explain the repository", "filesystem", [first, samePathDifferentHash, differentPathSameHash], resolveInformationalContextBudget(config()));
    expect(projection.sources.map((source) => source.path)).toEqual(["src/a.ts", "src/a.ts", "src/b.ts"]);
  });

  it("does not promote source-code status strings to verified claims while preserving implementation context", () => {
    const content = ["PASS command check", "FAIL policy check", "WARN incomplete evidence", "security finding requires review", "uncertain provider result"].join("\n");
    const source = input("src/security-validation.ts", content, "validation and security");
    const projection = projectInformationalContext("Explain validation", "filesystem", [source], resolveInformationalContextBudget(config()));
    expect(projection.claims).toHaveLength(2);
    expect(projection.claims.map((claim) => claim.text).join("\n")).not.toMatch(/PASS|FAIL|WARN|security|uncertain/);
    expect(JSON.stringify(projection.sources)).toContain("Implementation signals");
  });

  it("invokes Headroom only after deterministic projection and keeps claims/refs outside compression", async () => {
    const root = await fixtureRoot(1);
    const compressor: ContextCompressionProvider = { name: "headroom", doctor: async () => ({ ok: true, message: "fixture" }), compress: async () => ({ content: "compressed supporting summary", provider: "headroom", providerVersion: "fixture", reversible: false, originalTokens: 100, compressedTokens: 4 }) };
    const answer = await answerInformationalRequest(root, { ...config(), context: { ...config().context, informational: { targetTokens: 1, softLimitTokens: 100, exceptionalTokens: 1000 }, compression: { provider: "headroom", required: true } } }, "Explain validation", { compressor });
    expect(answer.telemetry.headroomAttempted).toBe(true);
    expect(answer.telemetry.headroomApplied).toBe(true);
    expect(answer.summary).toBe("compressed supporting summary");
    expect(answer.sources[0]?.ref).toMatch(/^repo:\/\//);
    expect(answer.claims.some((claim) => claim.evidenceRefs?.length)).toBe(true);
  });

  it("scales with summarized evidence rather than full source content and enforces configured initial bounds", () => {
    const budget = resolveInformationalContextBudget(config());
    expect(budget.maxInitialBytesPerSource).toBe(4_000);
    expect(budget.maxInitialBytesTotal).toBe(20_000);
    expect(() => resolveInformationalContextBudget({ ...config(), context: { informational: { maxInitialBytesPerSource: 5_000, maxInitialBytesTotal: 4_000 } } })).toThrow(/total initial byte limit/);
    expect(() => resolveInformationalContextBudget({ ...config(), context: { informational: { maxSources: 0 } } })).toThrow(/positive integers/);
    const make = (count: number, size: number): InformationalProjectionSourceInput[] => Array.from({ length: count }, (_, index) => input(`src/file-${index}.ts`, `export const validation${index} = true;\n${"supporting source line\n".repeat(size)}`, "validation"));
    const one = projectInformationalContext("Explain validation", "filesystem", make(1, 300), budget);
    const five = projectInformationalContext("Explain validation", "filesystem", make(5, 300), budget);
    const ten = projectInformationalContext("Explain validation", "filesystem", make(10, 300), budget);
    expect(one.metrics.projectedPayloadTokens).toBeLessThan(five.metrics.projectedPayloadTokens);
    expect(five.metrics.projectedPayloadTokens).toBeLessThan(ten.metrics.projectedPayloadTokens);
    expect(ten.metrics.projectedPayloadTokens).toBeLessThan(ten.metrics.rawEvidenceTokens * 0.4);
  });

  it("bounds the initial read without loading a complete large source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-informational-large-")); roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "validation.ts"), `export const validation = true;\n${"x".repeat(80_000)}`);
    const answer = await answerInformationalRequest(root, config(), "Explain validation.");
    const source = answer.sources.find((candidate) => candidate.path === "src/validation.ts")!;
    const range = /&range=(\d+)-(\d+)$/.exec(source.ref)!;
    expect(Number(range[2]) - Number(range[1])).toBeLessThanOrEqual(4_000);
    expect(answer.telemetry.rawEvidenceTokens).toBeLessThan(1_200);
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
  return { path: filePath, ref: informationalEvidenceRef(filePath, digest), sha256: digest, relevance, content };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else result[relative] = (await fs.readFile(absolute)).toString("base64");
    }
  }
  await visit(root, "");
  return result;
}
