import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandExists, runProcess } from "../src/utils/process.js";
import { HeadroomCompressionProvider } from "../src/context/compression/headroom.js";
import { GraphifyCodeIntelligenceProvider } from "../src/providers/graphify.js";
import { EngramMemoryProvider } from "../src/providers/engram.js";
import { SerenaSemanticProvider } from "../src/context/repository/serena.js";
import { SERENA_VERSION } from "../src/context/repository/serena.js";
import { HEADROOM_VERSION } from "../src/context/compression/headroom.js";
import { runSerenaMcpContract } from "../src/providers/serenaMcp.js";
import { runExternalToolValidator } from "../src/validators/external.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const realProviders = process.env.AEH_RUN_REAL_PROVIDERS === "1";
const describeReal = realProviders ? describe : describe.skip;
const config: HarnessProjectConfig = { version: 1, project: { name: "provider-contracts" }, codeIntelligence: { provider: "graphify", required: true } };

describeReal("real local provider contracts", () => {
  it("compresses through the pinned Headroom SDK bridge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-headroom-contract-"));
    try {
      expect(await commandExists("headroom", root)).toBe(true);
      const provider = new HeadroomCompressionProvider(); expect((await provider.doctor(root)).ok).toBe(true);
      const content = "A bounded local compression contract should preserve the raw artifact outside the provider and return a typed response. ".repeat(20);
      const result = await provider.compress(root, { operationId: "HEADROOM-1", fragment: { id: "source", kind: "tool-output", preservation: "COMPRESSIBLE", priority: 1, content }, maxTokens: 80, sourceSha256: crypto.createHash("sha256").update(content).digest("hex") });
      expect(result.providerVersion).toBe(HEADROOM_VERSION); expect(result.content).toBeTruthy();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("generates and reloads a canonical Graphify graph without refreshCommand", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-graphify-contract-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n"); await runProcess("git init -q && git config user.email aeh@example.invalid && git config user.name AEH && git add . && git commit -qm base", { cwd: root, timeoutMs: 30_000 });
      const provider = new GraphifyCodeIntelligenceProvider(config); await provider.refresh(root); expect(await provider.load(root)).toBeTruthy(); expect(await provider.isFresh(root)).toBe(true); await fs.appendFile(path.join(root, "src", "a.ts"), "export const b = 2;\n"); expect(await provider.isFresh(root)).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("stores and recalls Engram in isolated namespaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-engram-contract-"));
    try {
      expect(await commandExists("engram", root)).toBe(true); const a = new EngramMemoryProvider(root); const id = await a.remember({ project: "namespace-a", type: "discovery", title: "isolated marker", content: "namespace-a-only" }); expect(id).toBeTruthy(); expect((await a.recall("namespace-a", "namespace-a-only")).length).toBeGreaterThan(0); expect((await a.recall("namespace-b", "namespace-a-only")).length).toBe(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("performs a real Serena MCP initialize/tools/call contract", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-serena-contract-")); try { await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.writeFile(path.join(root, "src", "serena-fixture.ts"), "export function SerenaFixtureSymbol(): boolean { return true; }\n"); expect(await commandExists("serena", root)).toBe(true); const health = await new SerenaSemanticProvider().doctor(root); expect(health.ok).toBe(true); expect(health.version).toContain(SERENA_VERSION); const result = await runSerenaMcpContract(root); expect(result.initialized).toBe(true); expect(result.toolNames).toContain("get_symbols_overview"); expect(result.retrievalText).toContain("SerenaFixtureSymbol"); } finally { await fs.rm(root, { recursive: true, force: true }); } }, 180_000);

  it("executes the production Trivy JSON boundary", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-trivy-contract-")); try { expect(await commandExists("trivy", root)).toBe(true); const check = await runExternalToolValidator({ root, config: { version: 1, project: { name: "trivy-contract" }, evidence: { outputDir: ".harness/evidence" } }, contract: { version: 1, task: { id: "TRIVY-1", title: "Trivy contract" } }, spec: { id: "trivy", adapter: "trivy", required: true }, baseRef: "HEAD", changedFiles: [] }); expect(check.status).toBe("PASS"); expect(check.details?.evidenceFormat).toBe("stdout-json"); expect(check.details?.rawArtifact).toBe(".harness/evidence/trivy.raw"); } finally { await fs.rm(root, { recursive: true, force: true }); } }, 120_000);

  it("executes the pinned OpenGrep JSON boundary and preserves findings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-opengrep-contract-"));
    try {
      await fs.mkdir(path.join(root, "rules"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "rules", "aeh.yml"), "rules:\n  - id: aeh-eval\n    languages: [javascript]\n    message: eval is forbidden\n    severity: ERROR\n    pattern: eval(...)\n");
      await fs.writeFile(path.join(root, "src", "fixture.js"), "eval(\"fixture\");\n");
      const check = await runExternalToolValidator({ root, config: { version: 1, project: { name: "opengrep-contract" }, evidence: { outputDir: ".harness/evidence" } }, contract: { version: 1, task: { id: "OPENGREP-1", title: "OpenGrep contract" } }, spec: { id: "opengrep", adapter: "opengrep", required: true, command: "opengrep scan --json --error -f rules/aeh.yml src" }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.details?.evidenceFormat).toBe("stdout-json");
      expect(check.details?.findingCount).toBe(1);
      expect((check.details?.findings as Array<{ tool: string }>)[0]?.tool).toBe("opengrep");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("executes the pinned Playwright JSON reporter and retains attachment references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-playwright-contract-"));
    const repository = process.cwd();
    try {
      const packagePath = JSON.stringify(path.join(repository, "node_modules", "@playwright", "test"));
      await fs.writeFile(path.join(root, "playwright.config.cjs"), `const { defineConfig } = require(${packagePath}); module.exports = defineConfig({ testDir: ".", workers: 1, use: { headless: true } });\n`);
      await fs.writeFile(path.join(root, "playwright-fixture.spec.cjs"), `const { test, expect } = require(${packagePath});\ntest("PW-1 browser contract", async ({ page }, testInfo) => { await page.setContent("<main>fixture</main>"); const screenshot = testInfo.outputPath("failure.png"); await page.screenshot({ path: screenshot }); await testInfo.attach("failure-screenshot", { path: screenshot, contentType: "image/png" }); await expect(page.locator("main")).toContainText("missing"); });\n`);
      const playwright = shellQuote(path.join(repository, "node_modules", ".bin", "playwright"));
      const check = await runExternalToolValidator({ root, config: { version: 1, project: { name: "playwright-contract" }, evidence: { outputDir: ".harness/evidence" } }, contract: { version: 1, task: { id: "PW-1", title: "Playwright contract" } }, spec: { id: "playwright", adapter: "playwright", required: true, command: `${playwright} test --config playwright.config.cjs --grep "PW-1" --reporter=json` }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.details?.evidenceFormat).toBe("stdout-json");
      expect(check.details?.findingCount).toBe(1);
      const finding = (check.details?.findings as Array<{ kind: string; details?: { attachments?: unknown[] } }>)[0];
      expect(finding?.kind).toBe("failed-test");
      expect(finding?.details?.attachments?.length).toBeGreaterThan(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 180_000);
});

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
