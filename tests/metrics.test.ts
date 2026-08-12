import { describe, expect, it } from "vitest";
import { extractUsageMetrics, mergeUsageMetrics } from "../src/metrics/usage.js";

describe("usage metrics", () => {
  it("extracts common token and cost fields", () => {
    const metrics = extractUsageMetrics('{"input_tokens":120,"output_tokens":30,"cost_usd":0.0042}');
    expect(metrics).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsd: 0.0042 });
  });

  it("merges usage", () => {
    expect(mergeUsageMetrics({ inputTokens: 10, costUsd: 0.1 }, { inputTokens: 5, costUsd: 0.2 })).toEqual({ inputTokens: 15, costUsd: 0.3 });
  });
});
