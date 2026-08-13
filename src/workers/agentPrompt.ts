import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { outputJsonSchema } from "../agents/outputContracts.js";
import { compileOpenCodeRuntimeProjection } from "../agents/permissions.js";
import { loadFrozenSkillContext } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { currentOperationContext } from "../operations/state.js";
import { compilePaseoAgentLaunchSpec } from "../paseo/launchSpec.js";
import {
  continueManagedPaseoAgent,
  launchManagedPaseoAgent,
  materializeManagedPaseoAgent
} from "../paseo/runtime.js";
import { PaseoSdkUnavailableError } from "../paseo/sdk.js";
import {
  allowedSandboxEnvironment,
  hardenedPodmanArgs,
  sandboxImage
} from "../security/sandbox.js";
import { runProcess } from "../utils/process.js";

export interface AgentPromptOptions {
  outputContract?: string;
  resumeSessionId?: string;
  phase?: string;
  operationKind?: string;
}

export async function executeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  const transport =
    selection.transport === "inherit"
      ? (config.orchestration?.provider ?? "none")
      : selection.transport;
  const effectivePrompt = await buildEffectivePrompt(
    root,
    config,
    contract,
    selection,
    prompt
  );
  if (transport === "paseo") {
    return executeViaPaseo(root, config, contract, selection, effectivePrompt, options);
  }
  if (transport === "direct") {
    return executeDirect(root, config, selection, effectivePrompt, options);
  }
  if (transport === "podman") {
    return executePodman(root, config, contract, selection, effectivePrompt, options);
  }
  throw new Error(`Unsupported agent prompt transport: ${transport}`);
}

export async function materializeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions = {}
): Promise<WorkerSession | undefined> {
  const transport =
    selection.transport === "inherit"
      ? (config.orchestration?.provider ?? "none")
      : selection.transport;
  if (transport !== "paseo" || options.resumeSessionId) return undefined;
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "queued",
    kind: options.operationKind
  });
  const startedAt = new Date().toISOString();
  try {
    const materialized = await materializeManagedPaseoAgent(root, {
      cwd: spec.cwd,
      title: spec.title,
      provider: spec.provider,
      model: spec.model,
      modeId: spec.modeId,
      modeSource: spec.modeSource,
      thinkingOptionId: spec.thinkingOptionId,
      env: spec.env,
      workspaceId: spec.workspaceId,
      labels: spec.labels,
      waitForFinish: false,
      timeoutSeconds: spec.timeoutSeconds
    });
    return session(selection, materialized.exitCode, materialized.stdout, materialized.stderr, {
      id: materialized.id,
      nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
      transport: `paseo-${materialized.transport}`,
      workspaceId: materialized.workspaceId ?? spec.workspaceId,
      title: spec.title,
      operationId: spec.operationId,
      operationKind: spec.operationKind,
      phase: spec.phase,
      status: materialized.status ?? "idle",
      startedAt
    });
  } catch (error) {
    if (
      error instanceof PaseoSdkUnavailableError ||
      (error instanceof Error && error.name === "PaseoSdkUnavailableError")
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function dispatchMaterializedAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  materialized: WorkerSession | undefined,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  if (!materialized?.id) {
    return executeAgentPrompt(root, config, contract, selection, prompt, options);
  }
  const effectivePrompt = await buildEffectivePrompt(
    root,
    config,
    contract,
    selection,
    prompt
  );
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  const continued = await continueManagedPaseoAgent(
    root,
    materialized.id,
    effectivePrompt,
    timeout
  );
  return {
    ...materialized,
    exitCode: continued.exitCode,
    stdout: continued.stdout || materialized.stdout,
    stderr: [materialized.stderr, continued.stderr].filter(Boolean).join("\n"),
    transport: `paseo-${continued.transport}`,
    workspaceId: continued.workspaceId ?? materialized.workspaceId,
    status: continued.status,
    phase: options.phase ?? materialized.phase,
    finishedAt: new Date().toISOString()
  };
}

export async function resumeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  previous: WorkerSession,
  prompt: string,
  options: Omit<AgentPromptOptions, "resumeSessionId"> = {}
): Promise<WorkerSession> {
  if (!previous.id) {
    return executeAgentPrompt(root, config, contract, selection, prompt, options);
  }
  return executeAgentPrompt(root, config, contract, selection, prompt, {
    ...options,
    resumeSessionId: previous.id
  });
}

async function executeViaPaseo(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<WorkerSession> {
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "work",
    kind: options.operationKind
  });
  const startedAt = new Date().toISOString();
  if (options.resumeSessionId) {
    const continued = await continueManagedPaseoAgent(
      root,
      options.resumeSessionId,
      prompt,
      spec.timeoutSeconds
    );
    return session(selection, continued.exitCode, continued.stdout, continued.stderr, {
      id: options.resumeSessionId,
      nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
      transport: `paseo-${continued.transport}`,
      workspaceId: continued.workspaceId ?? spec.workspaceId,
      title: spec.title,
      operationId: spec.operationId,
      operationKind: spec.operationKind,
      phase: spec.phase,
      status: continued.status,
      startedAt,
      finishedAt: new Date().toISOString()
    });
  }
  const schema = options.outputContract
    ? outputJsonSchema(options.outputContract)
    : undefined;
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
    outputSchema: schema,
    labels: spec.labels,
    timeoutSeconds: spec.timeoutSeconds
  });
  return session(selection, launched.exitCode, launched.stdout, launched.stderr, {
    id: launched.id,
    nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
    transport: `paseo-${launched.transport}`,
    workspaceId: launched.workspaceId ?? spec.workspaceId,
    title: spec.title,
    operationId: spec.operationId,
    operationKind: spec.operationKind,
    phase: spec.phase,
    status: launched.status,
    startedAt,
    finishedAt: new Date().toISOString()
  });
}

async function executeDirect(
  root: string,
  config: HarnessProjectConfig,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<WorkerSession> {
  const startedAt = new Date().toISOString();
  if (selection.runtimeAdapter === "opencode") {
    const projection = compileOpenCodeRuntimeProjection(selection, config);
    const args = [
      "opencode",
      "run",
      "--auto",
      "--format",
      "json",
      "--model",
      selection.modelId
    ];
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    if (selection.variant) args.push("--variant", selection.variant);
    args.push("--agent", projection.binding.agentId);
    args.push(...selection.args, prompt);
    const result = await runProcess(args.map(quote).join(" "), {
      cwd: root,
      timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000,
      env: projection.env
    });
    return session(selection, result.exitCode, result.stdout, result.stderr, {
      id: options.resumeSessionId ?? extractSessionId(result.stdout),
      nativeAgent: projection.binding.agentId,
      ...directMetadata(options, startedAt)
    });
  }
  if (selection.runtimeAdapter === "codex") {
    return executeCodex(root, config, selection, prompt, options, startedAt);
  }
  throw new Error(`No direct runtime adapter for ${selection.runtimeAdapter}`);
}

async function executeCodex(
  root: string,
  config: HarnessProjectConfig,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions,
  startedAt: string
): Promise<WorkerSession> {
  const schema = options.outputContract
    ? outputJsonSchema(options.outputContract)
    : undefined;
  const temp = schema
    ? await fs.mkdtemp(path.join(os.tmpdir(), "aeh-codex-schema-"))
    : undefined;
  try {
    const schemaFile = temp ? path.join(temp, "schema.json") : undefined;
    const outputFile = temp ? path.join(temp, "output.json") : undefined;
    if (schemaFile) {
      await fs.writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
    }
    const args = options.resumeSessionId
      ? [
          "codex",
          "exec",
          "resume",
          options.resumeSessionId,
          "--json",
          "--model",
          selection.modelName
        ]
      : ["codex", "exec", "--json", "--model", selection.modelName];
    if (schemaFile && outputFile) {
      args.push("--output-schema", schemaFile, "-o", outputFile);
    }
    args.push(...selection.args, prompt);
    const result = await runProcess(args.map(quote).join(" "), {
      cwd: root,
      timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000
    });
    let stdout = result.stdout;
    if (outputFile) {
      try {
        stdout = await fs.readFile(outputFile, "utf8");
      } catch {
        // event stream remains diagnostic fallback
      }
    }
    const id = options.resumeSessionId ?? extractSessionId(result.stdout);
    return session(selection, result.exitCode, stdout, [
      result.stderr,
      outputFile ? `CODEX_EVENT_STREAM:\n${result.stdout}` : ""
    ].filter(Boolean).join("\n"), {
      id,
      ...directMetadata(options, startedAt)
    });
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

async function executePodman(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<WorkerSession> {
  if (selection.runtimeAdapter !== "opencode") {
    throw new Error(
      `Podman prompt execution currently supports OpenCode; selected ${selection.runtimeAdapter}.`
    );
  }
  if (options.resumeSessionId) {
    throw new Error(
      "Ephemeral hardened Podman sessions cannot resume a host agent session without an explicit persisted session volume."
    );
  }
  const startedAt = new Date().toISOString();
  const writable = selection.permissions.write === "allow";
  const args: string[] = [
    "podman",
    "run",
    ...hardenedPodmanArgs(config, selection, writable)
  ];
  args.push("-v", `${root}:/workspace:${writable ? "rw" : "ro"}`);
  if (writable) {
    for (const relative of sealedArtifacts(config, contract)) {
      args.push("-v", `${path.resolve(root, relative)}:/workspace/${relative}:ro`);
    }
  }
  const projection = compileOpenCodeRuntimeProjection(selection, config);
  args.push("-e", `OPENCODE_CONFIG_CONTENT=${projection.env.OPENCODE_CONFIG_CONTENT}`);
  for (const [name, value] of Object.entries(allowedSandboxEnvironment(config))) {
    args.push("-e", `${name}=${value}`);
  }
  args.push(sandboxImage(config), "sh", "-lc");
  const runtimeArgs = [
    "opencode",
    "run",
    "--auto",
    "--format",
    "json",
    "--model",
    selection.modelId
  ];
  if (selection.variant) runtimeArgs.push("--variant", selection.variant);
  runtimeArgs.push("--agent", projection.binding.agentId);
  runtimeArgs.push(...selection.args, prompt);
  args.push(`cd /workspace && ${runtimeArgs.map(quote).join(" ")}`);
  const result = await runProcess(args.map(quote).join(" "), {
    cwd: root,
    timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000
  });
  return session(selection, result.exitCode, result.stdout, result.stderr, {
    nativeAgent: projection.binding.agentId,
    ...directMetadata(options, startedAt, "podman")
  });
}

async function buildEffectivePrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string
): Promise<string> {
  const frozenSkills = await loadFrozenSkillContext(
    root,
    config,
    contract.task.id,
    selection.skills ?? []
  );
  return withAgentCharter(selection, prompt, frozenSkills);
}

function directMetadata(
  options: AgentPromptOptions,
  startedAt: string,
  transport = "direct"
): Partial<WorkerSession> {
  const operation = currentOperationContext();
  return {
    transport,
    operationId: operation.id,
    operationKind: operation.kind ?? options.operationKind,
    phase: options.phase ?? "work",
    status: "finished",
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function session(
  selection: AgentExecutionSelection,
  exitCode: number,
  stdout: string,
  stderr: string,
  metadata: Partial<WorkerSession> = {}
): WorkerSession {
  return {
    provider: selection.runtimeAdapter,
    model: selection.modelName,
    logicalAgent: selection.logicalAgent,
    nativeAgent: selection.nativeAgent,
    runtime: selection.runtimeName,
    profile: selection.profile,
    exitCode,
    stdout,
    stderr,
    ...metadata
  };
}

function withAgentCharter(
  selection: AgentExecutionSelection,
  prompt: string,
  frozenSkills?: string
): string {
  const sections = [
    selection.description
      ? `Agent charter for ${selection.logicalAgent}:\n${selection.description}`
      : undefined,
    frozenSkills
      ? `Frozen control-plane skill context (authoritative for this run):\n${frozenSkills}`
      : undefined,
    prompt
  ].filter(Boolean);
  return sections.join("\n\n");
}

function sealedArtifacts(
  config: HarnessProjectConfig,
  contract: TaskContract
): string[] {
  const dir = config.sdd?.contractsDir ?? ".harness/contracts";
  return [
    ...new Set([
      `${dir}/${contract.task.id}.yaml`,
      `.harness/seals/${contract.task.id}.json`,
      ...Object.values(contract.source ?? {}).filter(
        (value): value is string => Boolean(value)
      )
    ])
  ];
}

function extractSessionId(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const found = findSessionId(value);
    if (found) return found;
  }
  return undefined;
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of [
    "thread_id",
    "session_id",
    "sessionID",
    "sessionId",
    "threadId"
  ]) {
    if (typeof object[key] === "string") return object[key] as string;
  }
  const kind = String(object.type ?? object.event ?? "").toLowerCase();
  if (
    (kind.includes("thread") || kind.includes("session")) &&
    typeof object.id === "string"
  ) {
    return object.id;
  }
  for (const child of Object.values(object)) {
    const found = findSessionId(child);
    if (found) return found;
  }
  return undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
