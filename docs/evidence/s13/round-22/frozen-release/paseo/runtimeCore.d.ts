import type { OpenCodeAgentBindingSource } from "../agents/permissions.js";
import { runShell } from "../utils/process.js";
import { detectPaseoCapabilities } from "./capabilities.js";
import { preflightPaseoProviderMode } from "./modePreflight.js";
import { capturePaseoAgentTurnBaseline, preflightPaseoProviderModel, waitForPaseoAgentNative, type PaseoTurnBaseline } from "./native.js";
import { createPaseoSdkAgent, dispatchPaseoSdkAgent, inspectPaseoSdkAgent, listPaseoSdkAgents, materializePaseoSdkAgent, probePaseoSdkAgent, runPaseoSdkAgent, waitPaseoSdkAgent, type PaseoSdkAgentOptions, type PaseoSdkAgentRecord } from "./sdk.js";
import { recordPaseoTrace } from "./trace.js";
export interface ManagedPaseoAgentOptions extends PaseoSdkAgentOptions {
    timeoutSeconds?: number;
    modeSource?: OpenCodeAgentBindingSource;
}
export interface ManagedPaseoAgentResult {
    id?: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    status?: string;
    workspaceId?: string;
    transport: "sdk" | "cli";
    observation?: "subscription" | "sdk-run" | "sdk-wait" | "cli-wait";
}
export interface PaseoRuntimeDeps {
    run: typeof runShell;
    updateLabels?: (root: string, agentId: string, labels: Record<string, string>) => Promise<void>;
    detectCapabilities: typeof detectPaseoCapabilities;
    trace?: typeof recordPaseoTrace;
    native?: {
        preflight: typeof preflightPaseoProviderModel;
        preflightMode: typeof preflightPaseoProviderMode;
        wait: typeof waitForPaseoAgentNative;
        capture?: typeof capturePaseoAgentTurnBaseline;
    };
    sdk: {
        create: typeof createPaseoSdkAgent;
        materialize: typeof materializePaseoSdkAgent;
        dispatch: typeof dispatchPaseoSdkAgent;
        wait: typeof waitPaseoSdkAgent;
        run: typeof runPaseoSdkAgent;
        probe: typeof probePaseoSdkAgent;
        inspect: typeof inspectPaseoSdkAgent;
        list: typeof listPaseoSdkAgents;
    };
}
export declare function launchManagedPaseoAgent(root: string, options: ManagedPaseoAgentOptions, deps?: PaseoRuntimeDeps): Promise<ManagedPaseoAgentResult>;
export declare function materializeManagedPaseoAgent(root: string, options: ManagedPaseoAgentOptions, deps?: PaseoRuntimeDeps): Promise<ManagedPaseoAgentResult>;
export declare function dispatchManagedPaseoAgent(root: string, agentId: string, prompt: string, timeoutSeconds?: number, deps?: PaseoRuntimeDeps): Promise<ManagedPaseoAgentResult>;
export declare function waitManagedPaseoAgent(root: string, agentId: string, timeoutSeconds?: number, deps?: PaseoRuntimeDeps, baseline?: PaseoTurnBaseline): Promise<ManagedPaseoAgentResult>;
export declare function stopManagedPaseoAgent(root: string, agentId: string, deps?: PaseoRuntimeDeps): Promise<{
    exitCode: number;
    stderr: string;
}>;
export declare function continueManagedPaseoAgent(root: string, agentId: string, prompt: string, timeoutSeconds?: number, deps?: PaseoRuntimeDeps, outputSchema?: Record<string, unknown>, executionIdentityLabels?: Record<string, string>): Promise<ManagedPaseoAgentResult>;
export declare function probeManagedPaseoAgent(root: string, agentId: string, deps?: PaseoRuntimeDeps): Promise<boolean>;
export declare function inspectManagedPaseoAgent(root: string, agentId: string, deps?: PaseoRuntimeDeps): Promise<PaseoSdkAgentRecord | undefined>;
export declare function listManagedPaseoAgents(root: string, labels?: Record<string, string>, deps?: PaseoRuntimeDeps): Promise<PaseoSdkAgentRecord[]>;
