import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProviderRequest, AgentProviderResult } from "./types.js";
import { LocalAgentProvider } from "./provider.js";
import { executeArgv } from "./provider.js";

export interface CodexProviderOptions {
  command?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  extraArgs?: string[];
}

export interface CodexCapabilities {
  version?: string;
  supportsReasoningFlag: boolean;
  supportsConfigOverride: boolean;
  supportsJson: boolean;
  supportsEphemeral: boolean;
  supportsSkipGitRepoCheck: boolean;
  source: string;
}

/** Bootstrap adapter only. CertificationCore knows nothing about this provider. */
export class CodexAgentProvider extends LocalAgentProvider {
  readonly name = "codex";
  private readonly options: Required<Pick<CodexProviderOptions, "command" | "model" | "reasoningEffort">> & Pick<CodexProviderOptions, "extraArgs">;

  constructor(options: CodexProviderOptions = {}) {
    super();
    this.options = { command: options.command ?? "codex", model: options.model ?? "gpt-5.6-luna", reasoningEffort: options.reasoningEffort ?? "high", extraArgs: options.extraArgs ?? [] };
  }

  override async execute(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const capabilities = await resolveCodexCapabilities(this.options.command, request.cwd);
    if (!capabilities.supportsJson) throw new Error("Codex CLI does not support structured JSONL output required by certification.");
    if (!capabilities.supportsEphemeral || !capabilities.supportsSkipGitRepoCheck) throw new Error("Codex CLI lacks the isolation/bootstrap flags required by the certification adapter.");
    const controlled = await createControlledCodexHome(request.cwd, this.options.model, this.options.reasoningEffort);
    try {
      const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", this.options.model];
      let effectiveReasoning: string | undefined;
      if (capabilities.supportsReasoningFlag) {
        args.push("--reasoning-effort", this.options.reasoningEffort);
        effectiveReasoning = this.options.reasoningEffort;
      } else if (capabilities.supportsConfigOverride) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(this.options.reasoningEffort)}`);
        effectiveReasoning = this.options.reasoningEffort;
      } else {
        throw new Error(`Codex CLI cannot honor requested reasoning effort '${this.options.reasoningEffort}'.`);
      }
      args.push(...(this.options.extraArgs ?? []), ...request.args, request.prompt);
      const result = await super.execute({
        ...request,
        command: this.options.command,
        args,
        environment: { ...(request.environment ?? {}), HOME: controlled.home, CODEX_HOME: controlled.codexHome },
        environmentAllowlist: [...new Set([...(request.environmentAllowlist ?? []), "HOME", "CODEX_HOME"])]
      });
      const sessionId = findSessionId(result.structuredOutput);
      return {
        ...result,
        executionEvidence: {
          started: true,
          provider: this.name,
          command: this.options.command,
          requestedModel: this.options.model,
          effectiveModel: this.options.model,
          requestedReasoningEffort: this.options.reasoningEffort,
          effectiveReasoningEffort: effectiveReasoning,
          capabilitySource: capabilities.source,
          sessionId,
          processExitCode: result.exitCode,
          startedAt: result.events.find((event) => event.type === "started")?.at ?? new Date().toISOString(),
          finishedAt: new Date().toISOString()
        }
      };
    } finally {
      await fs.rm(controlled.home, { recursive: true, force: true });
    }
  }
}

export function codexCommandPreview(options: CodexProviderOptions = {}, request: Pick<AgentProviderRequest, "args" | "prompt">): string[] {
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", options.model ?? "gpt-5.6-luna", "-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort ?? "high")}`, ...(options.extraArgs ?? []), ...request.args, request.prompt];
}

let capabilityCache: Promise<CodexCapabilities> | undefined;

export async function resolveCodexCapabilities(command = "codex", cwd = process.cwd()): Promise<CodexCapabilities> {
  capabilityCache ??= (async () => {
    const result = await executeArgv(command, ["exec", "--help"], { cwd, timeoutMs: 30_000, maxOutputBytes: 512 * 1024, allowNetwork: false });
    if (result.status !== "COMPLETED" || result.exitCode !== 0) throw new Error(`Unable to inspect Codex CLI capabilities: ${result.stderr || result.stdout}`);
    const help = `${result.stdout}\n${result.stderr}`;
    return {
      supportsReasoningFlag: /(?:^|\s)--reasoning-effort(?:\s|$)/m.test(help),
      supportsConfigOverride: /(?:^|\s)-c, --config\s+<key=value>/m.test(help) || /--config\s+<key=value>/m.test(help),
      supportsJson: /--json(?:\s|$)/m.test(help),
      supportsEphemeral: /--ephemeral(?:\s|$)/m.test(help),
      supportsSkipGitRepoCheck: /--skip-git-repo-check/.test(help),
      source: "codex exec --help"
    };
  })();
  return capabilityCache;
}

async function createControlledCodexHome(cwd: string, model: string, reasoningEffort: string): Promise<{ home: string; codexHome: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cert-codex-home-"));
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const hostCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const auth = path.join(hostCodexHome, "auth.json");
  try { await fs.copyFile(auth, path.join(codexHome, "auth.json")); await fs.chmod(path.join(codexHome, "auth.json"), 0o600); } catch { /* provider will report unauthenticated startup */ }
  await fs.writeFile(path.join(codexHome, "config.toml"), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = ${JSON.stringify(reasoningEffort)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(home, ".codex-home-marker"), `cwd=${cwd}\n`, { mode: 0o600 });
  return { home, codexHome };
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const item of value) { const found = findSessionId(item); if (found) return found; } return undefined; }
  const record = value as Record<string, unknown>;
  for (const key of ["thread_id", "threadId", "session_id", "sessionId"]) if (typeof record[key] === "string") return record[key] as string;
  for (const item of Object.values(record)) { const found = findSessionId(item); if (found) return found; }
  return undefined;
}
