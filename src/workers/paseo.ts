import type { AgentExecutionSelection } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import type {
  HarnessProjectConfig,
  RepairPacket,
  TaskContract,
  WorkerSession
} from "../core/types.js";
import { detectPaseoCapabilities } from "../paseo/capabilities.js";
import { compilePaseoAgentLaunchSpec } from "../paseo/launchSpec.js";
import {
  continueManagedPaseoAgent,
  launchManagedPaseoAgent
} from "../paseo/runtime.js";
import { commandExists } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import type { WorkerExecutor } from "./types.js";

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
          message: `Installed Paseo${caps.version ? ` ${caps.version}` : ""} does not advertise background runs required by the compatibility fallback.`
        };
      }
      return {
        ok: true,
        message: `Paseo detected${caps.version ? ` (${caps.version})` : ""}; @getpaseo/client is primary and the CLI remains available only as a compatibility path.`
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
    return this.launch(root, config, contract, buildWorkerPrompt(contract, selection), selection);
  }

  async repair(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    session: WorkerSession,
    packet: RepairPacket,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    if (session.id && (!selection || session.logicalAgent === selection.logicalAgent)) {
      const continued = await continueManagedPaseoAgent(
        root,
        session.id,
        buildRepairPrompt(packet),
        config.orchestration?.worker?.timeoutSeconds
      );
      return {
        ...session,
        exitCode: continued.exitCode,
        stdout: continued.stdout || session.stdout,
        stderr: [session.stderr, continued.stderr].filter(Boolean).join("\n"),
        transport: `paseo-${continued.transport}`,
        status: continued.status,
        finishedAt: new Date().toISOString()
      };
    }
    return this.launch(
      root,
      config,
      contract,
      `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`,
      selection
    );
  }

  private async launch(
    root: string,
    config: HarnessProjectConfig,
    contract: TaskContract,
    prompt: string,
    selection?: AgentExecutionSelection
  ): Promise<WorkerSession> {
    const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
      selection,
      phase: "implementation"
    });
    const startedAt = new Date().toISOString();
    const launched = await launchManagedPaseoAgent(root, {
      cwd: spec.cwd,
      title: spec.title,
      provider: spec.provider,
      model: spec.model,
      modeId: spec.modeId,
      modeSource: spec.modeSource,
      thinkingOptionId: spec.thinkingOptionId,
      env: spec.env,
      workspaceId: spec.workspaceId,
      prompt,
      labels: spec.labels,
      timeoutSeconds: spec.timeoutSeconds
    });
    return {
      id: launched.id,
      provider: spec.provider,
      model: spec.model,
      logicalAgent: selection?.logicalAgent,
      nativeAgent: spec.nativeAgentId ?? selection?.nativeAgent,
      runtime: selection?.runtimeName,
      profile: selection?.profile,
      transport: `paseo-${launched.transport}`,
      workspaceId: launched.workspaceId ?? spec.workspaceId,
      title: spec.title,
      operationId: spec.operationId,
      operationKind: spec.operationKind,
      phase: spec.phase,
      status: launched.status,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: launched.exitCode,
      stdout: launched.stdout,
      stderr: launched.stderr
    };
  }
}
