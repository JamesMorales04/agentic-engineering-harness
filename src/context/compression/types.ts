import type { ContextFragment } from "../types.js";

export interface ProviderHealth { ok: boolean; message: string; version?: string; }

export interface ContextCompressionRequest {
  operationId: string;
  fragment: ContextFragment;
  maxTokens?: number;
  sourceSha256: string;
}

export interface ContextCompressionResult {
  content: string;
  provider: string;
  providerVersion?: string;
  reversible: boolean;
  handle?: string;
  originalTokens: number;
  compressedTokens: number;
}

export interface ContextCompressionProvider {
  readonly name: string;
  doctor(root: string): Promise<ProviderHealth>;
  compress(root: string, request: ContextCompressionRequest): Promise<ContextCompressionResult>;
}

export type { HeadroomRuntimeHandle, HeadroomRuntimeOptions } from "./lifecycle.js";
