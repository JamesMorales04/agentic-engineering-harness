import type { ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { reconcileHarnessAssets } from "../core/assets.js";
import type { HarnessProjectConfig } from "../core/types.js";
import { setupToolchain } from "../toolchain/setup.js";
import { commandExists, runShell } from "../utils/process.js";
import { detectPaseoDaemonCapabilities } from "./capabilities.js";
import { launchManagedPaseoAgent, probeManagedPaseoAgent } from "./runtime.js";
import type { PaseoSdkAgentOptions } from "./sdk.js";
export declare const PASEO_BOOTSTRAP_VERSION = 13;
export type PaseoSessionPolicy = "fresh-on-start" | "reuse-compatible" | "resume-explicit";
export interface PaseoStartOptions {
    autoSetup?: boolean;
    webUi?: boolean;
    forceNew?: boolean;
    resume?: boolean;
    leadAgent?: string;
    title?: string;
    aehCommand?: string;
    handoffPath?: string;
}
export interface PaseoLeadState {
    version: 2;
    bootstrapVersion: number;
    aehVersion: string;
    aehCommand: string;
    projectRoot: string;
    projectName: string;
    agentId: string;
    title: string;
    leadAgent: string;
    provider: string;
    model: string;
    createdAt: string;
    generation?: number;
    handoffPath?: string;
}
export interface PaseoStartResult {
    daemonStarted: boolean;
    session: "created" | "reused";
    agentId: string;
    title: string;
    leadAgent: string;
    provider: string;
    model: string;
    aehVersion: string;
    aehCommand: string;
    stateFile: string;
    bootstrapFile: string;
    paseoVersion?: string;
    transport?: "sdk" | "cli";
}
interface PaseoStartDeps {
    run: typeof runShell;
    commandExists: typeof commandExists;
    setupToolchain: typeof setupToolchain;
    loadTopology: typeof loadResolvedAgentTopology;
    detectCapabilities: typeof detectPaseoDaemonCapabilities;
    launchAgent: typeof launchManagedPaseoAgent;
    probeAgent: typeof probeManagedPaseoAgent;
    reconcileAssets?: typeof reconcileHarnessAssets;
}
export declare function startPaseoHarness(root: string, config: HarnessProjectConfig, options?: PaseoStartOptions, deps?: PaseoStartDeps): Promise<PaseoStartResult>;
export declare function buildAehControlMcp(aehCommand: string, projectRoot: string): Pick<PaseoSdkAgentOptions, "mcpServers" | "toolPolicy">;
export declare function parseCommandVector(value: string): string[] | undefined;
export declare function buildPaseoLeadBootstrap(projectName: string, projectRoot: string, aehCommand: string, preferPaseoTools?: boolean, handoffPath?: string): string;
export declare function resolveLeadAgent(topology: ResolvedAgentTopology, configured?: string): string;
export {};
