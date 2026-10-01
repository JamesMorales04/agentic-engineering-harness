import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection, ContextCapabilityRequirement, RuntimeCapabilities } from "../agents/types.js";
import { runShell } from "../utils/process.js";
export interface ResolvedContextCapabilityRequirements {
    repositoryMap: ContextCapabilityRequirement;
    semanticRetrieval: ContextCapabilityRequirement;
    rawRetrieval: ContextCapabilityRequirement;
    compression: ContextCapabilityRequirement;
    source: "agent-contract" | "coordinator-default" | "project-default";
}
export interface TransportCapabilities {
    mcpProjection: boolean;
    localMcpProjection: boolean;
    directRuntimeConfig: boolean;
    reasons: string[];
}
export interface EffectiveContextCapabilities {
    contextGateway: boolean;
    repositoryMap: boolean;
    semanticRetrieval: boolean;
    authorizedRetrieval: boolean;
    mcpServers: {
        serena: boolean;
        context: boolean;
        headroom: boolean;
    };
    requirements: ResolvedContextCapabilityRequirements;
    runtimeCapabilities: RuntimeCapabilities;
    transportCapabilities: TransportCapabilities;
    requiredByProject: {
        semanticRetrieval: boolean;
        rawRetrieval: boolean;
        repositoryMap: boolean;
        compression: boolean;
    };
    requiredByExecutionContract: {
        semanticRetrieval: boolean;
        rawRetrieval: boolean;
        repositoryMap: boolean;
        compression: boolean;
    };
    readinessRequirements: string[];
    degradations: string[];
    reasons: string[];
}
export interface TransportProbe {
    commandExists?: (command: string, cwd: string) => Promise<boolean>;
    run?: typeof runShell;
}
export interface PodmanSerenaProbe {
    available: boolean;
    imagePresent: boolean;
    exposesSerena: boolean;
    message: string;
}
export declare function resolveContextCapabilityRequirements(config: HarnessProjectConfig, selection: AgentExecutionSelection): ResolvedContextCapabilityRequirements;
export declare function runtimeCapabilitiesFor(selection: AgentExecutionSelection): RuntimeCapabilities;
export declare function transportCapabilitiesFor(config: HarnessProjectConfig, selection: AgentExecutionSelection): TransportCapabilities;
/** Resolve effective capabilities without touching external runtimes. */
export declare function staticContextCapabilities(config: HarnessProjectConfig, selection: AgentExecutionSelection): EffectiveContextCapabilities;
export declare function resolveContextTransportCapabilities(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, probe?: TransportProbe & {
    mode?: "static" | "live";
}): Promise<EffectiveContextCapabilities>;
/** Bounded, no-pull diagnostic for an explicitly provisioned Podman image. */
export declare function probePodmanSerena(root: string, image: string, probe?: TransportProbe): Promise<PodmanSerenaProbe>;
