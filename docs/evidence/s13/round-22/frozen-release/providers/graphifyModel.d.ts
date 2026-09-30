import type { RepositoryContextMap } from "../context/repository/types.js";
/** Canonical, lossless-enough structural representation consumed by all AEH Graphify users. */
export interface CanonicalGraphEdge {
    from: string;
    to: string;
    relation: string;
}
export interface CanonicalGraph {
    createdAt: string;
    source: string;
    sourceHash: string;
    nodes: string[];
    edges: string[];
    edgePairs: CanonicalGraphEdge[];
    nodeFiles: Record<string, string>;
    communities: Record<string, string>;
    centrality: Record<string, number>;
    generatedAt?: string;
}
export declare function loadCanonicalGraph(root: string, graphPath?: string): Promise<CanonicalGraph | undefined>;
/** One parser for Graphify variants; callers must not normalize provider output independently. */
export declare function normalizeGraphDocument(raw: unknown, source?: string, sourceHash?: string): CanonicalGraph;
export declare function canonicalGraphToRepositoryMap(graph: CanonicalGraph): RepositoryContextMap;
