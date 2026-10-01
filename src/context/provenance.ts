import { createHash } from "node:crypto";
import { canonicalSerialize } from "../core/digest.js";

export const CONTEXT_PROJECTION_VERSION = "aeh-context-v1";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return canonicalSerialize(value);
}
