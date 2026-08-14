import type { ContextFragment } from "../types.js";

export interface RetrievalAuthorization {
  root: string;
  operationId: string;
  logicalAgent: string;
  allowedFragmentIds: string[];
  fragments: Map<string, ContextFragment>;
}

export function authorizeRetrieval(input: Omit<RetrievalAuthorization, "fragments"> & { fragments: ContextFragment[] }): RetrievalAuthorization {
  const fragments = new Map(input.fragments.map((fragment) => [fragment.id, fragment]));
  const allowed = new Set(input.allowedFragmentIds);
  for (const id of allowed) if (!fragments.has(id)) throw new Error(`Cannot authorize unknown context fragment '${id}'.`);
  return { ...input, allowedFragmentIds: [...allowed].sort(), fragments };
}
