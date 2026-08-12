import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { outputJsonSchema } from "../agents/outputContracts.js";
import { buildOpenCodeRuntimeConfig } from "../agents/permissions.js";
import { loadFrozenSkillContext } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { continueManagedPaseoAgent, launchManagedPaseoAgent } from "../paseo/runtime.js";
import { allowedSandboxEnvironment, hardenedPodmanArgs, sandboxImage } from "../security/sandbox.js";
import { runProcess } from "../utils/process.js";

export interface AgentPromptOptions { outputContract?: string; resumeSessionId?: string; }

export async function executeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions = {}): Promise<WorkerSession> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const frozenSkills = await loadFrozenSkillContext(root, config, contract.task.id, selection.skills ?? []);
  const effectivePrompt = withAgentCharter(selection, prompt, frozenSkills);
  if (transport === "paseo") return executeViaPaseo(root, config, contract, selection, effectivePrompt, options);
  if (transport === "direct") return executeDirect(root, config, selection, effectivePrompt, options);
  if (transport === "podman") return executePodman(root, config, contract, selection, effectivePrompt, options);
  throw new Error(`Unsupported agent prompt transport: ${transport}`);
}

export async function resumeAgentPrompt(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, previous: WorkerSession, prompt: string, options: Omit<AgentPromptOptions, "resumeSessionId"> = {}): Promise<WorkerSession> {
  if (!previous.id) return executeAgentPrompt(root, config, contract, selection, prompt, options);
  return executeAgentPrompt(root, config, contract, selection, prompt, { ...options, resumeSessionId: previous.id });
}

async function executeViaPaseo(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  if (options.resumeSessionId) {
    const continued = await continueManagedPaseoAgent(root, options.resumeSessionId, prompt, timeout);
    return { ...session(selection, continued.exitCode, continued.stdout, continued.stderr), id: options.resumeSessionId };
  }
  const model = selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId;
  const title = `${config.orchestration?.worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${selection.logicalAgent}`;
  const workspaceId = await deliveryWorkspaceId(root, config, contract.task.id);
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  const labels: Record<string, string> = {
    "aeh.project": config.project.name,
    "aeh.kind": "worker",
    "aeh.task": contract.task.id,
    "aeh.role": selection.logicalAgent
  };
  if (selection.profile) labels["aeh.profile"] = selection.profile;
  const launched = await launchManagedPaseoAgent(root, {
    cwd: root,
    title,
    provider: selection.paseoProvider,
    model,
    workspaceId,
    prompt,
    outputSchema: schema,
    labels,
    timeoutSeconds: timeout
  });
  return { ...session(selection, launched.exitCode, launched.stdout, launched.stderr), id: launched.id };
}

async function executeDirect(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  if (selection.runtimeAdapter === "opencode") {
    const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId]; if (options.resumeSessionId) args.push("--session", options.resumeSessionId); if (selection.variant) args.push("--variant", selection.variant); if (selection.nativeAgent) args.push("--agent", selection.nativeAgent); args.push(...selection.args, prompt);
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeRuntimeConfig(selection, config)) }; const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, env }); return { ...session(selection, result.exitCode, result.stdout, result.stderr), id: options.resumeSessionId ?? extractSessionId(result.stdout) };
  }
  if (selection.runtimeAdapter === "codex") return executeCodex(root, config, selection, prompt, options);
  throw new Error(`No direct runtime adapter for ${selection.runtimeAdapter}`);
}

async function executeCodex(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined; const temp = schema ? await fs.mkdtemp(path.join(os.tmpdir(), "aeh-codex-schema-")) : undefined;
  try {
    const schemaFile = temp ? path.join(temp, "schema.json") : undefined; const outputFile = temp ? path.join(temp, "output.json") : undefined; if (schemaFile) await fs.writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
    const args = options.resumeSessionId ? ["codex", "exec", "resume", options.resumeSessionId, "--json", "--model", selection.modelName] : ["codex", "exec", "--json", "--model", selection.modelName]; if (schemaFile && outputFile) args.push("--output-schema", schemaFile, "-o", outputFile); args.push(...selection.args, prompt);
    const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 }); let stdout = result.stdout; if (outputFile) { try { stdout = await fs.readFile(outputFile, "utf8"); } catch { /* event stream remains diagnostic fallback */ } } const id = options.resumeSessionId ?? extractSessionId(result.stdout); return { ...session(selection, result.exitCode, stdout, [result.stderr, outputFile ? `CODEX_EVENT_STREAM:\n${result.stdout}` : ""].filter(Boolean).join("\n")), id };
  } finally { if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}

async function executePodman(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  if (selection.runtimeAdapter !== "opencode") throw new Error(`Podman prompt execution currently supports OpenCode; selected ${selection.runtimeAdapter}.`); if (options.resumeSessionId) throw new Error("Ephemeral hardened Podman sessions cannot resume a host agent session without an explicit persisted session volume.");
  const writable = selection.permissions.write === "allow"; const args: string[] = ["podman", "run", ...hardenedPodmanArgs(config, selection, writable)]; args.push("-v", `${root}:/workspace:${writable ? "rw" : "ro"}`); if (writable) for (const relative of sealedArtifacts(config, contract)) args.push("-v", `${path.resolve(root, relative)}:/workspace/${relative}:ro`); const runtimeConfig = JSON.stringify(buildOpenCodeRuntimeConfig(selection, config)); args.push("-e", `OPENCODE_CONFIG_CONTENT=${runtimeConfig}`); for (const [name, value] of Object.entries(allowedSandboxEnvironment(config))) args.push("-e", `${name}=${value}`); args.push(sandboxImage(config), "sh", "-lc"); const runtimeArgs = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId]; if (selection.variant) runtimeArgs.push("--variant", selection.variant); if (selection.nativeAgent) runtimeArgs.push("--agent", selection.nativeAgent); runtimeArgs.push(...selection.args, prompt); args.push(`cd /workspace && ${runtimeArgs.map(quote).join(" ")}`); const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 }); return { ...session(selection, result.exitCode, result.stdout, result.stderr), id: extractSessionId(result.stdout) };
}
function withAgentCharter(selection: AgentExecutionSelection, prompt: string, frozenSkills?: string): string { const sections = [selection.description ? `Agent charter for ${selection.logicalAgent}:\n${selection.description}` : undefined, frozenSkills ? `Frozen control-plane skill context (authoritative for this run):\n${frozenSkills}` : undefined, prompt].filter(Boolean); return sections.join("\n\n"); }
function session(selection: AgentExecutionSelection, exitCode: number, stdout: string, stderr: string): WorkerSession { return { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, nativeAgent: selection.nativeAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode, stdout, stderr }; }
function sealedArtifacts(config: HarnessProjectConfig, contract: TaskContract): string[] { const dir = config.sdd?.contractsDir ?? ".harness/contracts"; return [...new Set([`${dir}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value))])]; }
function extractSessionId(text: string): string | undefined { for (const line of text.split(/\r?\n/)) { let value: unknown; try { value = JSON.parse(line); } catch { continue; } const found = findSessionId(value); if (found) return found; } return undefined; }
function findSessionId(value: unknown): string | undefined { if (!value || typeof value !== "object") return undefined; if (Array.isArray(value)) { for (const item of value) { const found = findSessionId(item); if (found) return found; } return undefined; } const object = value as Record<string, unknown>; for (const key of ["thread_id", "session_id", "sessionID", "sessionId", "threadId"]) if (typeof object[key] === "string") return object[key] as string; const kind = String(object.type ?? object.event ?? "").toLowerCase(); if ((kind.includes("thread") || kind.includes("session")) && typeof object.id === "string") return object.id; for (const child of Object.values(object)) { const found = findSessionId(child); if (found) return found; } return undefined; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
