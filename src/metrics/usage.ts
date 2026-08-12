import type { UsageMetrics } from "../core/types.js";

const aliases = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  totalTokens: ["total_tokens", "totalTokens"],
  costUsd: ["cost_usd", "costUsd", "total_cost_usd", "totalCostUsd"]
} as const;

export function extractUsageMetrics(text: string): UsageMetrics {
  const result: UsageMetrics = {};
  result.inputTokens = integerMetric(text, aliases.inputTokens);
  result.outputTokens = integerMetric(text, aliases.outputTokens);
  result.totalTokens = integerMetric(text, aliases.totalTokens);
  result.costUsd = decimalMetric(text, aliases.costUsd);
  if (result.totalTokens === undefined && (result.inputTokens !== undefined || result.outputTokens !== undefined)) {
    result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  }
  return stripUndefined(result);
}

export function mergeUsageMetrics(...items: UsageMetrics[]): UsageMetrics {
  const totals: UsageMetrics = {};
  for (const item of items) {
    if (item.inputTokens !== undefined) totals.inputTokens = (totals.inputTokens ?? 0) + item.inputTokens;
    if (item.outputTokens !== undefined) totals.outputTokens = (totals.outputTokens ?? 0) + item.outputTokens;
    if (item.totalTokens !== undefined) totals.totalTokens = (totals.totalTokens ?? 0) + item.totalTokens;
    if (item.costUsd !== undefined) totals.costUsd = round((totals.costUsd ?? 0) + item.costUsd);
  }
  return totals;
}

function integerMetric(text: string, names: readonly string[]): number | undefined {
  const value = numericMetric(text, names);
  return value === undefined ? undefined : Math.round(value);
}

function decimalMetric(text: string, names: readonly string[]): number | undefined {
  return numericMetric(text, names);
}

function numericMetric(text: string, names: readonly string[]): number | undefined {
  let last: number | undefined;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`[\"']?${escaped}[\"']?\\s*[:=]\\s*[\"']?([0-9]+(?:\\.[0-9]+)?)`, "gi");
    for (const match of text.matchAll(pattern)) last = Number(match[1]);
  }
  return Number.isFinite(last) ? last : undefined;
}

function stripUndefined(metrics: UsageMetrics): UsageMetrics {
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined)) as UsageMetrics;
}

function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
