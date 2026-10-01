import { type OpenCodeAgentBindingSource } from "../agents/permissions.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { PaseoSdkMcpStdioServer, PaseoSdkToolPolicy } from "./sdk.js";
import { type EffectiveContextCapabilities } from "../context/transport.js";
import type { CapabilityLeaseV1 } from "../security/authorityV2.js";
import { type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
export interface PaseoLaunchSpecOptions {
    selection?: AgentExecutionSelection;
    logicalAgent?: string;
    provider?: string;
    model?: string;
    titlePrefix?: string;
    phase?: string;
    kind?: string;
    parentAgentId?: string;
    supervisorAgent?: boolean;
    contextCapabilities?: EffectiveContextCapabilities;
    participantId?: string;
    candidateDigest?: string;
    capabilityLeases?: CapabilityLeaseV1[];
    executionBinding?: ExecutionBindingV2;
    executionBlueprintDigest?: string;
    roleInvocationPolicyDigest?: string;
    skillManifestDigest?: string;
    contextManifestDigest?: string;
    promptManifestDigest?: string;
}
export interface PaseoAgentLaunchSpec {
    cwd: string;
    title: string;
    provider: string;
    model?: string;
    modeId?: string;
    modeSource?: OpenCodeAgentBindingSource;
    thinkingOptionId?: string;
    env?: Record<string, string>;
    nativeAgentId?: string;
    workspaceId?: string;
    parentAgentId?: string;
    /** Paseo parent handle; omitted for isolated launches so the provider cannot relocate the cwd. */
    paseoParentAgentId?: string;
    supervisorGeneration?: number;
    labels: Record<string, string>;
    timeoutSeconds: number;
    operationId: string;
    operationKind: string;
    phase: string;
    mcpServers?: Record<string, PaseoSdkMcpStdioServer>;
    toolPolicy?: PaseoSdkToolPolicy;
    providerOptions?: Record<string, unknown>;
    featureValues?: Record<string, unknown>;
}
export declare function compilePaseoAgentLaunchSpec(root: string, config: HarnessProjectConfig, contract: TaskContract, options?: PaseoLaunchSpecOptions): Promise<PaseoAgentLaunchSpec>;
export declare function inferAgentPhase(selection: AgentExecutionSelection | undefined, logicalAgent: string): string;
