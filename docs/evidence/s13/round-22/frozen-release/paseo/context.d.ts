import type { HarnessProjectConfig } from "../core/types.js";
import { runShell } from "../utils/process.js";
import { startPaseoHarness } from "./start.js";
import { inspectPaseoNativeAgent } from "./native.js";
import { recordPaseoTrace } from "./trace.js";
export type ContextGuardState = "OK" | "PRESSURE" | "HANDOFF_REQUIRED" | "HARD_HANDOFF" | "NO_USAGE_YET" | "USAGE_UNAVAILABLE" | "UNKNOWN";
export interface ContextUsage {
    used?: number;
    limit?: number;
    ratio?: number;
    source: string;
    availability?: "available" | "no-usage-yet" | "provider-usage-unavailable" | "agent-unavailable";
}
export interface LeadHandoffArtifact {
    version: 1;
    createdAt: string;
    reason: "CONTEXT_PRESSURE";
    project: string;
    previousAgentId: string;
    rotatedAgentId?: string;
    context: ContextUsage;
    branch?: string;
    activeRun?: string;
    latestAudit?: string;
    latestDelivery?: string;
    semanticBrief?: string;
    nextInstruction: string;
}
export interface ContextGuardResult {
    state: ContextGuardState;
    usage: ContextUsage;
    handoffPath?: string;
    rotatedAgentId?: string;
    message: string;
}
type Runner = typeof runShell;
type Starter = typeof startPaseoHarness;
type Inspector = typeof inspectPaseoNativeAgent;
type Trace = typeof recordPaseoTrace;
export interface ContextGuardOptions {
    brief?: string;
    run?: Runner;
    autoRotate?: boolean;
    aehCommand?: string;
    start?: Starter;
    inspect?: Inspector;
    trace?: Trace;
}
export declare function statusLeadContext(root: string, config: HarnessProjectConfig, agentId: string, options?: Pick<ContextGuardOptions, "inspect" | "trace">): Promise<ContextGuardResult>;
export declare function guardLeadContext(root: string, config: HarnessProjectConfig, agentId: string, options?: ContextGuardOptions): Promise<ContextGuardResult>;
export declare function inspectPaseoContextUsage(root: string, agentId: string, inspect?: Inspector): Promise<ContextUsage>;
/** Compatibility helper retained for callers/tests, but intentionally strict. */
export declare function extractContextUsage(value: unknown): ContextUsage;
export {};
