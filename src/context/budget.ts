import type { HarnessProjectConfig } from "../core/types.js";
import { resolveContextPolicy } from "./policy.js";
import type { ContextBudget, ContextBudgetConfigLike } from "./types.js";

const defaultReserved = { instructions: 512, normative: 4_096, evidence: 2_048, response: 1_024 };
const compactReserved = { instructions: 256, normative: 512, evidence: 256, response: 256 };

export function resolveContextBudget(config: HarnessProjectConfig, role = "implementer", phase = "work"): ContextBudget {
  const policy = resolveContextPolicy(config);
  const override = { ...policy.defaultBudget, ...(policy.agentBudgets[role] ?? {}), ...(policy.phaseBudgets[phase] ?? {}) };
  const maxTokens = override.inputTokens ?? override.maxTokens ?? 16_000;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error(`Context budget for ${role}/${phase} must be a positive integer.`);
  const reserved = { ...(maxTokens < 4_000 ? compactReserved : defaultReserved), ...(override.reserved ?? {}) };
  const reservedTotal = Object.values(reserved).reduce((sum, value) => sum + value, 0);
  if (reservedTotal >= maxTokens) throw new Error(`Context budget for ${role}/${phase} is smaller than its reserved headroom.`);
  return { maxTokens, reserved, role, phase };
}

export function mergeBudgetConfig(...values: Array<ContextBudgetConfigLike | undefined>): ContextBudgetConfigLike {
  return values.reduce<ContextBudgetConfigLike>((result, value) => ({ ...result, ...(value ?? {}), reserved: { ...result.reserved, ...(value?.reserved ?? {}) } }), {});
}
