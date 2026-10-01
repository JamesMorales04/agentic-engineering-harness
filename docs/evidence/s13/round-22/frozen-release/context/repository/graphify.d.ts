import type { RepositoryContextMap } from "./types.js";
export declare function loadGraphifyContextMap(root: string, graphPath?: string): Promise<RepositoryContextMap | undefined>;
export { normalizeGraphDocument } from "../../providers/graphifyModel.js";
