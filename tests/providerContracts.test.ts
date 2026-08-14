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
      expect(result.providerVersion).toBe("0.28.0"); expect(result.content).toBeTruthy();
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

  it("verifies Serena's pinned executable contract", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-serena-contract-")); try { expect(await commandExists("serena", root)).toBe(true); expect((await new SerenaSemanticProvider().doctor(root)).ok).toBe(true); } finally { await fs.rm(root, { recursive: true, force: true }); } }, 120_000);

  it("executes the production Trivy JSON boundary", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-trivy-contract-")); try { expect(await commandExists("trivy", root)).toBe(true); const check = await runExternalToolValidator({ root, config: { version: 1, project: { name: "trivy-contract" }, evidence: { outputDir: ".harness/evidence" } }, contract: { version: 1, task: { id: "TRIVY-1", title: "Trivy contract" } }, spec: { id: "trivy", adapter: "trivy", required: true }, baseRef: "HEAD", changedFiles: [] }); expect(check.status).toBe("PASS"); expect(check.details?.evidenceFormat).toBe("stdout-json"); expect(check.details?.rawArtifact).toBe(".harness/evidence/trivy.raw"); } finally { await fs.rm(root, { recursive: true, force: true }); } }, 120_000);
});
