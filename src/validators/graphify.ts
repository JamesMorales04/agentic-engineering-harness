import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { HarnessProjectConfig, ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";
import { loadCanonicalGraph, type CanonicalGraph } from "../providers/graphifyModel.js";
type GraphSnapshot = CanonicalGraph;

export async function snapshotGraph(root: string, config: HarnessProjectConfig, taskId: string, phase: "before" | "after"): Promise<string | undefined> {
  const graphPath = config.codeIntelligence?.graphPath ?? "graphify-out/graph.json";
  try {
    const snapshot = await loadCanonicalGraph(root, graphPath);
    if (!snapshot) return undefined;
    const snapshotDir = path.resolve(root, config.codeIntelligence?.snapshotDir ?? ".harness/graph");
    const file = path.join(snapshotDir, taskId, `${phase}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    return file;
  } catch { return undefined; }
}

export async function runGraphifyValidator(context: ValidationContext): Promise<ValidationCheck> {
  const snapshotDir = path.resolve(context.root, context.config.codeIntelligence?.snapshotDir ?? ".harness/graph");
  const beforeFile = path.join(snapshotDir, context.contract.task.id, "before.json");
  const afterFile = path.join(snapshotDir, context.contract.task.id, "after.json");
  let before: GraphSnapshot;
  let after: GraphSnapshot;
  try {
    before = JSON.parse(await fs.readFile(beforeFile, "utf8")) as GraphSnapshot;
    after = JSON.parse(await fs.readFile(afterFile, "utf8")) as GraphSnapshot;
  } catch {
    return { id: context.spec.id, category: "architecture", status: context.spec.required ? "FAIL" : "WARN", message: "Graphify before/after snapshots are unavailable. Snapshot graphify-out/graph.json before and after implementation; refresh it through the Graphify skill or codeIntelligence.refreshCommand." };
  }
  if (context.changedFiles.length > 0 && before.sourceHash === after.sourceHash) {
    return { id: context.spec.id, category: "architecture", status: context.spec.required ? "FAIL" : "WARN", message: "Graphify graph did not change even though source files changed; the after snapshot appears stale.", details: { sourceHash: after.sourceHash, changedFiles: context.changedFiles } };
  }
  const beforeEdges = new Set(before.edges);
  const addedEdges = after.edges.filter((edge) => !beforeEdges.has(edge));
  const beforeNodes = new Set(before.nodes);
  const addedNodes = after.nodes.filter((node) => !beforeNodes.has(node));
  const violations: string[] = [];
  for (const pattern of context.contract.impact?.forbiddenEdges ?? []) violations.push(...addedEdges.filter((edge) => minimatch(edge, pattern, { nocase: true })));
  for (const pattern of context.contract.impact?.forbiddenNodes ?? []) violations.push(...addedNodes.filter((node) => minimatch(node, pattern, { nocase: true })).map((node) => `node:${node}`));
  const allowed = context.contract.impact?.allowedCommunities ?? [];
  if (allowed.length) {
    const touched = new Set<string>();
    for (const edge of after.edgePairs ?? []) if (!before.edges.includes(`${edge.from} --${edge.relation}--> ${edge.to}`)) { if (after.communities[edge.from]) touched.add(after.communities[edge.from]); if (after.communities[edge.to]) touched.add(after.communities[edge.to]); }
    for (const community of touched) if (!allowed.includes(community)) violations.push(`community:${community}`);
  }
  return { id: context.spec.id, category: "architecture", status: violations.length ? "FAIL" : "PASS", message: violations.length ? `Graphify detected ${violations.length} structural policy violation(s).` : `Graphify structural diff accepted (${addedEdges.length} new edge(s)).`, details: { addedEdges, addedNodes, violations } };
}
