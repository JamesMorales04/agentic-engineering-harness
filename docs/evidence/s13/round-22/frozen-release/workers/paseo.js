import { validateExecutionCapabilities } from "../agents/permissions.js";
import { detectPaseoCapabilities } from "../paseo/capabilities.js";
import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { executeAgentPrompt } from "./agentPrompt.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";
export class PaseoWorkerExecutor {
    name = "paseo";
    async doctor(root, _config, selection) {
        const ok = await commandExists("paseo", root);
        if (!ok)
            return { ok: false, message: "Paseo CLI not found." };
        if (selection) {
            const issues = validateExecutionCapabilities(selection, "paseo");
            if (issues.length)
                return { ok: false, message: issues.join("; ") };
        }
        try {
            const caps = await detectPaseoCapabilities(root);
            if (!caps.background) {
                return {
                    ok: false,
                    message: `Installed Paseo${caps.version ? ` ${caps.version}` : ""} does not advertise background runs required by managed worker execution.`
                };
            }
            return {
                ok: true,
                message: `Paseo detected${caps.version ? ` (${caps.version})` : ""}; managed worker turns use the frozen execution-binding lifecycle.`
            };
        }
        catch (error) {
            return { ok: false, message: `Paseo capability probe failed: ${String(error)}` };
        }
    }
    async start(root, config, contract, selection) {
        if (!selection)
            throw new Error("Paseo execution requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: Paseo execution authority could not be prepared.");
        return executeAgentPrompt(root, config, contract, selection, buildWorkerPrompt(contract, selection), {
            outputContract: selection.outputContract,
            phase: "implementation",
            participantId: authority.participantId,
            capabilityAuthority: authority,
            requireExecutionAuthority: true
        });
    }
    async repair(root, config, contract, session, packet, selection) {
        if (!selection)
            throw new Error("Paseo repair requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { participantId: session.participantId, phase: "repair", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: Paseo repair authority could not be prepared.");
        return executeAgentPrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, {
            outputContract: selection.outputContract,
            phase: "repair",
            participantId: authority.participantId,
            capabilityAuthority: authority,
            requireExecutionAuthority: true
        });
    }
}
//# sourceMappingURL=paseo.js.map