import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOperationPortfolio, syncOperationPortfolio } from "../src/operations/portfolio.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
function operation(root: string, id: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "change", status: "RUNNING", phase: "implementation", root,
    payload: { request: id }, revision: 2, createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

describe("operation portfolio concurrency", () => {
  it("preserves every operation across concurrent read-modify-write updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-portfolio-concurrent-"));
    roots.push(root);
    const operations = Array.from({ length: 12 }, (_, index) => operation(root, `CHANGE-${index}`));
    await Promise.all(operations.map((item) => syncOperationPortfolio(root, "demo", item)));
    const portfolio = await loadOperationPortfolio(root, "demo");
    expect(Object.keys(portfolio.operations).sort()).toEqual(operations.map((item) => item.id).sort());
  });
});
