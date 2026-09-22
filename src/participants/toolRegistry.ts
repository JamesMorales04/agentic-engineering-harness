import type { CanonicalRole, ToolPackV1 } from "./types.js";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";

export type ToolSourceV1 = "project" | "toolchain" | "aeh" | "provider" | "environment";

export interface ToolAvailabilityV1 {
  id: string;
  source: ToolSourceV1;
  available: boolean;
  version?: string;
}

export interface ToolAuthorizationV1 {
  version: 1;
  role: CanonicalRole;
  available: string[];
  exposed: string[];
  denied: string[];
  digest: string;
}

export function authorizeToolPack(input: { role: CanonicalRole; toolPack: ToolPackV1; availableTools: readonly ToolAvailabilityV1[] }): ToolAuthorizationV1 {
  const available = new Set(input.availableTools.filter((tool) => tool.available).map((tool) => tool.id));
  const required = [...new Set(input.toolPack.required)].sort();
  const optional = [...new Set(input.toolPack.optional)].filter((tool) => !required.includes(tool)).sort();
  const forbidden = new Set(input.toolPack.forbidden);
  const missing = required.filter((tool) => !available.has(tool));
  if (missing.length) throw new AehError("TOOL_AUTHORIZATION_REJECTED", `required tools unavailable: ${missing.join(", ")}.`);
  const exposed = [...new Set([...required, ...optional.filter((tool) => available.has(tool))])].filter((tool) => !forbidden.has(tool)).sort();
  if (exposed.length !== required.length + optional.filter((tool) => available.has(tool)).filter((tool) => !forbidden.has(tool)).length) throw new AehError("TOOL_AUTHORIZATION_REJECTED", "tool pack overlaps its forbidden set.");
  const denied = [...new Set([...available].filter((tool) => !exposed.includes(tool) || forbidden.has(tool)))].sort();
  const payload = { version: 1 as const, role: input.role, available: [...available].sort(), exposed, denied };
  return { ...payload, digest: sha256Canonical(payload) };
}
