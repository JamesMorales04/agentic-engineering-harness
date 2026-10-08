import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("P-NEW-6: handoff workspace must join the operation registry", () => {
  it("runPaseoWorkspace registers RETAIN_SHARED", async () => {
    const source = await fs.readFile(path.resolve("src/delivery/handoff.ts"), "utf8");
    expect(source).toMatch(/registerOperationResource/);
    expect(source).toMatch(/RETAIN_SHARED/);
  });

  it("registration failure cleans up then fails loudly (never proceeds unregistered)", async () => {
    const source = await fs.readFile(path.resolve("src/delivery/handoff.ts"), "utf8");
    const start = source.indexOf("async function trackHandoffWorkspace");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 1600);
    // Fails loudly with a dedicated code.
    expect(block).toMatch(/HANDOFF_REGISTRATION_FAILED/);
    expect(block).toMatch(/throw new Error/);
    // Best-effort cleanup of the just-created workspace before throwing.
    expect(block).toMatch(/paseo/);
    expect(block).toMatch(/workspace/);
    expect(block).toMatch(/archive/);
    // The registration await itself must not swallow errors: the
    // registerOperationResource statement terminates cleanly and the only
    // best-effort swallow left in the block is the archive cleanup.
    const regIdx = block.indexOf("registerOperationResource");
    expect(regIdx).toBeGreaterThanOrEqual(0);
    const afterReg = block.slice(regIdx, regIdx + 600);
    const stmtEnd = afterReg.indexOf("});");
    expect(stmtEnd).toBeGreaterThan(0);
    expect(afterReg.slice(0, stmtEnd)).not.toContain(".catch");
    expect(block.match(/\.catch\(\(\) => undefined\)/g)?.length ?? 0).toBe(1);
    // Retained-shared outputs are owner-managed, not temp (delivery-lifecycle decision).
    expect(block).toMatch(/owner-managed/);
  });
});
