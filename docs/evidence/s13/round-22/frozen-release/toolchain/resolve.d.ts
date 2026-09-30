import type { HarnessProjectConfig } from "../core/types.js";
import type { ResolvedToolchain, ToolchainConfig } from "./types.js";
export declare function resolveToolchain(root: string, project: HarnessProjectConfig, toolchain: ToolchainConfig, options?: {
    profile?: string;
    preferContainers?: boolean;
    containerAvailable?: boolean;
}): Promise<ResolvedToolchain>;
export declare function profileTools(toolchain: ToolchainConfig, profile: string): string[];
