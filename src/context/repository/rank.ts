import type { RankedRepositoryNode, RepositoryContextMap, RepositoryNode, RepositoryRankRequest } from "./types.js";

export function rankRepositoryNodes(map: RepositoryContextMap, request: RepositoryRankRequest): RankedRepositoryNode[] {
  const explicit = new Set(request.explicitPaths ?? []); const allowed = new Set(request.allowedPaths ?? []); const changed = new Set(request.changedFiles ?? []); const findings = new Set(request.findingLocations ?? []); const references = new Set(request.referenceIds ?? []);
  const ranked = map.nodes.map((node) => {
    const reasons: string[] = []; let score = 0;
    if (explicit.has(node.file)) { score += 100; reasons.push("explicit-scope"); }
    if (allowed.has(node.file)) { score += 60; reasons.push("task-scope"); }
    if (changed.has(node.file) || node.changed) { score += 40; reasons.push("changed-file"); }
    if (findings.has(node.file)) { score += 35; reasons.push("finding-location"); }
    if (request.symbol && (node.symbol === request.symbol || node.file.includes(request.symbol))) { score += 50; reasons.push("exact-symbol"); }
    if (references.has(node.id)) { score += 30; reasons.push("reference"); }
    if (node.centrality !== undefined) { score += Math.round(Math.max(0, Math.min(1, node.centrality)) * 20); reasons.push("centrality"); }
    return { ...node, score, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || (a.symbol ?? "").localeCompare(b.symbol ?? "") || a.id.localeCompare(b.id));
}

export function repositoryNodeKey(node: RepositoryNode): string { return `${node.file}${node.symbol ? `#${node.symbol}` : ""}`; }
