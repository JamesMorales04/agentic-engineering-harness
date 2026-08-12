import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { HarnessProjectConfig, ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";

interface GraphEdge { from: string; to: string; relation: string; }
interface GraphSnapshot {
  createdAt: string;
  source: string;
  sourceHash: string;
  edges: string[];
  edgePairs: GraphEdge[];
  nodes: string[];
  nodeFiles: Record<string, string>;
  communities: Record<string, string>;
  centrality: Record<string, number>;
}

export async function snapshotGraph(root: string, config: HarnessProjectConfig, taskId: string, phase: "before" | "after"): Promise<string | undefined> {
  const graphPath = path.resolve(root, config.codeIntelligence?.graphPath ?? "graphify-out/graph.json");
  try {
    const content = await fs.readFile(graphPath, "utf8");
    const raw = JSON.parse(content) as unknown;
    const snapshot = normalizeGraph(raw, graphPath, crypto.createHash("sha256").update(content).digest("hex"));
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

function normalizeGraph(raw: unknown, source: string, sourceHash: string): GraphSnapshot {
  const labels = new Map<string, string>();
  const nodeFiles: Record<string, string> = {};
  const communities: Record<string, string> = {};
  const edges = new Set<string>();
  const edgePairs = new Map<string, GraphEdge>();
  const nodes = new Set<string>();
  const visitNodes = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visitNodes); return; }
    const object = value as Record<string, unknown>;
    const id = scalar(object.id ?? object.key ?? object.node_id);
    const label = scalar(object.label ?? object.name ?? object.qualified_name ?? object.title);
    if (id && label) labels.set(id, label);
    if (label) nodes.add(label);
    const community = scalar(object.community ?? object.community_id ?? object.cluster);
    if (label && community) communities[label] = community;
    const file = scalar(object.file ?? object.path ?? object.filepath ?? object.file_path ?? object.source_file ?? object.sourcePath);
    if (label && file && looksLikePath(file)) nodeFiles[label] = normalizePath(file);
    Object.values(object).forEach(visitNodes);
  };
  visitNodes(raw);
  const visitEdges = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visitEdges); return; }
    const object = value as Record<string, unknown>;
    const sourceId = scalar(object.source ?? object.from ?? object.source_id);
    const targetId = scalar(object.target ?? object.to ?? object.target_id);
    if (sourceId && targetId) {
      const from = labels.get(sourceId) ?? sourceId;
      const to = labels.get(targetId) ?? targetId;
      const relation = scalar(object.relation ?? object.type ?? object.kind ?? object.label) ?? "relates";
      nodes.add(from); nodes.add(to); const text = `${from} --${relation}--> ${to}`; edges.add(text); edgePairs.set(text, { from, to, relation });
    }
    Object.values(object).forEach(visitEdges);
  };
  visitEdges(raw);
  const adjacency = new Map<string, Set<string>>(); const add = (from: string, to: string): void => { const set = adjacency.get(from) ?? new Set<string>(); set.add(to); adjacency.set(from, set); };
  for (const edge of edgePairs.values()) { add(edge.from, edge.to); add(edge.to, edge.from); }
  const denominator = Math.max(1, nodes.size - 1); const centrality: Record<string, number> = {}; for (const node of nodes) centrality[node] = (adjacency.get(node)?.size ?? 0) / denominator;
  return { createdAt: new Date().toISOString(), source, sourceHash, edges: [...edges].sort(), edgePairs: [...edgePairs.values()].sort((a, b) => `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`)), nodes: [...nodes].sort(), nodeFiles, communities, centrality };
}
function scalar(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function looksLikePath(value: string): boolean { return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value); }
function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
