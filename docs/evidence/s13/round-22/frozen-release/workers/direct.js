import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { executeAgentPrompt } from "./agentPrompt.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";
export class DirectWorkerExecutor {
    name = "direct";
    async doctor(root, _config, selection) {
        if (!selection)
            return { ok: false, message: "Direct execution requires a resolved agent selection." };
        const command = selection.runtimeAdapter === "opencode" ? "opencode" : selection.runtimeAdapter === "codex" ? "codex" : selection.runtimeName;
        const ok = await commandExists(command, root);
        return { ok, message: ok ? `${command} CLI detected for ${selection.logicalAgent}.` : `${command} CLI not found.` };
    }
    async start(root, config, contract, selection) {
        if (!selection)
            throw new Error("Direct execution requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: direct execution authority could not be prepared.");
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
            throw new Error("Direct repair requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { participantId: session.participantId, phase: "repair", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: direct repair authority could not be prepared.");
        return executeAgentPrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, {
            outputContract: selection.outputContract,
            phase: "repair",
            participantId: authority.participantId,
            capabilityAuthority: authority,
            requireExecutionAuthority: true
        });
    }
}
//# sourceMappingURL=direct.js.map