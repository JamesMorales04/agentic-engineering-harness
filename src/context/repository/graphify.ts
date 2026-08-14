import fs from "node:fs/promises";
import path from "node:path";
import type { RepositoryContextMap, RepositoryEdge, RepositoryNode } from "./types.js";

export async function loadGraphifyContextMap(root: string, graphPath = "graphify-out/graph.json"): Promise<RepositoryContextMap | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.resolve(root, graphPath), "utf8")); } catch { return undefined; }
  return normalizeGraph(value);
}

function normalizeGraph(value: unknown): RepositoryContextMap {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawNodes = Array.isArray(object.nodes) ? object.nodes : Array.isArray(object.files) ? object.files : [];
  const nodes: RepositoryNode[] = rawNodes.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const file = String(record.file ?? record.path ?? record.name ?? "");
    if (!file) return [];
    return [{ id: String(record.id ?? `${file}#${index}`), file, symbol: typeof record.symbol === "string" ? record.symbol : typeof record.name === "string" && record.name !== file ? record.name : undefined, signature: typeof record.signature === "string" ? record.signature : undefined, centrality: typeof record.centrality === "number" ? record.centrality : undefined, community: typeof record.community === "string" ? record.community : undefined }];
  });
  const rawEdges = Array.isArray(object.edges) ? object.edges : Array.isArray(object.links) ? object.links : [];
  const edges: RepositoryEdge[] = rawEdges.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const from = String(record.from ?? record.source ?? ""); const to = String(record.to ?? record.target ?? "");
    return from && to ? [{ from, to, kind: typeof record.kind === "string" ? record.kind : typeof record.type === "string" ? record.type : undefined }] : [];
  });
  return { nodes, edges, provider: "graphify", generatedAt: typeof object.generatedAt === "string" ? object.generatedAt : undefined };
}
