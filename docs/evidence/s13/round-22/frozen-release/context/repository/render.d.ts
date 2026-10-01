import type { RankedRepositoryNode } from "./types.js";
export interface RepositoryMapRender {
    content: string;
    selected: string[];
    omitted: string[];
    estimatedTokens: number;
}
export declare function renderRepositoryMap(nodes: RankedRepositoryNode[], tokenBudget: number): RepositoryMapRender;
