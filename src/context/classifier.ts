import type { ContextFragment, ContextPreservation } from "./types.js";

export function classifyFragment(fragment: ContextFragment): ContextPreservation {
  // The preservation class is explicit and validated at the boundary. Unknown classes never enter the gateway.
  if (!["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"].includes(fragment.preservation)) {
    throw new Error(`Unknown context preservation class for fragment '${fragment.id}'.`);
  }
  return fragment.preservation;
}

export function canLossyCompress(fragment: ContextFragment): boolean {
  return fragment.preservation === "COMPRESSIBLE";
}

export function isRequired(fragment: ContextFragment): boolean {
  return fragment.preservation === "VERBATIM" || fragment.kind === "normative";
}
