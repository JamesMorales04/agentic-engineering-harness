import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { deterministicSchedulingConflicts, planWorkUnitWaves, scopeStaticPrefix } from "../architecture/workGraph.js";
import type { HarnessProjectConfig } from "../core/types.js";
import type { WorkUnitOutput } from "./outputContracts.js";

interface GraphEdge { from: string; to: string; relation?: string; }
interface GraphSnapshot {
  nodes?: string[];
  communities?: Record<string, string>;
  edges?: string[];
  edgePairs?: GraphEdge[];
  nodeFiles?: Record<string, string>;
  centrality?: Record<string, number>;
}
export interface TaskConflict { a: string; b: string; reasons: string[]; }
export interface ParallelismPlan { taskId: string; waves: string[][]; conflicts: TaskConflict[]; graphUsed: boolean; taskNodes?: Record<string, string[]>; }

export async function planParallelism(root: string, config: HarnessProjectConfig, taskId: string, tasks: WorkUnitOutput[]): Promise<ParallelismPlan> {
  const graph = await loadBeforeGraph(root, config, taskId); const conflicts: TaskConflict[] = []; const taskNodes: Record<string, string[]> = {};
  if (graph) for (const task of tasks) taskNodes[task.id] = [...nodesForScopes(task.scope, graph)].sort();
  for (let i = 0; i < tasks.length; i += 1) for (let j = i + 1; j < tasks.length; j += 1) {
    const reasons = conflictReasons(tasks[i], tasks[j], graph, taskNodes, config);
    if (reasons.length) conflicts.push({ a: tasks[i].id, b: tasks[j].id, reasons });
  }
  const waves = planWorkUnitWaves(tasks, {
    areMutuallyExclusive: (leftId, rightId) => conflicts.some((conflict) => (conflict.a === leftId && conflict.b === rightId) || (conflict.b === leftId && conflict.a === rightId))
  });
  return { taskId, waves, conflicts, graphUsed: Boolean(graph), taskNodes: graph ? taskNodes : undefined };
}

function conflictReasons(a: WorkUnitOutput, b: WorkUnitOutput, graph: GraphSnapshot | undefined, taskNodes: Record<string, string[]>, config: HarnessProjectConfig): string[] {
  const reasons = [...deterministicSchedulingConflicts(a, b)];
  if (a.dependencies.includes(b.id) || b.dependencies.includes(a.id)) reasons.push("dependency");
  if (!graph) return reasons;
  if (shareCommunity(new Set(taskNodes[a.id] ?? []), new Set(taskNodes[b.id] ?? []), graph)) reasons.push("graphify-community-overlap");
  const scheduling = config.codeIntelligence?.scheduling;
  if (scheduling?.useEdges !== false) {
    const left = new Set(taskNodes[a.id] ?? []); const right = new Set(taskNodes[b.id] ?? []);
    const shared = [...left].filter((node) => right.has(node));
    if (shared.length > (scheduling?.maxSharedNodes ?? 0)) reasons.push(`graphify-shared-node:${shared.length}`);
    const hops = Math.max(1, scheduling?.maxGraphHops ?? 1);
    const distance = minimumDistance(left, right, graph, hops);
    if (distance !== undefined && distance <= hops) reasons.push(`graphify-nearby:${distance}-hop`);
    const threshold = scheduling?.centralityConflictThreshold ?? 0.35;
    if (distance !== undefined && highCentrality([...left, ...right], graph, threshold)) reasons.push("graphify-centrality-risk");
  }
  return [...new Set(reasons)];
}

function nodesForScopes(scopes: string[], graph: GraphSnapshot): Set<string> {
  const result = new Set<string>(); const files = graph.nodeFiles ?? {};
  for (const node of graph.nodes ?? []) {
    const file = files[node];
    if (file && scopes.some((scope) => pathMatches(file, scope))) { result.add(node); continue; }
    if (scopes.some((scope) => { const prefix = scopeStaticPrefix(scope); return Boolean(prefix) && node.toLowerCase().includes(prefix.toLowerCase()); })) result.add(node);
  }
  return result;
}
function pathMatches(file: string, scope: string): boolean { const prefix = scopeStaticPrefix(scope); return minimatch(file, scope, { dot: true }) || (Boolean(prefix) && (file === prefix || file.startsWith(`${prefix}/`))); }
function shareCommunity(a: Set<string>, b: Set<string>, graph: GraphSnapshot): boolean { const communities = graph.communities ?? {}; const left = new Set([...a].map((node) => communities[node]).filter(Boolean)); return [...b].some((node) => Boolean(communities[node] && left.has(communities[node]))); }
function adjacency(graph: GraphSnapshot): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => { const set = map.get(from) ?? new Set<string>(); set.add(to); map.set(from, set); };
  for (const edge of graph.edgePairs ?? []) { add(edge.from, edge.to); add(edge.to, edge.from); }
  if (!(graph.edgePairs?.length)) for (const text of graph.edges ?? []) { const match = text.match(/^(.*?)\s+--.*?-->\s+(.*)$/); if (match) { add(match[1], match[2]); add(match[2], match[1]); } }
  return map;
}
function minimumDistance(left: Set<string>, right: Set<string>, graph: GraphSnapshot, maxHops: number): number | undefined {
  if ([...left].some((node) => right.has(node))) return 0;
  const adj = adjacency(graph); let frontier = new Set(left); const visited = new Set(left);
  for (let distance = 1; distance <= maxHops; distance += 1) {
    const next = new Set<string>();
    for (const node of frontier) for (const neighbor of adj.get(node) ?? []) {
      if (right.has(neighbor)) return distance;
      if (!visited.has(neighbor)) { visited.add(neighbor); next.add(neighbor); }
    }
    frontier = next; if (!frontier.size) break;
  }
  return undefined;
}
function highCentrality(nodes: string[], graph: GraphSnapshot, threshold: number): boolean {
  const explicit = graph.centrality ?? {}; if (nodes.some((node) => (explicit[node] ?? 0) >= threshold)) return true;
  if (Object.keys(explicit).length) return false;
  const adj = adjacency(graph); const denominator = Math.max(1, (graph.nodes?.length ?? adj.size) - 1); return nodes.some((node) => (adj.get(node)?.size ?? 0) / denominator >= threshold);
}
async function loadBeforeGraph(root: string, config: HarnessProjectConfig, taskId: string): Promise<GraphSnapshot | undefined> { const dir = path.resolve(root, config.codeIntelligence?.snapshotDir ?? ".harness/graph"); try { return JSON.parse(await fs.readFile(path.join(dir, taskId, "before.json"), "utf8")) as GraphSnapshot; } catch { return undefined; } }
