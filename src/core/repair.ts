import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, RepairPacket, ValidationReport } from "./types.js";

export function createRepairPacket(report: ValidationReport, attempt: number): RepairPacket {
  return {
    version: 1,
    taskId: report.taskId,
    attempt,
    createdAt: new Date().toISOString(),
    failures: report.checks.filter((check) => check.status === "FAIL").map((check) => ({ id: check.id, category: check.category, message: check.message, details: check.details }))
  };
}

export async function writeRepairPacket(root: string, config: HarnessProjectConfig, packet: RepairPacket): Promise<string> {
  const repairsDir = path.resolve(root, config.sdd?.repairsDir ?? ".harness/repairs");
  await fs.mkdir(repairsDir, { recursive: true });
  const file = path.join(repairsDir, `${packet.taskId}-${packet.attempt}.json`);
  await fs.writeFile(file, `${JSON.stringify(packet, null, 2)}\n`);
  return file;
}
