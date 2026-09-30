import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentTopologyLayer, AgentTopologySource, ResolvedAgentTopology } from "./types.js";
export declare function loadAgentTopologySource(root: string, config: HarnessProjectConfig): Promise<AgentTopologySource>;
export declare function composeAgentTopologyLayers(base: AgentTopologyLayer, overlay: AgentTopologyLayer): AgentTopologyLayer;
export declare function loadResolvedAgentTopology(root: string, config: HarnessProjectConfig, profileOverride?: string): Promise<ResolvedAgentTopology>;
export declare function resolveAgentTopology(source: AgentTopologySource, profileOverride?: string): ResolvedAgentTopology;
