import type { HarnessProjectConfig } from "../../core/types.js";
import { loadGraphifyContextMap } from "./graphify.js";
import { rankRepositoryNodes } from "./rank.js";
import type { RepositoryContextMap, RepositoryRankRequest } from "./types.js";
import { renderRepositoryMap, type RepositoryMapRender } from "./render.js";

export async function buildRepositoryContextMap(root: string, config: HarnessProjectConfig, request: RepositoryRankRequest = {}): Promise<RepositoryMapRender & { map: RepositoryContextMap }> {
  const graph = await loadGraphifyContextMap(root, config.codeIntelligence?.graphPath ?? "graphify-out/graph.json") ?? await filesystemContextMap(root);
  const ranked = rankRepositoryNodes(graph, request);
  const rendered = renderRepositoryMap(ranked, config.context?.repositoryMap?.tokenBudget ?? 2_000);
  return { ...rendered, map: graph };
}

async function filesystemContextMap(root: string): Promise<RepositoryContextMap> {
  const ignored = new Set([".git", "node_modules", "dist", ".harness", ".config", ".aeh-test-results", "coverage", ".vitest", ".cache"]); const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (files.length >= 5_000) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      if (files.length >= 5_000) return;
    }
  }
  await visit(root); files.sort();
  return { provider: "filesystem", nodes: files.map((file) => ({ id: `file:${file}`, file })), edges: [] };
}
import fs from "node:fs/promises";
import path from "node:path";
