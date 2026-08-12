import type { AgentExecutionSelection } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { detectPaseoCapabilities, buildPaseoBackgroundRunCommand, extractPaseoAgentId } from "../paseo/capabilities.js";
import { commandExists, runProcess } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import type { WorkerExecutor } from "./types.js";

export class PaseoWorkerExecutor implements WorkerExecutor {
  readonly name = "paseo";
  async doctor(root: string, _config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<{ ok: boolean; message: string }> {
    const ok = await commandExists("paseo", root); if (!ok) return { ok: false, message: "Paseo CLI not found." };
    if (selection) { const issues = validateExecutionCapabilities(selection, "paseo"); if (issues.length) return { ok: false, message: issues.join("; ") }; }
    try { const caps = await detectPaseoCapabilities(root); if (!caps.background) return { ok: false, message: `Installed Paseo${caps.version ? ` ${caps.version}` : ""} does not advertise background runs required by the CLI fallback.` }; return { ok: true, message: `Paseo CLI detected${caps.version ? ` (${caps.version})` : ""}; launch flags negotiated dynamically.` }; }
    catch (error) { return { ok: false, message: `Paseo capability probe failed: ${String(error)}` }; }
  }
  async start(root: string, config: HarnessProjectConfig, contract: TaskContract, selection?: AgentExecutionSelection): Promise<WorkerSession> { return this.launch(root, config, contract, buildWorkerPrompt(contract, selection), selection); }
  async repair(root: string, config: HarnessProjectConfig, contract: TaskContract, session: WorkerSession, packet: RepairPacket, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    if (session.id && (!selection || session.logicalAgent === selection.logicalAgent)) {
      const send = await runProcess(`paseo send ${quote(session.id)} --no-wait ${quote(buildRepairPrompt(packet))}`, { cwd: root, timeoutMs: 60_000 });
      if (send.exitCode !== 0) throw new Error(`Paseo failed to send repair prompt: ${send.stderr || send.stdout}`);
      return this.waitAndCollect(root, config, session);
    }
    return this.launch(root, config, contract, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, selection);
  }
  private async launch(root: string, config: HarnessProjectConfig, contract: TaskContract, prompt: string, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    const worker = config.orchestration?.worker;
    const provider = selection?.paseoProvider ?? worker?.provider ?? "opencode";
    const model = selection ? (selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId) : worker?.model;
    const title = `${worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${selection?.logicalAgent ?? "worker"}`;
    const workspaceId = await deliveryWorkspaceId(root, config, contract.task.id);
    const capabilities = await detectPaseoCapabilities(root);
    const command = buildPaseoBackgroundRunCommand({ title, provider, model, workspaceId, prompt }, capabilities);
    const launch = await runProcess(command, { cwd: root, timeoutMs: 60_000 });
    if (launch.exitCode !== 0) throw new Error(`Paseo failed to launch worker${capabilities.version ? ` with ${capabilities.version}` : ""}: ${launch.stderr || launch.stdout}`);
    const id = extractPaseoAgentId(launch.stdout);
    if (!id) throw new Error("Paseo returned no parseable agent id for the background worker.");
    return this.waitAndCollect(root, config, { id, provider, model, logicalAgent: selection?.logicalAgent, nativeAgent: selection?.nativeAgent, runtime: selection?.runtimeName, profile: selection?.profile, exitCode: 0, stdout: launch.stdout, stderr: "" });
  }
  private async waitAndCollect(root: string, config: HarnessProjectConfig, session: WorkerSession): Promise<WorkerSession> {
    const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
    const wait = await runProcess(`paseo wait ${quote(session.id!)} --timeout ${timeout}`, { cwd: root, timeoutMs: (timeout + 30) * 1000 });
    if (wait.exitCode !== 0) return { ...session, exitCode: wait.exitCode, stderr: wait.stderr || wait.stdout };
    const logs = await runProcess(`paseo logs ${quote(session.id!)} --tail 30`, { cwd: root, timeoutMs: 60_000 });
    return { ...session, exitCode: 0, stdout: logs.stdout || wait.stdout || session.stdout, stderr: [session.stderr, wait.stderr, logs.stderr].filter(Boolean).join("\n") };
  }
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
