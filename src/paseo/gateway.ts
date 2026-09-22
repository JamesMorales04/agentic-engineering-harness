import {
  dispatchPaseoSdkAgent,
  inspectPaseoSdkAgent,
  inspectPaseoSdkAgentTimeline,
  listPaseoSdkAgents,
  type PaseoSdkAgentRecord,
  type PaseoSdkAgentResult
} from "./sdk.js";
import { preflightPaseoProviderModel, type PaseoNativeAgentSnapshot, type PaseoProviderPreflightResult } from "./native.js";

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
export class PaseoGatewayV1 {
  private readonly deps: Required<PaseoGatewayDeps>;

  constructor(deps: PaseoGatewayDeps = {}) {
    this.deps = {
      inspectLead: deps.inspectLead ?? inspectPaseoSdkAgent,
      listParticipants: deps.listParticipants ?? listPaseoSdkAgents,
      readTimeline: deps.readTimeline ?? inspectPaseoSdkAgentTimeline,
      dispatchLead: deps.dispatchLead ?? dispatchPaseoSdkAgent,
      preflight: deps.preflight ?? preflightPaseoProviderModel
    };
  }

  async snapshot(input: { root: string; leadId?: string; participantLabels?: Record<string, string>; provider?: string; model?: string }): Promise<PaseoGatewaySnapshotV1> {
    try {
      const [lead, participants, capability] = await Promise.all([
        input.leadId ? this.deps.inspectLead(input.root, input.leadId) : Promise.resolve(undefined),
        this.deps.listParticipants(input.root, input.participantLabels),
        input.provider ? this.capability({ root: input.root, provider: input.provider, model: input.model }) : Promise.resolve(undefined)
      ]);
      return { version: 1, status: "AVAILABLE", capturedAt: new Date().toISOString(), ...(lead ? { lead } : {}), participants, ...(capability ? { capability } : {}) };
    } catch (error) {
      return { version: 1, status: "DEGRADED", capturedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), participants: [] };
    }
  }

  async leadConversation(input: { root: string; leadId: string; prompt: string; timeoutMs?: number }): Promise<PaseoLeadConversationV1> {
    try {
      const result = await this.deps.dispatchLead(input.root, input.leadId, input.prompt, input.timeoutMs);
      return { leadId: input.leadId, status: result.status, lastMessage: result.lastMessage, error: result.error };
    } catch (error) {
      return { leadId: input.leadId, status: "DEGRADED", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async participantTimeline(input: { root: string; participantId: string }): Promise<PaseoParticipantTimelineV1> {
    try {
      const [record, entries] = await Promise.all([
        this.deps.inspectLead(input.root, input.participantId),
        this.deps.readTimeline(input.root, input.participantId)
      ]);
      return { participantId: input.participantId, entries: entries ?? [], ...(record?.status ? { status: record.status } : {}), source: entries ? "paseo-sdk" : "unavailable" };
    } catch {
      return { participantId: input.participantId, entries: [], source: "unavailable" };
    }
  }

  async capability(input: { root: string; provider: string; model?: string }): Promise<PaseoCapabilityProfileV1> {
    const preflight = await this.deps.preflight(input.root, input.provider, input.model);
    return { provider: input.provider, ...(input.model ? { model: input.model } : {}), structuredOutput: "unknown", preflight };
  }
}
