import type { ProcessResult } from "../utils/process.js";
import { runShell } from "../utils/process.js";
export interface PaseoDaemonCapabilities {
    version?: string;
    daemonJson: boolean;
}
export interface PaseoCapabilities extends PaseoDaemonCapabilities {
    background: boolean;
    quiet: boolean;
    json: boolean;
    outputSchema: boolean;
    nativeToolsRecommended: boolean;
}
export interface PaseoBackgroundRunOptions {
    title: string;
    provider: string;
    model?: string;
    workspaceId?: string;
    prompt: string;
}
type Runner = typeof runShell;
/**
 * Minimal CLI discovery needed by daemon bootstrap. This deliberately does not
 * inspect `paseo run --help`; run flags belong to the compatibility CLI runtime
 * and are probed only if that fallback is actually needed.
 */
export declare function detectPaseoDaemonCapabilities(root: string, run?: Runner): Promise<PaseoDaemonCapabilities>;
/**
 * Full CLI runtime negotiation. Call this only when AEH is about to use the
 * Paseo CLI compatibility execution path.
 */
export declare function detectPaseoCapabilities(root: string, run?: Runner): Promise<PaseoCapabilities>;
export declare function buildPaseoBackgroundRunCommand(options: PaseoBackgroundRunOptions, capabilities: PaseoCapabilities): string;
export declare function extractPaseoAgentId(stdout: string): string | undefined;
export type PaseoDaemonStatusObservation = {
    state: "healthy";
    serverId?: string;
    pid?: number;
} | {
    state: "stopped";
    stalePid: boolean;
} | {
    state: "unknown";
};
/** Classify only supported, current daemon evidence; ambiguous status must fail closed. */
export declare function observePaseoDaemonStatus(result: ProcessResult): PaseoDaemonStatusObservation;
export {};
