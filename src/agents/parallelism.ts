import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { HarnessProjectConfig } from "../core/types.js";
import type { DelegationTask } from "./outputContracts.js";
interface GraphSnapshot { nodes?: string[]; communities?: Record<string, string>; edges?: string[]; }
export interface TaskConflict { a: string; b: string; reasons: string[]; }
export interface ParallelismPlan { taskId: string; waves: string[][]; conflicts: TaskConflict[]; graphUsed: boolean; }
export async function planParallelism(root: string, config: HarnessProjectConfig, taskId: string, tasks: DelegationTask[]): Promise<ParallelismPlan> {
  const graph = await loadBeforeGraph(root, config, taskId); const conflicts: TaskConflict[] = [];
  for (let i = 0; i < tasks.length; i += 1) for (let j = i + 1; j < tasks.length; j += 1) { const reasons = conflictReasons(tasks[i], tasks[j], graph); if (reasons.length) conflicts.push({ a: tasks[i].id, b: tasks[j].id, reasons }); }
  const waves: string[][] = []; const remaining = new Map(tasks.map((task) => [task.id, task])); const completed = new Set<string>();
  while (remaining.size) {
    const wave: DelegationTask[] = [];
    for (const task of remaining.values()) { if (!task.dependencies.every((dep) => completed.has(dep))) continue; if (wave.some((other) => conflicts.some((conflict) => ((conflict.a === task.id && conflict.b === other.id) || (conflict.b === task.id && conflict.a === other.id))))) continue; wave.push(task); }
    if (!wave.length) throw new Error(`Cannot schedule delegation plan: dependency cycle or unresolved dependency among ${[...remaining.keys()].join(", ")}`);
    waves.push(wave.map((task) => task.id)); for (const task of wave) { completed.add(task.id); remaining.delete(task.id); }
  }
  return { taskId, waves, conflicts, graphUsed: Boolean(graph) };
}
function conflictReasons(a: DelegationTask, b: DelegationTask, graph?: GraphSnapshot): string[] { const reasons: string[] = []; if (a.dependencies.includes(b.id) || b.dependencies.includes(a.id)) reasons.push("dependency"); if (scopesOverlap(a.scope, b.scope)) reasons.push("scope-overlap"); if (graph && shareCommunity(a.scope, b.scope, graph)) reasons.push("graphify-community-overlap"); return reasons; }
function scopesOverlap(a: string[], b: string[]): boolean { return a.some((left) => b.some((right) => left === right || minimatch(left, right, { dot: true }) || minimatch(right, left, { dot: true }) || staticPrefix(left).startsWith(staticPrefix(right)) || staticPrefix(right).startsWith(staticPrefix(left)))); }
function staticPrefix(pattern: string): string { return pattern.split(/[?*\[]/, 1)[0].replace(/\/+$/, ""); }
function shareCommunity(aScopes: string[], bScopes: string[], graph: GraphSnapshot): boolean { const communities = graph.communities ?? {}; const a = communitiesForScopes(aScopes, graph.nodes ?? [], communities); const b = communitiesForScopes(bScopes, graph.nodes ?? [], communities); return [...a].some((community) => b.has(community)); }
function communitiesForScopes(scopes: string[], nodes: string[], communities: Record<string, string>): Set<string> { const result = new Set<string>(); for (const node of nodes) if (scopes.some((scope) => minimatch(node, scope, { dot: true }) || node.includes(staticPrefix(scope)))) { const community = communities[node]; if (community) result.add(community); } return result; }
async function loadBeforeGraph(root: string, config: HarnessProjectConfig, taskId: string): Promise<GraphSnapshot | undefined> { const dir = path.resolve(root, config.codeIntelligence?.snapshotDir ?? ".harness/graph"); try { return JSON.parse(await fs.readFile(path.join(dir, taskId, "before.json"), "utf8")) as GraphSnapshot; } catch { return undefined; } }
