import type { HarnessProjectConfig } from "../core/types.js";
export interface TopologyCheckResult {
    ok: boolean;
    issues: string[];
    output?: string;
}
export declare function compileAgentTopology(root: string, config: HarnessProjectConfig, profile?: string, checkOnly?: boolean): Promise<TopologyCheckResult>;
export declare function validateAgentTopology(root: string, config: HarnessProjectConfig, profile?: string): Promise<TopologyCheckResult>;
