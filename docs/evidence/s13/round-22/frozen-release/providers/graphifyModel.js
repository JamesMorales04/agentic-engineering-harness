import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
export async function loadCanonicalGraph(root, graphPath = "graphify-out/graph.json") {
    const source = path.resolve(root, graphPath);
    try {
        const content = await fs.readFile(source, "utf8");
        return normalizeGraphDocument(JSON.parse(content), graphPath, sha256Utf8(content));
    }
    catch {
        return undefined;
    }
}
/** One parser for Graphify variants; callers must not normalize provider output independently. */
export function normalizeGraphDocument(raw, source = "graphify", sourceHash = sha256Canonical(raw)) {
    const labels = new Map();
    const nodeFiles = {};
    const communities = {};
    const edges = new Set();
    const edgePairs = new Map();
    const nodes = new Set();
    const visitNodes = (value) => {
        if (!value || typeof value !== "object")
            return;
        if (Array.isArray(value)) {
            value.forEach(visitNodes);
            return;
        }
        const object = value;
        const id = scalar(object.id ?? object.key ?? object.node_id);
        const label = scalar(object.label ?? object.name ?? object.qualified_name ?? object.title ?? object.file ?? object.path);
        if (id && label)
            labels.set(id, label);
        if (label)
            nodes.add(label);
        const community = scalar(object.community ?? object.community_id ?? object.cluster);
        if (label && community)
            communities[label] = community;
        const file = scalar(object.file ?? object.path ?? object.filepath ?? object.file_path ?? object.source_file ?? object.sourcePath);
        if (label && file && looksLikePath(file))
            nodeFiles[label] = normalizePath(file);
        Object.values(object).forEach(visitNodes);
    };
    visitNodes(raw);
    const visitEdges = (value) => {
        if (!value || typeof value !== "object")
            return;
        if (Array.isArray(value)) {
            value.forEach(visitEdges);
            return;
        }
        const object = value;
        const sourceId = scalar(object.source ?? object.from ?? object.source_id);
        const targetId = scalar(object.target ?? object.to ?? object.target_id);
        if (sourceId && targetId) {
            const from = labels.get(sourceId) ?? sourceId;
            const to = labels.get(targetId) ?? targetId;
            const relation = scalar(object.relation ?? object.type ?? object.kind ?? object.label) ?? "relates";
            nodes.add(from);
            nodes.add(to);
            const text = `${from} --${relation}--> ${to}`;
            edges.add(text);
            edgePairs.set(text, { from, to, relation });
        }
        Object.values(object).forEach(visitEdges);
    };
    visitEdges(raw);
    const adjacency = new Map();
    const add = (from, to) => { const set = adjacency.get(from) ?? new Set(); set.add(to); adjacency.set(from, set); };
    for (const edge of edgePairs.values()) {
        add(edge.from, edge.to);
        add(edge.to, edge.from);
    }
    const denominator = Math.max(1, nodes.size - 1);
    const centrality = {};
    for (const node of nodes)
        centrality[node] = (adjacency.get(node)?.size ?? 0) / denominator;
    const record = raw && typeof raw === "object" ? raw : {};
    return {
        createdAt: new Date().toISOString(), source, sourceHash,
        generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : typeof record.createdAt === "string" ? record.createdAt : undefined,
        edges: [...edges].sort(),
        edgePairs: [...edgePairs.values()].sort((a, b) => `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`)),
        nodes: [...nodes].sort(), nodeFiles, communities, centrality
    };
}
export function canonicalGraphToRepositoryMap(graph) {
    const nodes = graph.nodes.map((label) => ({
        id: label,
        file: graph.nodeFiles[label] ?? label,
        symbol: graph.nodeFiles[label] ? label : undefined,
        centrality: graph.centrality[label],
        community: graph.communities[label]
    }));
    const edges = graph.edgePairs.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.relation }));
    return { provider: "graphify", generatedAt: graph.generatedAt, nodes, edges };
}
function scalar(value) { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function looksLikePath(value) { return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value); }
function normalizePath(value) { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
//# sourceMappingURL=graphifyModel.js.map