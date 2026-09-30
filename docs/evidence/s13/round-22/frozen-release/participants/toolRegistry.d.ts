import type { CanonicalRole, ToolPackV1 } from "./types.js";
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
export declare function authorizeToolPack(input: {
    role: CanonicalRole;
    toolPack: ToolPackV1;
    availableTools: readonly ToolAvailabilityV1[];
}): ToolAuthorizationV1;
