import { commandExists, runShell } from "../utils/process.js";
/**
 * Runtime defaults are an adapter registry, not policy. Context code consumes
 * capabilities from this registry and from the selected execution contract;
 * it never treats a runtime name as proof that MCP is available.
 */
const RUNTIME_CAPABILITY_REGISTRY = {
    opencode: { mcp: true, stdioMcp: true, localMcp: true, runtimeConfigInjection: true, nativeToolProjection: true },
    // Codex supports local stdio MCP. AEH's direct adapter does not currently
    // inject project-scoped config, while Paseo projects MCP into the session.
    codex: { mcp: true, stdioMcp: true, localMcp: true, runtimeConfigInjection: false, nativeToolProjection: true }
};
const TRANSPORT_CAPABILITY_REGISTRY = {
    paseo: { mcpProjection: true, localMcpProjection: true, directRuntimeConfig: false },
    direct: { mcpProjection: true, localMcpProjection: true, directRuntimeConfig: true },
    podman: { mcpProjection: false, localMcpProjection: false, directRuntimeConfig: false },
    none: { mcpProjection: false, localMcpProjection: false, directRuntimeConfig: false }
};
export function resolveContextCapabilityRequirements(config, selection) {
    const configured = selection.contextRequirements;
    const coordinator = selection.role === "Lead/Director" || selection.role === "Operation Supervisor";
    const semanticConfigured = Boolean(config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none");
    const semanticDefault = semanticConfigured && config.context?.semanticRetrieval?.required !== false ? "REQUIRED" : "OPTIONAL";
    const compressionConfigured = Boolean(config.context?.compression?.provider && config.context.compression.provider !== "none");
    const defaults = coordinator
        ? { repositoryMap: "FORBIDDEN", semanticRetrieval: "FORBIDDEN", rawRetrieval: "FORBIDDEN", compression: "OPTIONAL" }
        : {
            repositoryMap: "OPTIONAL",
            semanticRetrieval: semanticDefault,
            rawRetrieval: "OPTIONAL",
            compression: compressionConfigured && config.context?.compression?.required !== false ? "REQUIRED" : "OPTIONAL"
        };
    return {
        repositoryMap: configured?.repositoryMap ?? defaults.repositoryMap ?? "OPTIONAL",
        semanticRetrieval: configured?.semanticRetrieval ?? defaults.semanticRetrieval ?? "OPTIONAL",
        rawRetrieval: configured?.rawRetrieval ?? defaults.rawRetrieval ?? "OPTIONAL",
        compression: configured?.compression ?? defaults.compression ?? "OPTIONAL",
        source: configured ? "agent-contract" : coordinator ? "coordinator-default" : "project-default"
    };
}
export function runtimeCapabilitiesFor(selection) {
    return { ...(RUNTIME_CAPABILITY_REGISTRY[selection.runtimeAdapter] ?? {}), ...(selection.runtimeCapabilities ?? {}) };
}
export function transportCapabilitiesFor(config, selection) {
    const transport = effectiveTransport(config, selection);
    const runtime = runtimeCapabilitiesFor(selection);
    const registered = TRANSPORT_CAPABILITY_REGISTRY[transport] ?? { mcpProjection: false, localMcpProjection: false, directRuntimeConfig: false };
    const reasons = [];
    if (runtime.mcp !== true)
        reasons.push(`runtime '${selection.runtimeName}' does not declare MCP capability`);
    if (runtime.stdioMcp !== true)
        reasons.push(`runtime '${selection.runtimeName}' does not declare stdio MCP capability`);
    if (runtime.localMcp !== true)
        reasons.push(`runtime '${selection.runtimeName}' does not declare local MCP capability`);
    if (!registered.mcpProjection || !registered.localMcpProjection)
        reasons.push(`transport '${transport}' does not project local MCP servers`);
    if (transport === "direct" && runtime.runtimeConfigInjection !== true)
        reasons.push(`direct runtime adapter '${selection.runtimeName}' does not inject project MCP configuration`);
    if (transport === "paseo" && runtime.nativeToolProjection !== true)
        reasons.push(`runtime '${selection.runtimeName}' does not declare native MCP projection through Paseo`);
    return { ...registered, directRuntimeConfig: registered.directRuntimeConfig && runtime.runtimeConfigInjection === true, reasons };
}
/** Resolve effective capabilities without touching external runtimes. */
export function staticContextCapabilities(config, selection) {
    const requirements = resolveContextCapabilityRequirements(config, selection);
    const runtimeCapabilities = runtimeCapabilitiesFor(selection);
    const transportCapabilities = transportCapabilitiesFor(config, selection);
    const semanticConfigured = Boolean(config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none");
    const rawConfigured = Boolean(config.context);
    const repositoryMapConfigured = config.context?.repositoryMap?.enabled !== false;
    const semanticAvailableBySurface = semanticConfigured && requirements.semanticRetrieval !== "FORBIDDEN" && transportCapabilities.reasons.length === 0;
    const semanticRetrieval = semanticAvailableBySurface;
    const authorizedRetrieval = rawConfigured && requirements.rawRetrieval !== "FORBIDDEN" && transportCapabilities.reasons.length === 0;
    const repositoryMap = repositoryMapConfigured && requirements.repositoryMap !== "FORBIDDEN";
    const requiredByProject = {
        semanticRetrieval: semanticConfigured && config.context?.semanticRetrieval?.required !== false,
        rawRetrieval: false,
        repositoryMap: false,
        compression: Boolean(config.context?.compression?.provider && config.context.compression.provider !== "none" && config.context.compression.required !== false)
    };
    const requiredByExecutionContract = {
        semanticRetrieval: requirements.semanticRetrieval === "REQUIRED",
        rawRetrieval: requirements.rawRetrieval === "REQUIRED",
        repositoryMap: requirements.repositoryMap === "REQUIRED",
        compression: requirements.compression === "REQUIRED"
    };
    const reasons = [...transportCapabilities.reasons];
    const degradations = [];
    if (!semanticConfigured)
        reasons.push("semantic retrieval is not configured for this project");
    if (requirements.semanticRetrieval === "FORBIDDEN")
        reasons.push("execution contract forbids semantic repository retrieval");
    if (requirements.rawRetrieval === "FORBIDDEN")
        reasons.push("execution contract forbids raw context retrieval");
    if (requirements.repositoryMap === "FORBIDDEN")
        reasons.push("execution contract forbids repository-map context");
    if (semanticConfigured && requirements.semanticRetrieval !== "FORBIDDEN" && !semanticRetrieval && !requiredByProject.semanticRetrieval)
        degradations.push("Serena unavailable; bounded repository-map/raw context fallback is active");
    const readinessRequirements = [];
    if (semanticRetrieval)
        readinessRequirements.push("Serena MCP initialize/tools/list readiness");
    if (authorizedRetrieval)
        readinessRequirements.push("AEH context MCP authorization and source-hash verification");
    return {
        contextGateway: true,
        repositoryMap,
        semanticRetrieval,
        authorizedRetrieval,
        mcpServers: { serena: semanticRetrieval, context: authorizedRetrieval, headroom: false },
        requirements,
        runtimeCapabilities,
        transportCapabilities,
        requiredByProject,
        requiredByExecutionContract,
        readinessRequirements,
        degradations,
        reasons
    };
}
export async function resolveContextTransportCapabilities(root, config, selection, probe = {}) {
    const capabilities = staticContextCapabilities(config, selection);
    const semanticConfigured = Boolean(config.context?.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none");
    if (probe.mode === "live" && semanticConfigured && capabilities.semanticRetrieval) {
        const { SerenaSemanticProvider } = await import("./repository/serena.js");
        const health = await new SerenaSemanticProvider().doctor(root);
        if (!health.ok) {
            capabilities.semanticRetrieval = false;
            capabilities.mcpServers.serena = false;
            capabilities.reasons.push(`Serena readiness failed: ${health.message}`);
            if (!capabilities.requiredByProject.semanticRetrieval || !capabilities.requiredByExecutionContract.semanticRetrieval)
                capabilities.degradations.push(`Serena unavailable; explicit fallback: ${health.message}`);
        }
    }
    if (probe.mode === "live" && effectiveTransport(config, selection) === "podman" && config.security?.sandbox?.image) {
        const live = await probePodmanSerena(root, config.security.sandbox.image, probe);
        capabilities.reasons.push(`live Podman probe: ${live.message}`);
        if (!live.available || !live.imagePresent || !live.exposesSerena)
            capabilities.readinessRequirements.push("pre-provisioned Podman image with Serena executable");
    }
    // Project `required=true` is scoped by the contract: it cannot force the
    // coordinator or an OPTIONAL/FORBIDDEN worker surface to use Serena. An
    // explicit execution-contract REQUIRED, however, is independently binding.
    const required = capabilities.requiredByExecutionContract.semanticRetrieval;
    if (required && !capabilities.semanticRetrieval) {
        throw new Error(`UNSUPPORTED_CAPABILITY: Serena semantic retrieval is required by the execution contract, but is unavailable for transport '${effectiveTransport(config, selection)}' and runtime '${selection.runtimeName}'. ${capabilities.reasons.join("; ")}`);
    }
    return capabilities;
}
/** Bounded, no-pull diagnostic for an explicitly provisioned Podman image. */
export async function probePodmanSerena(root, image, probe = {}) {
    const executable = probe.commandExists ?? commandExists;
    const runner = probe.run ?? runShell;
    if (!(await executable("podman", root)))
        return { available: false, imagePresent: false, exposesSerena: false, message: "Podman executable is unavailable" };
    const imageCheck = await runner(`podman image exists ${quote(image)}`, { cwd: root, timeoutMs: 10_000 });
    if (imageCheck.exitCode !== 0)
        return { available: true, imagePresent: false, exposesSerena: false, message: "configured Podman image is not already present; no pull was attempted" };
    const result = await runner(`podman run --pull=never --network=none --rm ${quote(image)} sh -lc 'command -v serena'`, { cwd: root, timeoutMs: 30_000 });
    return result.exitCode === 0 && Boolean(result.stdout.trim())
        ? { available: true, imagePresent: true, exposesSerena: true, message: "configured Podman image exposes a Serena executable but not an AEH MCP projection" }
        : { available: true, imagePresent: true, exposesSerena: false, message: "configured Podman image does not expose Serena" };
}
function effectiveTransport(config, selection) {
    return !selection.transport || selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
//# sourceMappingURL=transport.js.map