import type { ContextEnvelope, ContextFragmentProjection } from "./types.js";
import { assertContextEnvelope } from "./types.js";
import { CONTEXT_PROJECTION_VERSION, sha256, stableJson } from "./provenance.js";

export function buildContextEnvelope(input: Omit<ContextEnvelope, "provenance">): ContextEnvelope {
  const base = { ...input, provenance: { sha256: "", createdAt: new Date().toISOString(), projectionVersion: CONTEXT_PROJECTION_VERSION } };
  const digest = sha256(stableJson({ ...base, provenance: { ...base.provenance, sha256: undefined } }));
  return assertContextEnvelope({ ...base, provenance: { ...base.provenance, sha256: digest } });
}

export function verifyContextEnvelope(envelope: ContextEnvelope): boolean {
  const expected = sha256(stableJson({ ...envelope, provenance: { ...envelope.provenance, sha256: undefined } }));
  return expected === envelope.provenance.sha256;
}

export function renderContextEnvelope(envelope: ContextEnvelope): string {
  const sections = envelope.fragments.map((fragment: ContextFragmentProjection) => {
    const source = fragment.source?.artifact ? ` source=${fragment.source.artifact}` : "";
    const mode = fragment.compressed ? "compressed" : fragment.projected ? "projected" : fragment.preservation.toLowerCase();
    return `### ${fragment.kind}:${fragment.id} [${mode}, ${fragment.estimatedTokens} tokens]${source}\n${fragment.content}`;
  });
  return [`AEH ContextEnvelope v${envelope.version} operation=${envelope.operationId} agent=${envelope.logicalAgent} phase=${envelope.phase}`, ...sections, "AEH raw context is retrievable only through authorized fragment IDs."].join("\n\n");
}
