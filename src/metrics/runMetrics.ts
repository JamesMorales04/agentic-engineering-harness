import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, RunMetrics, UsageMetrics } from "../core/types.js";

export async function countHumanInterventions(root: string, config: HarnessProjectConfig, taskId: string, since: string): Promise<number> {
  const relative = config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
  try {
    const raw = await fs.readFile(path.resolve(root, relative), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).reduce((count, line) => {
      try {
        const event = JSON.parse(line) as { at?: string; name?: string; attributes?: Record<string, unknown> };
        if (event.name !== "harness.human.intervention") return count;
        if (event.at && event.at < since) return count;
        return event.attributes?.taskId === taskId ? count + 1 : count;
      } catch { return count; }
    }, 0);
  } catch { return 0; }
}

export function buildRunMetrics(input: {
  firstPassSuccess: boolean;
  repairCount: number;
  humanInterventions: number;
  durationMs: number;
  usage?: UsageMetrics;
}): RunMetrics {
  return {
    firstPassSuccess: input.firstPassSuccess,
    repairCount: input.repairCount,
    humanInterventions: input.humanInterventions,
    durationMs: input.durationMs,
    usage: input.usage ?? {}
  };
}
