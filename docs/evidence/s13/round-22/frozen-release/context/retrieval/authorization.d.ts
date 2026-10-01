import type { ContextFragment } from "../types.js";
export interface RetrievalAuthorization {
    root: string;
    operationId: string;
    logicalAgent: string;
    allowedFragmentIds: string[];
    fragments: Map<string, ContextFragment>;
}
export declare function authorizeRetrieval(input: Omit<RetrievalAuthorization, "fragments"> & {
    fragments: ContextFragment[];
}): RetrievalAuthorization;
