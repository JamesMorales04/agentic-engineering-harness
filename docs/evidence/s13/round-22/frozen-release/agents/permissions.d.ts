import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection } from "./types.js";
import { type EffectiveContextCapabilities } from "../context/transport.js";
export type OpenCodeAgentBindingSource = "aeh-managed" | "explicit";
export interface OpenCodeAgentBinding {
    agentId: string;
    source: OpenCodeAgentBindingSource;
    managed: boolean;
}
export interface OpenCodeRuntimeProjection {
    binding: OpenCodeAgentBinding;
    config: Record<string, unknown>;
    env: Record<string, string>;
}
export declare function validateExecutionCapabilities(selection: AgentExecutionSelection, transport: string): string[];
export declare function permissionSummary(selection: AgentExecutionSelection): string;
/**
 * Resolve the concrete OpenCode execution identity for an AEH logical agent.
 *
 * Explicit nativeAgent is an externally-authored OpenCode primary/all agent and
 * is preserved exactly. Otherwise AEH owns the native identity and injects a
 * primary agent with a deterministic collision-resistant name into the
 * session-local OpenCode config.
 */
export declare function resolveOpenCodeAgentBinding(selection: AgentExecutionSelection): OpenCodeAgentBinding;
/**
 * Compile the inline OpenCode configuration used by direct, Podman and Paseo
 * transports. OPENCODE_CONFIG_CONTENT is loaded after ordinary user/project
 * config, so the AEH-managed identity and policy are deterministic without
 * mutating the user's global OpenCode configuration.
 */
export declare function buildOpenCodeRuntimeConfig(selection: AgentExecutionSelection, config?: HarnessProjectConfig, binding?: OpenCodeAgentBinding, resolvedContextCapabilities?: EffectiveContextCapabilities, authorizedRoots?: string[], launchRoot?: string, serenaOwnerId?: string): Record<string, unknown>;
export declare function compileOpenCodeRuntimeProjection(selection: AgentExecutionSelection, config?: HarnessProjectConfig, resolvedContextCapabilities?: EffectiveContextCapabilities, authorizedRoots?: string[], launchRoot?: string, serenaOwnerId?: string): OpenCodeRuntimeProjection;
