import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("P-NEW-6 RED: handoff workspace must join the operation registry", () => {
  it("runPaseoWorkspace registers RETAIN_SHARED", async () => {
    const source = await fs.readFile(path.resolve("src/delivery/handoff.ts"), "utf8");
    expect(source).toMatch(/registerOperationResource/);
    expect(source).toMatch(/RETAIN_SHARED/);
  });
});
