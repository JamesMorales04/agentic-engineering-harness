import { runShell, type ProcessResult } from "../utils/process.js";
type ProcessRunner = (command: string, options: Parameters<typeof runShell>[1]) => Promise<ProcessResult>;
export interface PaseoSdkResolution {
    resolved?: string;
    diagnostics: string[];
}
/**
 * Resolve the Paseo client that belongs to the active Paseo CLI installation.
 *
 * mise's npm backend may expose a shim/alias path and package managers may
 * materialize transitive dependencies in non-hoisted stores. Prefer normal
 * Node resolution because it is cheap and semantically correct. If that fails,
 * scan only the bounded Paseo installation prefixes and load the exact
 * @getpaseo/client package physically present there.
 */
export declare function resolvePaseoSdkFromCli(root: string, runner?: ProcessRunner): Promise<PaseoSdkResolution>;
export {};
