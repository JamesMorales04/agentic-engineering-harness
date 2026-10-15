import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../../src/core/types.js";

/**
 * Persist a minimal failed validation report, mirroring production: runTask
 * persists the augmented report before launching repairers, so repair
 * fixtures must do the same before invoking repair mutations directly.
 */
export async function persistValidationReportForRepair(
  root: string,
  config: HarnessProjectConfig,
  taskId: string,
): Promise<string> {
  const relative = `${config.sdd?.reportsDir ?? ".harness/reports"}/${taskId}.json`;
  const file = path.resolve(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const report = {
    version: 1,
    taskId,
    status: "FAIL",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checks: [{ id: "fixture-check", category: "fixture", status: "FAIL", message: "fixture failure" }],
    changedFiles: [],
    findings: [],
  };
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
