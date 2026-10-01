import type { RankedRepositoryNode, RepositoryContextMap, RepositoryNode, RepositoryRankRequest } from "./types.js";
export declare function rankRepositoryNodes(map: RepositoryContextMap, request: RepositoryRankRequest): RankedRepositoryNode[];
export declare function repositoryNodeKey(node: RepositoryNode): string;
