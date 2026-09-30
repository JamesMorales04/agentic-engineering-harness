import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
export interface ContextReadiness {
    ok: boolean;
    checks: Array<{
        component: string;
        ok: boolean;
        required: boolean;
        message: string;
        version?: string;
    }>;
}
/**
 * Readiness is scoped to an execution contract. A project-level `required`
 * flag is not enough to make every role (especially the coordinator) require
 * the provider. Callers that do not yet have a selection receive a deferred
 * result and must re-check after routing.
 */
export declare function checkContextReadiness(root: string, config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<ContextReadiness>;
export declare function assertContextReadiness(root: string, config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<void>;
