import type { HarnessProjectConfig } from "../core/types.js";
export interface DirectWorkerProcessOptions {
    cwd: string;
    timeoutMs: number;
    environment?: Record<string, string | undefined>;
    maxOutputBytes?: number;
    /** A shared isolated home used to prepare a real provider session before its first turn. */
    homeDirectory?: string;
}
export interface DirectWorkerHome {
    directory: string;
}
export interface DirectWorkerProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}
/**
 * Run a direct runtime with an explicit environment. Direct workers must not
 * inherit the controller's ambient credentials or user runtime configuration.
 */
export declare function runDirectWorkerProcess(command: string, args: readonly string[], config: HarnessProjectConfig, options: DirectWorkerProcessOptions): Promise<DirectWorkerProcessResult>;
export declare function createDirectWorkerHome(runtime?: string): Promise<DirectWorkerHome>;
/**
 * Project only the exact provider auth file the selected direct runtime needs into its ephemeral
 * controlled home, with 0600 permissions, mirroring the certified CodexAgentProvider boundary.
 * The same OS user's provider process reads its own credential; no credential is minted,
 * broadened, logged or shared, and the home is removed with the turn. A missing auth file is not
 * an error here: the provider reports unauthenticated startup through its own failure.
 */
export declare function projectDirectProviderAuth(directory: string, runtime?: string): Promise<void>;
export declare function removeDirectWorkerHome(home: DirectWorkerHome | undefined): Promise<void>;
export declare function buildDirectWorkerEnvironment(config: HarnessProjectConfig, explicit?: Record<string, string | undefined>, controlledHome?: string): Record<string, string>;
