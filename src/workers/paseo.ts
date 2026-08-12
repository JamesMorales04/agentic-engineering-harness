import type { AgentExecutionSelection } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { detectPaseoCapabilities } from "../paseo/capabilities.js";
import { continueManagedPaseoAgent, launchManagedPaseoAgent } from "../paseo/runtime.js";
import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import type { WorkerExecutor } from "./types.js";

export class PaseoWorkerExecutor implements WorkerExecutor {
  readonly name = "paseo";
  async doctor(root: string, _config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("paseo", root); if (!ok) return { ok: false, message: "Paseo CLI not found." };
    if (selection) { const issues = validateExecutionCapabilities(selection, "paseo"); if (issues.length) return { ok: false, message: issues.join("; ") }; }
    try {
      const caps = await detectPaseoCapabilities(root);
      if (!caps.background) return { ok: false, message: `Installed Paseo${caps.version ? ` ${caps.version}` : ""} does not advertise background runs required by the compatibility fallback.` };
      return { ok: true, message: `Paseo detected${caps.version ? ` (${caps.version})` : ""}; @getpaseo/client is primary and the CLI remains available for daemon/bootstrap fallback.` };
    } catch (error) { return { ok: false, message: `Paseo capability probe failed: ${String(error)}` }; }
  }
  async start(root: string, config: HarnessProjectConfig, contract: TaskContract, selection?: AgentExecutionSelection): Promise<WorkerSession> { return this.launch(root, config, contract, buildWorkerPrompt(contract, selection), selection); }
  async repair(root: string, config: HarnessProjectConfig, contract: TaskContract, session: WorkerSession, packet: RepairPacket, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    if (session.id && (!selection || session.logicalAgent === selection.logicalAgent)) {
      const continued = await continueManagedPaseoAgent(root, session.id, buildRepairPrompt(packet), config.orchestration?.worker?.timeoutSeconds);
      return { ...session, exitCode: continued.exitCode, stdout: continued.stdout || session.stdout, stderr: [session.stderr, continued.stderr].filter(Boolean).join("\n") };
    }
    return this.launch(root, config, contract, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, selection);
  }
  private async launch(root: string, config: HarnessProjectConfig, contract: TaskContract, prompt: string, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    const worker = config.orchestration?.worker;
    const provider = selection?.paseoProvider ?? worker?.provider ?? "opencode";
    const model = selection ? (selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId) : worker?.model;
    const logicalAgent = selection?.logicalAgent ?? "worker";
    const title = `${worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${logicalAgent}`;
    const workspaceId = await deliveryWorkspaceId(root, config, contract.task.id);
    const labels: Record<string, string> = {
      "aeh.project": config.project.name,
      "aeh.kind": "worker",
      "aeh.task": contract.task.id,
      "aeh.role": logicalAgent
    };
    if (selection?.profile) labels["aeh.profile"] = selection.profile;
    const launched = await launchManagedPaseoAgent(root, {
      cwd: root,
      title,
      provider,
      model,
      workspaceId,
      prompt,
      labels,
      timeoutSeconds: worker?.timeoutSeconds ?? 1800
    });
    return {
      id: launched.id,
      provider,
      model,
      logicalAgent: selection?.logicalAgent,
      nativeAgent: selection?.nativeAgent,
      runtime: selection?.runtimeName,
      profile: selection?.profile,
      exitCode: launched.exitCode,
      stdout: launched.stdout,
      stderr: launched.stderr
    };
  }
}
