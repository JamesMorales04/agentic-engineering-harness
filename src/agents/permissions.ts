import { createHash } from "node:crypto";
import type { HarnessProjectConfig, McpServerConfig } from "../core/types.js";
import type { AgentExecutionSelection, PermissionDecision } from "./types.js";

export type OpenCodeAgentBindingSource = "aeh-managed" | "explicit";

export interface OpenCodeAgentBinding {
  agentId: string;
  source: OpenCodeAgentBindingSource;
  managed: boolean;
}

export interface OpenCodeRuntimeProjection {
  binding: OpenCodeAgentBinding;
  config: Record<string, unknown>;
  env: Record<string, string>;
}

export function validateExecutionCapabilities(
  selection: AgentExecutionSelection,
  transport: string
): string[] {
  const issues: string[] = [];
  if (selection.nativeAgent && selection.runtimeCapabilities.nativeAgent === false) {
    issues.push(
      `Runtime ${selection.runtimeName} cannot select native agent ${selection.nativeAgent}.`
    );
  }
  const nativeAgentViaPaseo =
    selection.runtimeCapabilities.nativeAgentViaPaseo === true ||
    (selection.runtimeAdapter === "opencode" && selection.paseoProvider === "opencode");
  if (selection.nativeAgent && transport === "paseo" && !nativeAgentViaPaseo) {
    issues.push(
      `Agent ${selection.logicalAgent} requires nativeAgent=${selection.nativeAgent}, but runtime ${selection.runtimeName} does not support that native agent through Paseo.`
    );
  }
  if (selection.variant && selection.runtimeCapabilities.variantSelection === false) {
    issues.push(`Runtime ${selection.runtimeName} cannot select variant ${selection.variant}.`);
  }
  if (selection.role === "implementer" && selection.permissions.write === "deny") {
    issues.push(`Implementer ${selection.logicalAgent} denies write permission.`);
  }
  if (
    (selection.role === "reviewer" || selection.role === "validator") &&
    selection.permissions.write === "allow"
  ) {
    issues.push(
      `${selection.role} ${selection.logicalAgent} explicitly allows writes; read-only roles should use write=deny unless intentionally mutating.`
    );
  }
  if (selection.role === "orchestrator" && selection.permissions.delegate === "deny") {
    issues.push(`Orchestrator ${selection.logicalAgent} denies delegation.`);
  }
  return issues;
}

export function permissionSummary(selection: AgentExecutionSelection): string {
  return (
    Object.entries(selection.permissions)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ") || "unspecified"
  );
}

/**
 * Resolve the concrete OpenCode execution identity for an AEH logical agent.
 *
 * Explicit nativeAgent is an externally-authored OpenCode primary/all agent and
 * is preserved exactly. Otherwise AEH owns the native identity and injects a
 * primary agent with a deterministic collision-resistant name into the
 * session-local OpenCode config.
 */
export function resolveOpenCodeAgentBinding(
  selection: AgentExecutionSelection
): OpenCodeAgentBinding {
  const explicit = selection.nativeAgent?.trim();
  if (explicit) {
    return { agentId: explicit, source: "explicit", managed: false };
  }
  return {
    agentId: managedOpenCodeAgentId(selection.logicalAgent),
    source: "aeh-managed",
    managed: true
  };
}

/**
 * Compile the inline OpenCode configuration used by direct, Podman and Paseo
 * transports. OPENCODE_CONFIG_CONTENT is loaded after ordinary user/project
 * config, so the AEH-managed identity and policy are deterministic without
 * mutating the user's global OpenCode configuration.
 */
export function buildOpenCodeRuntimeConfig(
  selection: AgentExecutionSelection,
  config?: HarnessProjectConfig,
  binding: OpenCodeAgentBinding = resolveOpenCodeAgentBinding(selection)
): Record<string, unknown> {
  const permission = buildOpenCodePermission(selection);
  const mcp: Record<string, unknown> = {};
  const tools: Record<string, boolean> = {};
  const configured = config?.mcp?.servers ?? {};

  for (const [name, server] of Object.entries(configured)) {
    const selected = selection.mcps.includes(name) && server.enabled !== false;
    tools[`${name}_*`] = selected;
    if (selected) mcp[name] = toOpenCodeMcp(server);
  }
  for (const name of selection.mcps) {
    if (!configured[name]) tools[`${name}_*`] = true;
  }
  const semanticRequired = config?.context?.semanticRetrieval?.provider !== "none" && config?.context?.semanticRetrieval?.required === true && selection.role !== "orchestrator" && selection.logicalAgent !== "operation-supervisor";
  if (semanticRequired && !mcp.serena) {
    mcp.serena = { type: "local", command: ["serena", "start-mcp-server", "--context", "ide-assistant", "--project", "."], enabled: true, timeout: 30_000 };
    tools["serena_*"] = true;
  }
  const compressionRequired = config?.context?.compression?.provider !== "none" && config?.context?.compression?.required === true && selection.role !== "orchestrator" && selection.logicalAgent !== "operation-supervisor";
  if (compressionRequired && !mcp.headroom) {
    mcp.headroom = { type: "local", command: [config?.context?.compression?.command ?? "headroom", "mcp", "serve"], enabled: true };
    tools["headroom_*"] = true;
  }

  const managedAgent = binding.managed
    ? {
        agent: {
          [binding.agentId]: {
            mode: "primary",
            description:
              selection.description ??
              `AEH-managed OpenCode execution identity for ${selection.logicalAgent}.`,
            model: selection.modelId,
            prompt: `AEH execution identity: ${selection.logicalAgent}. Follow the task-scoped AEH charter, frozen control-plane context, permissions and acceptance criteria supplied with each turn.`,
            ...(selection.variant ? { variant: selection.variant } : {}),
            ...(selection.temperature !== undefined
              ? { temperature: selection.temperature }
              : {}),
            ...(Object.keys(permission).length ? { permission } : {})
          }
        },
        default_agent: binding.agentId
      }
    : {};

  return {
    $schema: "https://opencode.ai/config.json",
    permission,
    ...managedAgent,
    ...(Object.keys(mcp).length ? { mcp } : {}),
    ...(Object.keys(tools).length ? { tools } : {})
  };
}

export function compileOpenCodeRuntimeProjection(
  selection: AgentExecutionSelection,
  config?: HarnessProjectConfig
): OpenCodeRuntimeProjection {
  const binding = resolveOpenCodeAgentBinding(selection);
  const runtimeConfig = buildOpenCodeRuntimeConfig(selection, config, binding);
  return {
    binding,
    config: runtimeConfig,
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig)
    }
  };
}

function buildOpenCodePermission(
  selection: AgentExecutionSelection
): Record<string, unknown> {
  const permission: Record<string, unknown> = {};
  const p = selection.permissions;
  if (p.read) permission.read = p.read;
  if (p.write) permission.edit = p.write;
  if (p.network) {
    permission.webfetch = p.network;
    permission.websearch = p.network;
  }
  if (p.delegate) permission.task = p.delegate;
  const bash = buildBashPermission(p.shell, p.gitWrite);
  if (bash) permission.bash = bash;
  if (selection.skills.length && !selection.skills.includes("*")) {
    permission.skill = Object.fromEntries([
      ["*", "deny"],
      ...selection.skills.map((skill) => [skill, "allow"])
    ]);
  }
  return permission;
}

function managedOpenCodeAgentId(logicalAgent: string): string {
  const original = logicalAgent.trim();
  if (!original) throw new Error("AEH logical agent name is required for OpenCode identity.");
  const slug =
    original
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const normalizedOriginal = original.toLowerCase();
  if (slug === normalizedOriginal) return `aeh-${slug}`;
  const digest = createHash("sha256").update(original).digest("hex").slice(0, 8);
  return `aeh-${slug}-${digest}`;
}

function toOpenCodeMcp(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "local") {
    return {
      type: "local",
      command: server.command,
      enabled: true,
      ...(server.environment ? { environment: server.environment } : {}),
      ...(server.timeoutMs ? { timeout: server.timeoutMs } : {})
    };
  }
  return {
    type: "remote",
    url: server.url,
    enabled: true,
    ...(server.headers ? { headers: server.headers } : {}),
    ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
    ...(server.timeoutMs ? { timeout: server.timeoutMs } : {})
  };
}

function buildBashPermission(
  shell?: PermissionDecision,
  gitWrite?: PermissionDecision
): PermissionDecision | Record<string, PermissionDecision> | undefined {
  if (!gitWrite) return shell;
  const result: Record<string, PermissionDecision> = { "*": shell ?? "ask" };
  for (const pattern of [
    "git add *",
    "git commit *",
    "git push *",
    "git tag *",
    "git checkout *",
    "git switch *",
    "git reset *",
    "git clean *",
    "git restore *",
    "git merge *",
    "git rebase *",
    "git cherry-pick *"
  ]) {
    result[pattern] = gitWrite;
  }
  return result;
}
