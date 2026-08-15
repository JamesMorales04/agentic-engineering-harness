import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface EffectiveContextCapabilities {
  contextGateway: boolean;
  repositoryMap: boolean;
  semanticRetrieval: boolean;
  authorizedRetrieval: boolean;
  mcpServers: { serena: boolean; context: boolean; headroom: boolean };
  readinessRequirements: string[];
  reasons: string[];
}

export interface TransportProbe {
  commandExists?: (command: string, cwd: string) => Promise<boolean>;
  run?: typeof runProcess;
}

export interface PodmanSerenaProbe {
  available: boolean;
  imagePresent: boolean;
  exposesSerena: boolean;
  message: string;
}

/** Resolve effective capabilities without touching external runtimes. */
export function staticContextCapabilities(config: HarnessProjectConfig, selection: AgentExecutionSelection): EffectiveContextCapabilities {
  const transport = effectiveTransport(config, selection);
  const semanticConfigured = Boolean(config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none");
  const agentCanUseContext = selection.role !== "orchestrator" && selection.logicalAgent !== "operation-supervisor";
  const opencodeSurface = selection.runtimeAdapter === "opencode" && agentCanUseContext;
  const directOrPaseo = transport === "direct" || transport === "paseo" || (selection.transport === "inherit" && transport === "none");
  const semanticRetrieval = semanticConfigured && opencodeSurface && directOrPaseo;
  const authorizedRetrieval = Boolean(config.context) && agentCanUseContext && opencodeSurface && transport !== "podman" && directOrPaseo;
  const mcpServers = { serena: semanticRetrieval, context: authorizedRetrieval, headroom: false };
  const reasons: string[] = [];
  const readinessRequirements: string[] = [];
  if (!semanticConfigured) reasons.push("semantic retrieval is disabled by project configuration");
  if (transport === "podman") {
    reasons.push("Podman has no AEH-managed Serena MCP projection; host or image binaries do not prove an executable semantic surface");
    readinessRequirements.push("Podman semantic retrieval requires an explicitly wired in-container MCP server");
  } else if (!semanticRetrieval && semanticConfigured) {
    reasons.push(`transport '${transport}' and runtime '${selection.runtimeAdapter}' do not expose Serena MCP`);
  }
  if (!authorizedRetrieval && config.context && transport === "podman") reasons.push("Podman does not expose the host AEH raw-retrieval MCP");
  if (semanticRetrieval) readinessRequirements.push("Serena MCP initialize/tools/list readiness");
  if (authorizedRetrieval) readinessRequirements.push("AEH context MCP authorization and source-hash verification");
  return { contextGateway: true, repositoryMap: true, semanticRetrieval, authorizedRetrieval, mcpServers, readinessRequirements, reasons };
}

export async function resolveContextTransportCapabilities(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, probe: TransportProbe & { mode?: "static" | "live" } = {}): Promise<EffectiveContextCapabilities> {
  const capabilities = staticContextCapabilities(config, selection);
  const semanticConfigured = Boolean(config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none");
  if (probe.mode === "live" && effectiveTransport(config, selection) === "podman" && config.security?.sandbox?.image) {
    const live = await probePodmanSerena(root, config.security.sandbox.image, probe);
    capabilities.reasons.push(`live Podman probe: ${live.message}`);
    if (!live.available || !live.imagePresent || !live.exposesSerena) capabilities.readinessRequirements.push("pre-provisioned Podman image with Serena executable");
  }
  if (semanticConfigured && config.context?.semanticRetrieval?.required !== false && !capabilities.semanticRetrieval) {
    throw new Error(`UNSUPPORTED_CAPABILITY: Serena semantic retrieval is unavailable for transport '${effectiveTransport(config, selection)}' and runtime '${selection.runtimeAdapter}'. ${capabilities.reasons.join("; ")}`);
  }
  return capabilities;
}

/** Bounded, no-pull diagnostic for an explicitly provisioned Podman image. */
export async function probePodmanSerena(root: string, image: string, probe: TransportProbe = {}): Promise<PodmanSerenaProbe> {
  const executable = probe.commandExists ?? commandExists;
  const runner = probe.run ?? runProcess;
  if (!(await executable("podman", root))) return { available: false, imagePresent: false, exposesSerena: false, message: "Podman executable is unavailable" };
  const imageCheck = await runner(`podman image exists ${quote(image)}`, { cwd: root, timeoutMs: 10_000 });
  if (imageCheck.exitCode !== 0) return { available: true, imagePresent: false, exposesSerena: false, message: "configured Podman image is not already present; no pull was attempted" };
  const result = await runner(`podman run --pull=never --network=none --rm ${quote(image)} sh -lc 'command -v serena'`, { cwd: root, timeoutMs: 30_000 });
  return result.exitCode === 0 && Boolean(result.stdout.trim())
    ? { available: true, imagePresent: true, exposesSerena: true, message: "configured Podman image exposes a Serena executable but not an AEH MCP projection" }
    : { available: true, imagePresent: true, exposesSerena: false, message: "configured Podman image does not expose Serena" };
}

function effectiveTransport(config: HarnessProjectConfig, selection: AgentExecutionSelection): string {
  return selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
