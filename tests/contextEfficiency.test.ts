import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContextBudget } from "../src/context/budget.js";
import { ContextBudgetGateway } from "../src/context/gateway.js";
import { verifyContextEnvelope } from "../src/context/envelope.js";
import { rankRepositoryNodes } from "../src/context/repository/rank.js";
import { ContextRetrievalGateway } from "../src/context/retrieval/gateway.js";
import { authorizeRetrieval } from "../src/context/retrieval/authorization.js";
import { recoveryHandle } from "../src/context/gateway.js";
import type { ContextCompressionProvider } from "../src/context/compression/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

function config(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "context-test" },
    telemetry: { enabled: false },
    context: {
      mode: "enforce",
      budgets: { default: { inputTokens: 12_000 }, agents: { reviewer: { inputTokens: 12_000 } } },
      semanticRetrieval: { provider: "serena", required: true },
      compression: { provider: "headroom", required: true, minTokens: 2 },
      retrieval: { maxRequestsPerTurn: 2, maxTokensPerRequest: 30, maxTotalTokensPerTurn: 40 }
    }
  };
}

const fakeCompression: ContextCompressionProvider = {
  name: "headroom",
  doctor: async () => ({ ok: true, message: "fake" }),
  compress: async (_root, request) => ({ content: "compressed error summary", provider: "headroom", providerVersion: "test", reversible: true, handle: `h-${request.fragment.id}`, originalTokens: 100, compressedTokens: 5 })
};

describe("context efficiency subsystem", () => {
  it("resolves role-aware budgets deterministically", () => {
    const budget = resolveContextBudget(config(), "reviewer", "review");
    expect(budget.maxTokens).toBe(12_000);
    expect(budget.reserved.response).toBe(1_024);
    expect(resolveContextBudget(config(), "reviewer", "review")).toEqual(budget);
  });

  it("preserves VERBATIM bytes and records envelope provenance", async () => {
    const result = await new ContextBudgetGateway("/tmp", config(), { persist: false, telemetry: false }).prepare({ operationId: "OP-1", logicalAgent: "reviewer", role: "reviewer", phase: "review", fragments: [{ id: "contract", kind: "normative", preservation: "VERBATIM", priority: 100, content: "exact\nanchor: {value}\nsha: 0123456789" }] });
    expect(result.envelope.fragments[0]?.content).toBe("exact\nanchor: {value}\nsha: 0123456789");
    expect(verifyContextEnvelope(result.envelope)).toBe(true);
  });

  it("projects validation evidence while retaining an authorized raw artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-validation-"));
    const report = { version: 1, taskId: "TASK-1", status: "FAIL", startedAt: "now", finishedAt: "now", checks: [{ id: "test", category: "test", status: "FAIL", message: "expected one received two", details: { exact: true } }], changedFiles: ["src/app.ts"], metadata: { project: "context-test", baseRef: "main" } } as const;
    const result = await new ContextBudgetGateway(root, config(), { telemetry: false }).prepare({ operationId: "OP-2", logicalAgent: "reviewer", role: "reviewer", phase: "review", fragments: [{ id: "validation", kind: "validation", preservation: "PROJECTABLE", priority: 100, content: JSON.stringify(report) }] });
    const fragment = result.envelope.fragments[0]!;
    expect(fragment.projected).toBe(true);
    expect(fragment.content).toContain("FAIL test: expected one received two");
    expect(fragment.source?.artifact).toContain(".harness/context/OP-2/validation.raw");
    const raw = await resultForRetrieval(result, root, config());
    expect(raw.content).toBe(JSON.stringify(report));
    expect(raw.sha256).toBe(fragment.source?.sha256);
  });

  it("compresses only eligible fragments and never sends normative data to the provider", async () => {
    const provider = { ...fakeCompression, compress: async (_root: string, request: Parameters<ContextCompressionProvider["compress"]>[1]) => {
      if (request.fragment.preservation !== "COMPRESSIBLE") throw new Error("normative fragment reached compressor");
      return { content: "small", provider: "headroom", reversible: true, originalTokens: 100, compressedTokens: 2 };
    } } satisfies ContextCompressionProvider;
    const result = await new ContextBudgetGateway("/tmp", config(), { persist: false, telemetry: false, compressor: provider }).prepare({ operationId: "OP-3", logicalAgent: "implementer", role: "implementer", phase: "implementation", fragments: [{ id: "normative", kind: "normative", preservation: "VERBATIM", priority: 100, content: "do not change this" }, { id: "logs", kind: "tool-output", preservation: "COMPRESSIBLE", priority: 10, content: "x".repeat(100) }] });
    expect(result.envelope.fragments.find((fragment) => fragment.id === "normative")?.content).toBe("do not change this");
    expect(result.envelope.fragments.find((fragment) => fragment.id === "logs")?.compressed).toBe(true);
  });

  it("makes compression reversibility depend on authorization and verifies byte-exact recovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-reversible-"));
    const fragment = { id: "logs", kind: "tool-output" as const, preservation: "COMPRESSIBLE" as const, priority: 10, content: "raw evidence ".repeat(100) };
    try {
      const required = new ContextBudgetGateway(root, config(), { telemetry: false, compressor: fakeCompression });
      await expect(required.prepare({ operationId: "OP-REQUIRED", logicalAgent: "implementer", phase: "implementation", fragments: [fragment], capabilities: { authorizedRetrieval: false } })).rejects.toThrow("REVERSIBILITY_UNAVAILABLE");

      const optionalConfig = { ...config(), context: { ...config().context, compression: { ...config().context?.compression, required: false, reversible: true } } } satisfies HarnessProjectConfig;
      const optional = await new ContextBudgetGateway(root, optionalConfig, { persist: false, telemetry: false, compressor: fakeCompression }).prepare({ operationId: "OP-OPTIONAL", logicalAgent: "implementer", phase: "implementation", fragments: [fragment], capabilities: { authorizedRetrieval: false } });
      expect(optional.envelope.fragments[0]?.compressed).not.toBe(true);

      const exact = await new ContextBudgetGateway(root, config(), { telemetry: false, compressor: fakeCompression }).prepare({ operationId: "OP-EXACT", logicalAgent: "implementer", phase: "implementation", fragments: [fragment] });
      const projected = exact.envelope.fragments[0]!;
      expect(projected.compressed).toBe(true);
      expect(projected.compression?.reversible).toBe(true);
      expect(projected.compression?.handle).toBe(recoveryHandle("OP-EXACT", "logs", projected.source?.sha256 ?? ""));
      const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "OP-EXACT", logicalAgent: "implementer", allowedFragmentIds: ["logs"], fragments: exact.envelope.fragments }), { maxRequestsPerTurn: 1, maxTokensPerRequest: 10_000, maxTotalTokensPerTurn: 10_000 });
      const recovered = await gateway.retrieve({ fragmentId: "logs" });
      expect(recovered.content).toBe(fragment.content);
      expect(recovered.sha256).toBe(projected.source?.sha256);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects cross-operation retrieval and path traversal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-auth-"));
    await fs.mkdir(path.join(root, ".harness/context/OP-A"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness/context/OP-A/raw"), "authorized");
    const fragment = { id: "raw", kind: "tool-output" as const, preservation: "RETRIEVABLE" as const, priority: 1, content: "authorized", source: { artifact: ".harness/context/OP-A/raw" } };
    const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "OP-A", logicalAgent: "agent-a", allowedFragmentIds: ["raw"], fragments: [fragment] }), { maxRequestsPerTurn: 2, maxTokensPerRequest: 20, maxTotalTokensPerTurn: 20 });
    await expect(gateway.retrieve({ fragmentId: "other" })).rejects.toThrow("UNAUTHORIZED");
    const traversal = { ...fragment, id: "escape", source: { artifact: "../outside" } };
    const unsafe = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "OP-A", logicalAgent: "agent-a", allowedFragmentIds: ["escape"], fragments: [traversal] }), { maxRequestsPerTurn: 2, maxTokensPerRequest: 20, maxTotalTokensPerTurn: 20 });
    await expect(unsafe.retrieve({ fragmentId: "escape" })).rejects.toThrow("PATH_REJECTED");
  });

  it("ranks explicit, changed and central repository nodes deterministically", () => {
    const ranked = rankRepositoryNodes({ provider: "graphify", nodes: [{ id: "a", file: "src/app.ts", centrality: 0.1 }, { id: "b", file: "src/other.ts", centrality: 0.9 }], edges: [] }, { explicitPaths: ["src/app.ts"], changedFiles: ["src/app.ts"] });
    expect(ranked[0]?.id).toBe("a");
    expect(ranked[0]?.reasons).toEqual(expect.arrayContaining(["explicit-scope", "changed-file"]));
  });
});

async function resultForRetrieval(result: Awaited<ReturnType<ContextBudgetGateway["prepare"]>>, root: string, _config: HarnessProjectConfig) {
  const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: result.envelope.operationId, logicalAgent: result.envelope.logicalAgent, allowedFragmentIds: result.envelope.retrieval.allowedFragmentIds, fragments: result.envelope.fragments }), { maxRequestsPerTurn: 2, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 200 });
  return gateway.retrieve({ fragmentId: "validation", section: "raw" });
}
