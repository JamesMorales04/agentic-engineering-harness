import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface ContextTransportCapabilities {
  contextGateway: boolean;
  repositoryMap: boolean;
  semanticRetrieval: boolean;
  authorizedRetrieval: boolean;
  reasons: string[];
}

export interface TransportProbe {
  commandExists?: (command: string, cwd: string) => Promise<boolean>;
  run?: typeof runProcess;
}

/**
 * Resolve what the selected runtime can actually invoke. Host-side provider
 * health is deliberately not treated as container or MCP readiness.
 */
export async function resolveContextTransportCapabilities(
  root: string,
  config: HarnessProjectConfig,
  selection: AgentExecutionSelection,
  probe: TransportProbe = {}
): Promise<ContextTransportCapabilities> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const semanticConfigured = Boolean(config.context && config.context.semanticRetrieval?.provider !== "none");
  const reasons: string[] = [];
  let semanticRetrieval = false;
  let authorizedRetrieval = false;

  if (!semanticConfigured) {
    reasons.push("semantic retrieval is disabled by project configuration");
  } else if (transport === "paseo") {
    semanticRetrieval = true;
    authorizedRetrieval = true;
  } else if (transport === "direct" && selection.runtimeAdapter === "opencode") {
    semanticRetrieval = true;
    authorizedRetrieval = true;
  } else if (transport === "podman" && selection.runtimeAdapter === "opencode") {
    const image = config.security?.sandbox?.image;
    const executable = probe.commandExists ?? commandExists;
    const runner = probe.run ?? runProcess;
    if (!image) {
      reasons.push("Podman semantic retrieval requires an explicit sandbox image");
    } else if (!(await executable("podman", root))) {
      reasons.push("Podman executable is unavailable; host Serena does not prove container readiness");
    } else {
      const result = await runner(`podman run --rm ${quote(image)} sh -lc 'command -v serena'`, { cwd: root, timeoutMs: 60_000 });
      if (result.exitCode === 0 && result.stdout.trim()) semanticRetrieval = true;
      else reasons.push("configured Podman image does not expose Serena");
    }
    // The raw AEH retrieval MCP is host-local and is not mounted into the
    // hardened container by design.
    reasons.push("Podman does not expose the host AEH raw-retrieval MCP");
  } else {
    reasons.push(`transport '${transport}' cannot expose Serena through the selected runtime`);
  }

  if (semanticConfigured && !semanticRetrieval && config.context?.semanticRetrieval?.required !== false) {
    throw new Error(`UNSUPPORTED_CAPABILITY: Serena semantic retrieval is unavailable for transport '${transport}' and runtime '${selection.runtimeAdapter}'. ${reasons.join("; ")}`);
  }
  return { contextGateway: true, repositoryMap: true, semanticRetrieval, authorizedRetrieval, reasons };
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
