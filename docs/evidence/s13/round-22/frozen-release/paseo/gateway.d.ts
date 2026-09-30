import { type PaseoSdkAgentRecord, type PaseoSdkAgentResult } from "./sdk.js";
import { type PaseoNativeAgentSnapshot, type PaseoProviderPreflightResult } from "./native.js";
export type PaseoGatewayStatus = "AVAILABLE" | "DEGRADED";
export interface PaseoLeadConversationV1 {
    leadId: string;
    status?: string;
    lastMessage?: string;
    error?: string;
}
export interface PaseoParticipantTimelineV1 {
    participantId: string;
    entries: unknown[];
    status?: string;
    source: "paseo-sdk" | "unavailable";
}
export interface PaseoCapabilityProfileV1 {
    provider: string;
    model?: string;
    structuredOutput: "available" | "unknown";
    preflight: PaseoProviderPreflightResult;
}
export interface PaseoGatewaySnapshotV1 {
    version: 1;
    status: PaseoGatewayStatus;
    capturedAt: string;
    message?: string;
    lead?: PaseoNativeAgentSnapshot | PaseoSdkAgentRecord;
    participants: PaseoSdkAgentRecord[];
    capability?: PaseoCapabilityProfileV1;
}
export interface PaseoGatewayDeps {
    inspectLead?: (root: string, agentId: string) => Promise<PaseoSdkAgentRecord | undefined>;
    listParticipants?: (root: string, labels?: Record<string, string>) => Promise<PaseoSdkAgentRecord[]>;
    readTimeline?: (root: string, participantId: string) => Promise<unknown[] | undefined>;
    dispatchLead?: (root: string, agentId: string, prompt: string, timeoutMs?: number) => Promise<PaseoSdkAgentResult>;
    preflight?: (root: string, provider: string, model?: string) => Promise<PaseoProviderPreflightResult>;
}
/**
 * Typed Control Center boundary for the small set of Paseo interactions that
 * have product meaning. It deliberately does not expose a generic RPC or
 * arbitrary daemon method forwarding surface.
 */
export declare class PaseoGatewayV1 {
    private readonly deps;
    constructor(deps?: PaseoGatewayDeps);
    snapshot(input: {
        root: string;
        leadId?: string;
        participantLabels?: Record<string, string>;
        provider?: string;
        model?: string;
    }): Promise<PaseoGatewaySnapshotV1>;
    leadConversation(input: {
        root: string;
        leadId: string;
        prompt: string;
        timeoutMs?: number;
    }): Promise<PaseoLeadConversationV1>;
    participantTimeline(input: {
        root: string;
        participantId: string;
    }): Promise<PaseoParticipantTimelineV1>;
    capability(input: {
        root: string;
        provider: string;
        model?: string;
    }): Promise<PaseoCapabilityProfileV1>;
}
