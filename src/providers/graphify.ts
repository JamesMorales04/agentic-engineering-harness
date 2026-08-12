import fs from "node:fs/promises";
import path from "node:path";
import type { CodeIntelligenceProvider } from "./types.js";
import { commandExists } from "../utils/process.js";

export class GraphifyCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly name = "graphify";
  async doctor(root: string): Promise<{ ok: boolean; message: string }> {
    const cli = await commandExists("graphify", root);
    const graph = await graphExists(root);
    return {
      ok: cli || graph,
      message: graph ? "Graphify graph detected at graphify-out/graph.json. Refresh it through the Graphify skill or codeIntelligence.refreshCommand before after-snapshots." : cli ? "Graphify CLI detected, but no graphify-out/graph.json exists yet. Build the graph through the Graphify skill." : "Graphify CLI/graph not found. Structural validation can remain optional or be disabled."
    };
  }
  async update(root: string): Promise<void> {
    if (!(await graphExists(root))) throw new Error("Graphify graph is unavailable. Build or refresh graphify-out/graph.json through the Graphify assistant skill or codeIntelligence.refreshCommand.");
  }
}
async function graphExists(root: string): Promise<boolean> {
  try { await fs.access(path.join(root, "graphify-out", "graph.json")); return true; } catch { return false; }
}
