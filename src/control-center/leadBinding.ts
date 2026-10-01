import { resolveContextAgentIdentity } from "../operations/mcp.js";

export type ControlCenterLeadBindingV1 =
  | { status: "BOUND"; leadId: string }
  | { status: "UNCONFIGURED"; reason: string };

export async function resolveControlCenterLeadBinding(
  root: string,
  expectedStartLeadId?: string
): Promise<ControlCenterLeadBindingV1> {
  let currentLeadId: string;
  try {
    const identity = await resolveContextAgentIdentity(root, undefined, {});
    currentLeadId = identity.agentId;
  } catch (error) {
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
