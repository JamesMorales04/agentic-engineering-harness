import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { buildOpenCodeRuntimeConfig } from "../agents/permissions.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { runProcess } from "../utils/process.js";

export async function executeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string): Promise<WorkerSession> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const effectivePrompt = withAgentCharter(selection, prompt);
  if (transport === "paseo") return executeViaPaseo(root, config, contract, selection, effectivePrompt);
  if (transport === "direct") return executeDirect(root, config, selection, effectivePrompt);
  if (transport === "podman") return executePodman(root, config, contract, selection, effectivePrompt);
  throw new Error(`Unsupported agent prompt transport: ${transport}`);
}

async function executeViaPaseo(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string): Promise<WorkerSession> {
  const model = selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId;
  const title = `${config.orchestration?.worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${selection.logicalAgent}`;
  const workspaceId = await deliveryWorkspaceId(root, config, contract.task.id);
  const parts = ["paseo run --background --quiet", `--title ${quote(title)}`, `--provider ${quote(selection.paseoProvider)}`, `--model ${quote(model)}`];
  if (workspaceId) parts.push(`--workspace ${quote(workspaceId)}`);
  parts.push(quote(prompt));
  const launch = await runProcess(parts.join(" "), { cwd: root, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) return session(selection, launch.exitCode, launch.stdout, launch.stderr);
  const id = launch.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!id) return session(selection, 1, launch.stdout, "Paseo returned no agent id.");
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  const wait = await runProcess(`paseo wait ${quote(id)} --timeout ${timeout}`, { cwd: root, timeoutMs: (timeout + 30) * 1000 });
  const logs = await runProcess(`paseo logs ${quote(id)} --tail 200`, { cwd: root, timeoutMs: 60_000 });
  return { ...session(selection, wait.exitCode, logs.stdout || wait.stdout, [wait.stderr, logs.stderr].filter(Boolean).join("\n")), id };
}

async function executeDirect(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, prompt: string): Promise<WorkerSession> {
  let command: string; let env: Record<string, string | undefined> | undefined;
  if (selection.runtimeAdapter === "opencode") {
    const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
    if (selection.variant) args.push("--variant", selection.variant); if (selection.nativeAgent) args.push("--agent", selection.nativeAgent); args.push(...selection.args, prompt);
    command = args.map(quote).join(" "); env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeRuntimeConfig(selection, config)) };
  } else if (selection.runtimeAdapter === "codex") command = ["codex", "exec", "--json", "--model", selection.modelName, ...selection.args, prompt].map(quote).join(" ");
  else throw new Error(`No direct runtime adapter for ${selection.runtimeAdapter}`);
  const result = await runProcess(command, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, env });
  return session(selection, result.exitCode, result.stdout, result.stderr);
}

async function executePodman(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string): Promise<WorkerSession> {
  const image = config.security?.sandbox?.image; if (!image) throw new Error("security.sandbox.image is required for Podman agent execution.");
  if (selection.runtimeAdapter !== "opencode") throw new Error(`Podman prompt execution currently supports OpenCode; selected ${selection.runtimeAdapter}.`);
  const writable = selection.permissions.write === "allow"; const mounts = [`-v ${quote(`${root}:/workspace:${writable ? "rw" : "ro"}`)}`];
  if (writable) for (const relative of sealedArtifacts(config, contract)) mounts.push(`-v ${quote(`${path.resolve(root, relative)}:/workspace/${relative}:ro`)}`);
  const network = config.security?.sandbox?.network === false || selection.permissions.network === "deny" ? "--network none" : "";
  const runtimeConfig = JSON.stringify(buildOpenCodeRuntimeConfig(selection, config));
  const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId]; if (selection.variant) args.push("--variant", selection.variant); if (selection.nativeAgent) args.push("--agent", selection.nativeAgent); args.push(...selection.args, prompt);
  const inner = `cd /workspace && ${args.map(quote).join(" ")}`; const extra = (config.security?.sandbox?.extraArgs ?? []).map(quote).join(" ");
  const command = `podman run --rm -i --userns=keep-id ${network} -e ${quote(`OPENCODE_CONFIG_CONTENT=${runtimeConfig}`)} ${extra} ${mounts.join(" ")} ${quote(image)} sh -lc ${quote(inner)}`;
  const result = await runProcess(command, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 }); return session(selection, result.exitCode, result.stdout, result.stderr);
}
function withAgentCharter(selection: AgentExecutionSelection, prompt: string): string { return selection.description ? `Agent charter for ${selection.logicalAgent}:\n${selection.description}\n\n${prompt}` : prompt; }
function session(selection: AgentExecutionSelection, exitCode: number, stdout: string, stderr: string): WorkerSession { return { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, nativeAgent: selection.nativeAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode, stdout, stderr }; }
function sealedArtifacts(config: HarnessProjectConfig, contract: TaskContract): string[] { const dir = config.sdd?.contractsDir ?? ".harness/contracts"; return [...new Set([`${dir}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value))])]; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
