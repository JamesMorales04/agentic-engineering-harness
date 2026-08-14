import type { RepositoryContextMap } from "./types.js";
import { canonicalGraphToRepositoryMap, loadCanonicalGraph, normalizeGraphDocument } from "../../providers/graphifyModel.js";

export async function loadGraphifyContextMap(root: string, graphPath = "graphify-out/graph.json"): Promise<RepositoryContextMap | undefined> {
  const graph = await loadCanonicalGraph(root, graphPath);
  return graph ? canonicalGraphToRepositoryMap(graph) : undefined;
}

export { normalizeGraphDocument } from "../../providers/graphifyModel.js";
