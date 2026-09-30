import { dispatchPaseoSdkAgent, inspectPaseoSdkAgent, inspectPaseoSdkAgentTimeline, listPaseoSdkAgents } from "./sdk.js";
import { preflightPaseoProviderModel } from "./native.js";
/**
 * Typed Control Center boundary for the small set of Paseo interactions that
 * have product meaning. It deliberately does not expose a generic RPC or
 * arbitrary daemon method forwarding surface.
 */
export class PaseoGatewayV1 {
    deps;
    constructor(deps = {}) {
        this.deps = {
            inspectLead: deps.inspectLead ?? inspectPaseoSdkAgent,
            listParticipants: deps.listParticipants ?? listPaseoSdkAgents,
            readTimeline: deps.readTimeline ?? inspectPaseoSdkAgentTimeline,
            dispatchLead: deps.dispatchLead ?? dispatchPaseoSdkAgent,
            preflight: deps.preflight ?? preflightPaseoProviderModel
        };
    }
    async snapshot(input) {
        try {
            const [lead, participants, capability] = await Promise.all([
                input.leadId ? this.deps.inspectLead(input.root, input.leadId) : Promise.resolve(undefined),
                this.deps.listParticipants(input.root, input.participantLabels),
                input.provider ? this.capability({ root: input.root, provider: input.provider, model: input.model }) : Promise.resolve(undefined)
            ]);
            return { version: 1, status: "AVAILABLE", capturedAt: new Date().toISOString(), ...(lead ? { lead } : {}), participants, ...(capability ? { capability } : {}) };
        }
        catch (error) {
            return { version: 1, status: "DEGRADED", capturedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), participants: [] };
        }
    }
    async leadConversation(input) {
        try {
            const result = await this.deps.dispatchLead(input.root, input.leadId, input.prompt, input.timeoutMs);
            return { leadId: input.leadId, status: result.status, lastMessage: result.lastMessage, error: result.error };
        }
        catch (error) {
            return { leadId: input.leadId, status: "DEGRADED", error: error instanceof Error ? error.message : String(error) };
        }
    }
    async participantTimeline(input) {
        try {
            const [record, entries] = await Promise.all([
                this.deps.inspectLead(input.root, input.participantId),
                this.deps.readTimeline(input.root, input.participantId)
            ]);
            return { participantId: input.participantId, entries: entries ?? [], ...(record?.status ? { status: record.status } : {}), source: entries ? "paseo-sdk" : "unavailable" };
        }
        catch {
            return { participantId: input.participantId, entries: [], source: "unavailable" };
        }
    }
    async capability(input) {
        const preflight = await this.deps.preflight(input.root, input.provider, input.model);
        return { provider: input.provider, ...(input.model ? { model: input.model } : {}), structuredOutput: "unknown", preflight };
    }
}
//# sourceMappingURL=gateway.js.map