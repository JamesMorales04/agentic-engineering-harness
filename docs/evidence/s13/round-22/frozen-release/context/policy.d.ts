import type { ContextConfiguration, HarnessProjectConfig } from "../core/types.js";
import type { ContextPolicy } from "./types.js";
export declare function resolveContextPolicy(config: HarnessProjectConfig | ContextConfiguration | undefined): ContextPolicy;
export declare function outputMode(policy: ContextPolicy, role: string | undefined): "terse" | "compact" | "normal";
export declare function isCompressionConfigured(policy: ContextPolicy): boolean;
export declare function outputPolicyInstruction(policy: ContextPolicy, role: string | undefined): string | undefined;
