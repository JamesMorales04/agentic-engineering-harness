import type { HarnessProjectConfig } from "../../core/types.js";
import type { RepositoryContextMap, RepositoryRankRequest } from "./types.js";
import { type RepositoryMapRender } from "./render.js";
export declare function buildRepositoryContextMap(root: string, config: HarnessProjectConfig, request?: RepositoryRankRequest): Promise<RepositoryMapRender & {
    map: RepositoryContextMap;
}>;
