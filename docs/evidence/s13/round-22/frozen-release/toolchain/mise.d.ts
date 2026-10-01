import type { ResolvedToolchain, ToolchainConfig, ToolchainLock } from "./types.js";
export interface MiseAdapter {
    command: string;
    version?: string;
}
export declare function resolveMiseAdapter(root: string, minimumVersion?: string): Promise<MiseAdapter>;
export declare function writeMiseConfig(root: string, file: string, toolchain: ToolchainConfig, resolved: ResolvedToolchain, lock: ToolchainLock | undefined, updateLock: boolean): Promise<void>;
export declare function installMiseTools(root: string, adapter: MiseAdapter, tools: string[], dryRun?: boolean, updateLock?: boolean): Promise<void>;
export declare function miseResolvedVersion(root: string, adapter: MiseAdapter, command: string): Promise<string | undefined>;
export declare function miseBinPaths(root: string, adapter: MiseAdapter): Promise<string[]>;
