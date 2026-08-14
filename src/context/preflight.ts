import type { HarnessProjectConfig } from "../core/types.js";
import { HeadroomCompressionProvider } from "./compression/headroom.js";
import { SerenaSemanticProvider } from "./repository/serena.js";

export interface ContextReadiness { ok: boolean; checks: Array<{ component: string; ok: boolean; required: boolean; message: string; version?: string }> }

export async function checkContextReadiness(root: string, config: HarnessProjectConfig): Promise<ContextReadiness> {
  if (!config.context) return { ok: true, checks: [] };
  const checks: ContextReadiness["checks"] = [];
  const semantic = await new SerenaSemanticProvider().doctor(root);
  checks.push({ component: "serena", required: config.context.semanticRetrieval?.required ?? true, ...semantic });
  const compression = await new HeadroomCompressionProvider({ command: config.context.compression?.command }).doctor(root);
  checks.push({ component: "headroom", required: config.context.compression?.required ?? true, ...compression });
  return { ok: checks.every((check) => !check.required || check.ok), checks };
}

export async function assertContextReadiness(root: string, config: HarnessProjectConfig): Promise<void> {
  const readiness = await checkContextReadiness(root, config);
  const failures = readiness.checks.filter((check) => check.required && !check.ok);
  if (failures.length) throw new Error(`BLOCKED_EXTERNAL: mandatory context provider readiness failed. ${failures.map((failure) => `${failure.component}: ${failure.message}`).join("; ")}`);
}
