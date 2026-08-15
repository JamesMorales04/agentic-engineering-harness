import type { AgentExecutionSelection } from "../agents/types.js";
import { compileOpenCodeRuntimeProjection } from "../agents/permissions.js";
import type {
  HarnessProjectConfig,
  RepairPacket,
  TaskContract,
  WorkerSession
} from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import { buildEffectivePrompt } from "./agentPrompt.js";
import { resolveContextTransportCapabilities, type EffectiveContextCapabilities } from "../context/transport.js";
import type { WorkerExecutor } from "./types.js";

export class DirectWorkerExecutor implements WorkerExecutor {
  readonly name = "direct";

  async doctor(
    root: string,
    _config: HarnessProjectConfig,
    selection?: AgentExecutionSelection
  ): Promise<{ ok: boolean; message: string }> {
    if (!selection) {
      return { ok: false, message: "Direct execution requires a resolved agent selection." };
    }
    const command =
      selection.runtimeAdapter === "opencode"
        ? "opencode"
        : selection.runtimeAdapter === "codex"
          ? "codex"
          : selection.runtimeName;
    const ok = await commandExists(command, root);
    return {
      ok,
      message: ok
        ? `${command} CLI detected for ${selection.logicalAgent}.`
        : `${command} CLI not found.`
    };
  }

  async start(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    if (!selection) throw new Error("Direct execution requires a resolved agent selection.");
    const contextCapabilities = await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
    const prompt = await buildEffectivePrompt(root, config, contract, selection, buildWorkerPrompt(contract, selection), { phase: "implementation", contextCapabilities });
    return this.run(root, config, contract, prompt, selection, contextCapabilities);
  }

  async repair(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    _session: WorkerSession,
    packet: RepairPacket,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    if (!selection) throw new Error("Direct repair requires a resolved agent selection.");
    const contextCapabilities = await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
    const prompt = await buildEffectivePrompt(root, config, contract, selection, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, { phase: "implementation", contextCapabilities });
    return this.run(
      root,
      config,
      contract,
      prompt,
      selection,
      contextCapabilities
    );
  }

  private async run(
    root: string,
    config: HarnessProjectConfig,
    _contract: TaskContract,
    prompt: string,
    selection: AgentExecutionSelection,
    contextCapabilities?: EffectiveContextCapabilities
  ): Promise<WorkerSession> {
    let command: string;
    let env: Record<string, string | undefined> | undefined;
    let nativeAgent = selection.nativeAgent;

    if (selection.runtimeAdapter === "opencode") {
      const projection = compileOpenCodeRuntimeProjection(selection, config, contextCapabilities);
      nativeAgent = projection.binding.agentId;
      const args = [
        "opencode",
        "run",
        "--auto",
        "--format",
        "json",
        "--model",
        selection.modelId
      ];
      if (selection.variant) args.push("--variant", selection.variant);
      args.push("--agent", projection.binding.agentId);
      args.push(...selection.args, prompt);
      command = args.map(quote).join(" ");
      env = projection.env;
    } else if (selection.runtimeAdapter === "codex") {
      const args = [
        "codex",
        "exec",
        "--json",
        "--model",
        selection.modelName,
        ...selection.args,
        prompt
      ];
      command = args.map(quote).join(" ");
    } else {
      throw new Error(`No direct runtime adapter for ${selection.runtimeAdapter}`);
    }

    const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
    const result = await runProcess(command, {
      cwd: root,
      timeoutMs: timeout * 1000,
      env
    });
    return {
      provider: selection.runtimeAdapter,
      model: selection.modelName,
      logicalAgent: selection.logicalAgent,
      nativeAgent,
      runtime: selection.runtimeName,
      profile: selection.profile,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
