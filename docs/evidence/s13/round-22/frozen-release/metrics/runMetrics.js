import fs from "node:fs/promises";
import path from "node:path";
export async function countHumanInterventions(root, config, taskId, since) {
    const relative = config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
    try {
        const raw = await fs.readFile(path.resolve(root, relative), "utf8");
        return raw.split(/\r?\n/).filter(Boolean).reduce((count, line) => {
            try {
                const event = JSON.parse(line);
                if (event.name !== "harness.human.intervention")
                    return count;
                if (event.at && event.at < since)
                    return count;
                return event.attributes?.taskId === taskId ? count + 1 : count;
            }
            catch {
                return count;
            }
        }, 0);
    }
    catch {
        return 0;
    }
}
export function buildRunMetrics(input) {
    return {
        firstPassSuccess: input.firstPassSuccess,
        repairCount: input.repairCount,
        humanInterventions: input.humanInterventions,
        durationMs: input.durationMs,
        usage: input.usage ?? {}
    };
}
//# sourceMappingURL=runMetrics.js.map