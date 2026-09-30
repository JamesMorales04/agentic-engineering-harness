import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { executeAgentPrompt } from "./agentPrompt.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";
export class PodmanWorkerExecutor {
    name = "podman";
    async doctor(root, config) {
        const ok = await commandExists("podman", root);
        if (!ok)
            return { ok: false, message: "Podman CLI not found." };
        if (!config.security?.sandbox?.image)
            return { ok: false, message: "security.sandbox.image is required for Podman worker execution." };
        return { ok: true, message: "Hardened Podman worker sandbox configured." };
    }
    async start(root, config, contract, selection) {
        if (!selection)
            throw new Error("Podman execution requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: Podman execution authority could not be prepared.");
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
            throw new Error("Podman repair requires a resolved agent selection.");
        const authority = await prepareExecutionAuthority(root, selection, { participantId: session.participantId, phase: "repair", required: true });
        if (!authority)
            throw new Error("V2_AUTHORITY_REQUIRED: Podman repair authority could not be prepared.");
        return executeAgentPrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, {
            outputContract: selection.outputContract,
            phase: "repair",
            participantId: authority.participantId,
            capabilityAuthority: authority,
            requireExecutionAuthority: true
        });
    }
}
//# sourceMappingURL=podman.js.map