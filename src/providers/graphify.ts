import type { HarnessProjectConfig } from "../core/types.js";
import type { CodeIntelligenceProvider, CodeImpactReport } from "./types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { loadCanonicalGraph } from "./graphifyModel.js";

export class GraphifyCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly name = "graphify";
  constructor(private readonly config?: HarnessProjectConfig) {}
  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const cli = await commandExists("graphify", root);
    const graph = await this.load(root);
    return {
      ok: Boolean(cli || graph),
      message: graph ? "Graphify graph detected and readable through the canonical AEH model." : cli ? "Graphify CLI detected but no readable graph exists; configure codeIntelligence.refreshCommand or build the graph before a required run." : "Graphify CLI/graph not found. Structural validation can remain optional or be disabled."
    };
  }
  async build(root: string): Promise<void> { await this.refresh(root); }
  async refresh(root: string): Promise<void> {
    const command = this.config?.codeIntelligence?.refreshCommand;
    if (command) {
      const result = await runProcess(command, { cwd: root, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`Graphify refresh failed: ${result.stderr || result.stdout}`);
    }
    if (!(await this.load(root))) throw new Error("Graphify graph is unavailable after refresh. Configure codeIntelligence.refreshCommand or generate the configured graph path.");
  }
  async update(root: string): Promise<void> { await this.refresh(root); }
  async load(root: string): Promise<unknown | undefined> {
    return loadCanonicalGraph(root, this.config?.codeIntelligence?.graphPath ?? "graphify-out/graph.json");
  }
  async isFresh(root: string): Promise<boolean> {
    const graph = await this.load(root);
    if (!graph) return false;
    // A configured refresh command is the only provider-specific way to prove
    // freshness. Required runs invoke it before snapshots; this method remains
    // conservative for callers that need a readiness decision.
    return Boolean((graph as { generatedAt?: string }).generatedAt);
  }
  async impact(root: string): Promise<CodeImpactReport> {
    const graph = await this.load(root) as { nodes?: string[]; communities?: Record<string, string> } | undefined;
    return { provider: this.name, affectedNodes: graph?.nodes ?? [], affectedCommunities: [...new Set(Object.values(graph?.communities ?? {}))] };
  }
}
