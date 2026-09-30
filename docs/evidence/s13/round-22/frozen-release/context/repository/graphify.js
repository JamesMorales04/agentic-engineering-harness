import { canonicalGraphToRepositoryMap, loadCanonicalGraph } from "../../providers/graphifyModel.js";
export async function loadGraphifyContextMap(root, graphPath = "graphify-out/graph.json") {
    const graph = await loadCanonicalGraph(root, graphPath);
    return graph ? canonicalGraphToRepositoryMap(graph) : undefined;
}
export { normalizeGraphDocument } from "../../providers/graphifyModel.js";
//# sourceMappingURL=graphify.js.map