import type { ContextEnvelope } from "./types.js";
export declare function buildContextEnvelope(input: Omit<ContextEnvelope, "provenance">): ContextEnvelope;
export declare function verifyContextEnvelope(envelope: ContextEnvelope): boolean;
export declare function renderContextEnvelope(envelope: ContextEnvelope): string;
