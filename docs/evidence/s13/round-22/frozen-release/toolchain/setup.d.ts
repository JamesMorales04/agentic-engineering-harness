import type { HarnessProjectConfig } from "../core/types.js";
import type { ToolchainSetupOptions, ToolchainSetupResult } from "./types.js";
export declare function setupToolchain(root: string, project: HarnessProjectConfig, options?: ToolchainSetupOptions): Promise<ToolchainSetupResult>;
export declare function compileToolchain(root: string, project: HarnessProjectConfig, options?: {
    profile?: string;
    updateLock?: boolean;
}): Promise<string>;
