import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { buildOpenCodeRuntimeConfig } from "../agents/permissions.js";
import type { HarnessProjectConfig, RepairPacket, TaskContract, WorkerSession } from "../core/types.js";
import { allowedSandboxEnvironment, hardenedPodmanArgs, sandboxImage } from "../security/sandbox.js";
import { commandExists, runProcess } from "../utils/process.js";
import { buildRepairPrompt, buildWorkerPrompt } from "./prompt.js";
import type { WorkerExecutor } from "./types.js";

export class PodmanWorkerExecutor implements WorkerExecutor {
  readonly name = "podman";
  async doctor(root: string, config: HarnessProjectConfig): Promise<{ ok: boolean; message: string }> { const ok = await commandExists("podman", root); if (!ok) return { ok: false, message: "Podman CLI not found." }; if (!config.security?.sandbox?.image) return { ok: false, message: "security.sandbox.image is required for Podman worker execution." }; return { ok: true, message: "Hardened Podman worker sandbox configured." }; }
  async start(root: string, config: HarnessProjectConfig, contract: TaskContract, selection?: AgentExecutionSelection): Promise<WorkerSession> { return this.run(root, config, contract, buildWorkerPrompt(contract, selection), selection); }
  async repair(root: string, config: HarnessProjectConfig, contract: TaskContract, _session: WorkerSession, packet: RepairPacket, selection?: AgentExecutionSelection): Promise<WorkerSession> { return this.run(root, config, contract, `${buildWorkerPrompt(contract, selection)}\n\n${buildRepairPrompt(packet)}`, selection); }
  private async run(root: string, config: HarnessProjectConfig, contract: TaskContract, prompt: string, selection?: AgentExecutionSelection): Promise<WorkerSession> {
    const runtime = selection?.runtimeAdapter ?? "opencode"; if (runtime !== "opencode") throw new Error(`Podman executor currently supports OpenCode runtime; selected ${runtime}.`);
    const model = selection?.modelId ?? config.orchestration?.worker?.model; const fallback = selection ?? legacySelection(model); const podmanArgs = hardenedPodmanArgs(config, fallback, true); const args = ["podman", "run", ...podmanArgs, "-v", `${root}:/workspace:rw`];
    for (const relative of sealedArtifacts(config, contract)) args.push("-v", `${path.resolve(root, relative)}:/workspace/${relative}:ro`);
    if (selection) args.push("-e", `OPENCODE_CONFIG_CONTENT=${JSON.stringify(buildOpenCodeRuntimeConfig(selection, config))}`);
    for (const [name, value] of Object.entries(allowedSandboxEnvironment(config))) args.push("-e", `${name}=${value}`);
    const runtimeArgs = ["opencode", "run", "--auto", "--format", "json"]; if (model) runtimeArgs.push("--model", model); if (selection?.variant) runtimeArgs.push("--variant", selection.variant); if (selection?.nativeAgent) runtimeArgs.push("--agent", selection.nativeAgent); runtimeArgs.push(...(selection?.args ?? []), prompt);
    args.push(sandboxImage(config), "sh", "-lc", `cd /workspace && ${runtimeArgs.map(quote).join(" ")}`);
    const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800; const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: timeout * 1000 }); return { provider: runtime, model: selection?.modelName ?? model, logicalAgent: selection?.logicalAgent, nativeAgent: selection?.nativeAgent, runtime: selection?.runtimeName, profile: selection?.profile, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
}
function legacySelection(model?: string): AgentExecutionSelection { return { logicalAgent: "legacy-worker", role: "implementer", profile: "legacy", runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "legacy", provider: model?.split("/")[0] ?? "opencode", modelName: model?.split("/").at(-1) ?? "default", modelId: model ?? "opencode/default", transport: "podman", permissions: { read: "allow", write: "allow", shell: "allow", network: "ask", delegate: "deny", review: "deny", validate: "allow", gitWrite: "deny" }, skills: [], mcps: [], args: [] }; }
function sealedArtifacts(config: HarnessProjectConfig, contract: TaskContract): string[] { const contractsDir = config.sdd?.contractsDir ?? ".harness/contracts"; return [...new Set([`${contractsDir}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value))])]; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
