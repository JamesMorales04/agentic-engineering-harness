import { PaseoSdkUnavailableError } from "./sdk.js";
import { continueManagedPaseoAgent, launchManagedPaseoAgent as launchLegacyManagedPaseoAgent, materializeManagedPaseoAgent, stopManagedPaseoAgent } from "./runtimeCore.js";
/**
 * Managed AEH operation agents execute foreground initial Paseo turns through
 * the same atomic turn primitive used by resumed sessions. The concrete agent
 * is materialized and registered first, then run() executes the prompt, so a
 * fast idle -> running -> idle cycle cannot finish before AEH observes it.
 * Standalone runtime callers and explicit detached launches retain the legacy
 * lifecycle for compatibility.
 *
 * Controller-side semantic assessments are the exception: the installed Paseo/OpenCode stack
 * honors a provider-enforced output schema only on the session-creating initial prompt
 * (`send_agent_message_request` carries no outputSchema), so the assessor session is created
 * with the assessment prompt as its initial prompt plus the unchanged semantic-assessment
 * schema. It carries no `aeh.output.contract` label, so the AEH structured-result sink stays
 * inert: no result channel, no MCP server, no writer provider lease, no participant
 * registration. Completion is observed through the canonical native wait and reported via
 * `agent.wait.completed`, and the deterministic semantic validation remains authoritative.
 */
export async function launchManagedPaseoAgent(root, options, deps) {
    if (!isManagedForegroundTurn(options) || options.labels?.["aeh.kind"] === "semantic-assessment") {
        return launchLegacyManagedPaseoAgent(root, options, deps);
    }
    let materialized;
    try {
        materialized = await materializeManagedPaseoAgent(root, { ...options, prompt: undefined, waitForFinish: false }, deps);
    }
    catch (error) {
        // Compatibility fallback is safe only before a semantic turn starts. Once
        // materialization succeeds, never create a second agent for the same turn.
        if (!isSdkUnavailable(error))
            throw error;
        if (options.labels?.["aeh.operation"]?.trim()) {
            throw new Error(`PASEO_OPERATION_PROVIDER_LIFECYCLE_REQUIRED: an operation-owned Paseo session cannot fall back to the unleased CLI lifecycle. ${String(error)}`, { cause: error });
        }
        if (options.agentId || options.labels?.["aeh.execution.binding.digest"]) {
            throw new Error(`PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: a launch carrying frozen execution identity requires SDK materialization before its first prompt. ${String(error)}`);
        }
        return launchLegacyManagedPaseoAgent(root, options, deps);
    }
    if (!materialized.id)
        return materialized;
    if (options.agentId && materialized.id !== options.agentId) {
        await stopManagedPaseoAgent(root, materialized.id, deps).catch(() => undefined);
        throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: Paseo materialized a different provider agent id than the frozen binding.");
    }
    return continueManagedPaseoAgent(root, materialized.id, options.prompt, options.timeoutSeconds ?? secondsFromMs(options.timeoutMs), deps, options.outputSchema, options.labels);
}
function isManagedForegroundTurn(options) {
    return options.prompt !== undefined &&
        options.waitForFinish !== false &&
        Boolean(options.labels?.["aeh.operation"]?.trim()) &&
        Boolean(options.labels?.["aeh.role"]?.trim());
}
function isSdkUnavailable(error) {
    return error instanceof PaseoSdkUnavailableError ||
        (error instanceof Error && error.name === "PaseoSdkUnavailableError");
}
function secondsFromMs(ms) {
    return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}
//# sourceMappingURL=runtimeInitialTurn.js.map