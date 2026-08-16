import type { HarnessProjectConfig } from "../core/types.js";
import { resolveContextPolicy } from "./policy.js";
import type { ContextBudget, ContextBudgetConfigLike } from "./types.js";

const defaultReserved = { instructions: 512, normative: 4_096, evidence: 2_048, response: 1_024 };
const compactReserved = { instructions: 256, normative: 512, evidence: 256, response: 256 };

export const informationalContextDefaults = {
  targetTokens: 8_000,
  softLimitTokens: 12_000,
  exceptionalTokens: 15_000,
  maxSources: 8,
  sourceSummaryTokens: 96
} as const;

export interface InformationalContextBudget {
  targetTokens: number;
  softLimitTokens: number;
  exceptionalTokens: number;
  maxSources: number;
  sourceSummaryTokens: number;
}

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

/** Centralized lead budget for the operation-free repository informational route. */
export function resolveInformationalContextBudget(config: HarnessProjectConfig): InformationalContextBudget {
  const policy = resolveContextPolicy(config);
  const configured = config.context?.informational;
  // The generic worker default is intentionally not inherited by the
  // operation-free lead route. Only explicit lead/phase overrides can change
  // the informational default target.
  const leadBudget = mergeBudgetConfig(policy.agentBudgets.lead, policy.phaseBudgets.informational);
  const targetTokens = configured?.targetTokens ?? informationalContextDefaults.targetTokens;
  const softLimitTokens = configured?.softLimitTokens ?? leadBudget.inputTokens ?? leadBudget.maxTokens ?? informationalContextDefaults.softLimitTokens;
  const exceptionalTokens = configured?.exceptionalTokens ?? informationalContextDefaults.exceptionalTokens;
  const budget: InformationalContextBudget = {
    targetTokens,
    softLimitTokens,
    exceptionalTokens,
    maxSources: configured?.maxSources ?? informationalContextDefaults.maxSources,
    sourceSummaryTokens: configured?.sourceSummaryTokens ?? informationalContextDefaults.sourceSummaryTokens
  };
  if (![budget.targetTokens, budget.softLimitTokens, budget.exceptionalTokens, budget.maxSources, budget.sourceSummaryTokens].every((value) => Number.isInteger(value) && value > 0)) throw new Error("Informational context budget values must be positive integers.");
  if (budget.softLimitTokens < budget.targetTokens) throw new Error("Informational context soft limit must be >= its target.");
  if (budget.exceptionalTokens < budget.softLimitTokens) throw new Error("Informational context exceptional limit must be >= its soft limit.");
  return budget;
}
