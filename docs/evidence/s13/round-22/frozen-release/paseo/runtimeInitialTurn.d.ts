import { launchManagedPaseoAgent as launchLegacyManagedPaseoAgent, type ManagedPaseoAgentOptions, type ManagedPaseoAgentResult } from "./runtimeCore.js";
type RuntimeDeps = Parameters<typeof launchLegacyManagedPaseoAgent>[2];
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
export declare function launchManagedPaseoAgent(root: string, options: ManagedPaseoAgentOptions, deps?: RuntimeDeps): Promise<ManagedPaseoAgentResult>;
export {};
