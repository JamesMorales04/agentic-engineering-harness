import fs from "node:fs/promises";
import path from "node:path";
export function createRepairPacket(report, attempt, context) {
    return { version: 1, taskId: report.taskId, attempt, createdAt: new Date().toISOString(), failureType: context?.failureType, failedAgent: context?.failedAgent, recoveryAction: context?.recoveryAction, failures: report.checks.filter((check) => check.status === "FAIL").map((check) => ({ id: check.id, category: check.category, message: check.message, details: check.details })) };
}
export async function writeRepairPacket(root, config, packet) { const repairsDir = path.resolve(root, config.sdd?.repairsDir ?? ".harness/repairs"); await fs.mkdir(repairsDir, { recursive: true }); const file = path.join(repairsDir, `${packet.taskId}-${packet.attempt}.json`); await fs.writeFile(file, `${JSON.stringify(packet, null, 2)}\n`); return file; }
//# sourceMappingURL=repair.js.map