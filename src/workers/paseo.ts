import type { AgentExecutionSelection } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { detectPaseoCapabilities } from "../paseo/capabilities.js";
import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { executeAgentPrompt } from "./agentPrompt.js";
import type { WorkerExecutor } from "./types.js";
import { prepareExecutionAuthority } from "../security/executionLease.js";

export class PaseoWorkerExecutor implements WorkerExecutor {
  readonly name = "paseo";

  async doctor(
    root: string,
    _config: HarnessProjectConfig,
    selection?: AgentExecutionSelection
  ): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("paseo", root);
    if (!ok) return { ok: false, message: "Paseo CLI not found." };
    if (selection) {
      const issues = validateExecutionCapabilities(selection, "paseo");
      if (issues.length) return { ok: false, message: issues.join("; ") };
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
    } catch (error) {
      return { ok: false, message: `Paseo capability probe failed: ${String(error)}` };
    }
  }

  async start(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    if (!selection) throw new Error("Paseo execution requires a resolved agent selection.");
    const authority = await prepareExecutionAuthority(root, selection, { phase: "implementation", required: true });
    if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: Paseo execution authority could not be prepared.");
    return executeAgentPrompt(root, config, contract, selection, buildWorkerPrompt(contract, selection), {
      outputContract: selection.outputContract,
      phase: "implementation",
      participantId: authority.participantId,
      capabilityAuthority: authority,
      requireExecutionAuthority: true
    });
  }

  async repair(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    session: WorkerSession,
    packet: RepairPacket,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    if (!selection) throw new Error("Paseo repair requires a resolved agent selection.");
    const authority = await prepareExecutionAuthority(root, selection, { participantId: session.participantId, phase: "repair", required: true });
    if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: Paseo repair authority could not be prepared.");
    return executeAgentPrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, {
      outputContract: selection.outputContract,
      phase: "repair",
      participantId: authority.participantId,
      capabilityAuthority: authority,
      requireExecutionAuthority: true
    });
  }
}
