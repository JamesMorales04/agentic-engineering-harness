import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { executeAgentPrompt } from "./agentPrompt.js";
import type { WorkerExecutor } from "./types.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";

export class PodmanWorkerExecutor implements WorkerExecutor {
  readonly name = "podman";

  async doctor(root: string, config: HarnessProjectConfig): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("podman", root);
    if (!ok) return { ok: false, message: "Podman CLI not found." };
    if (!config.security?.sandbox?.image) return { ok: false, message: "security.sandbox.image is required for Podman worker execution." };
    return { ok: true, message: "Hardened Podman worker sandbox configured." };
  }

  async start(root: string, config: HarnessProjectConfig, contract: TaskContract, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    if (!selection) throw new Error("Podman execution requires a resolved agent selection.");
    const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", required: true });
    if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: Podman execution authority could not be prepared.");
    return executeAgentPrompt(root, config, contract, selection, buildWorkerPrompt(contract, selection), {
      outputContract: selection.outputContract,
      phase: "implementation",
      participantId: authority.participantId,
      capabilityAuthority: authority,
      requireExecutionAuthority: true
    });
  }

  async repair(root: string, config: HarnessProjectConfig, contract: TaskContract, session: WorkerSession, packet: RepairPacket, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    if (!selection) throw new Error("Podman repair requires a resolved agent selection.");
    const authority = await prepareExecutionAuthority(root, selection, { participantId: session.participantId, phase: "repair", required: true });
    if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: Podman repair authority could not be prepared.");
    return executeAgentPrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, {
      outputContract: selection.outputContract,
      phase: "repair",
      participantId: authority.participantId,
      capabilityAuthority: authority,
      requireExecutionAuthority: true
    });
  }
}
