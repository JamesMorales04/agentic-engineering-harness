import { resolveContextAgentIdentity } from "../operations/mcp.js";
export async function resolveControlCenterLeadBinding(root, expectedStartLeadId) {
    let currentLeadId;
    try {
        const identity = await resolveContextAgentIdentity(root, undefined, {});
        currentLeadId = identity.agentId;
    }
    catch (error) {
        if (expectedStartLeadId) {
            throw new Error(`Control Center refused to bind the lead started by aeh start because current durable managed-lead identity could not be validated: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            status: "UNCONFIGURED",
            reason: error instanceof Error ? error.message : String(error)
        };
    }
    if (expectedStartLeadId && currentLeadId !== expectedStartLeadId) {
        throw new Error("Control Center refused to bind the lead started by aeh start because it does not match the current durable managed-lead identity.");
    }
    return { status: "BOUND", leadId: currentLeadId };
}
//# sourceMappingURL=leadBinding.js.map