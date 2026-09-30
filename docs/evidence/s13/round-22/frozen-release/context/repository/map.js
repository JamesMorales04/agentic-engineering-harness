import { loadGraphifyContextMap } from "./graphify.js";
import { rankRepositoryNodes } from "./rank.js";
import { renderRepositoryMap } from "./render.js";
export async function buildRepositoryContextMap(root, config, request = {}) {
    const graph = await loadGraphifyContextMap(root, config.codeIntelligence?.graphPath ?? "graphify-out/graph.json") ?? await filesystemContextMap(root);
    const ranked = rankRepositoryNodes(graph, request);
    const rendered = renderRepositoryMap(ranked, config.context?.repositoryMap?.tokenBudget ?? 2_000);
    return { ...rendered, map: graph };
}
async function filesystemContextMap(root) {
    const ignored = new Set([".git", "node_modules", "dist", ".harness", ".config", ".aeh-test-results", "coverage", ".vitest", ".cache"]);
    const files = [];
    async function visit(directory) {
        if (files.length >= 5_000)
            return;
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            if (ignored.has(entry.name))
                continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
                await visit(absolute);
            else if (entry.isFile())
                files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
            if (files.length >= 5_000)
                return;
        }
    }
    await visit(root);
    files.sort();
    return { provider: "filesystem", nodes: files.map((file) => ({ id: `file:${file}`, file })), edges: [] };
}
import fs from "node:fs/promises";
import path from "node:path";
//# sourceMappingURL=map.js.map