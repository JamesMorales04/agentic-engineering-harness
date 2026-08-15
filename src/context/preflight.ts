import type { HarnessProjectConfig } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import { HeadroomCompressionProvider } from "./compression/headroom.js";
import { resolveContextTransportCapabilities } from "./transport.js";

export interface ContextReadiness { ok: boolean; checks: Array<{ component: string; ok: boolean; required: boolean; message: string; version?: string }> }

/**
 * Readiness is scoped to an execution contract. A project-level `required`
 * flag is not enough to make every role (especially the coordinator) require
 * the provider. Callers that do not yet have a selection receive a deferred
 * result and must re-check after routing.
 */
export async function checkContextReadiness(root: string, config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<ContextReadiness> {
  if (!config.context) return { ok: true, checks: [] };
  const checks: ContextReadiness["checks"] = [];
  let compressionRequired = false;
  if (selection) {
    const capabilities = await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
    compressionRequired = capabilities.requiredByExecutionContract.compression;
    if (config.context.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none") {
      checks.push({
        component: "serena",
        required: capabilities.requiredByProject.semanticRetrieval && capabilities.requiredByExecutionContract.semanticRetrieval,
        ok: capabilities.semanticRetrieval,
        message: capabilities.semanticRetrieval ? "Serena is available for this execution contract." : capabilities.reasons.join("; ") || "Serena is unavailable for this execution contract."
      });
    }
  } else if (config.context.semanticRetrieval?.provider && config.context.semanticRetrieval.provider !== "none") {
    checks.push({ component: "serena", required: false, ok: true, message: "Deferred until an execution contract is selected; project required=true is not a global role requirement." });
  }
  const compressionProvider = config.context.compression?.provider ?? "headroom";
  if (compressionProvider !== "none" && compressionRequired) {
    const compression = await new HeadroomCompressionProvider({ command: config.context.compression?.command }).doctor(root);
    checks.push({ component: "headroom", required: true, ...compression });
  } else if (compressionProvider !== "none" && !selection) {
    checks.push({ component: "headroom", required: false, ok: true, message: "Deferred until an execution contract declares compression requirements." });
  }
  return { ok: checks.every((check) => !check.required || check.ok), checks };
}

export async function assertContextReadiness(root: string, config: HarnessProjectConfig, selection?: AgentExecutionSelection): Promise<void> {
  const readiness = await checkContextReadiness(root, config, selection);
  const failures = readiness.checks.filter((check) => check.required && !check.ok);
  if (failures.length) throw new Error(`BLOCKED_EXTERNAL: mandatory context provider readiness failed. ${failures.map((failure) => `${failure.component}: ${failure.message}`).join("; ")}`);
}
