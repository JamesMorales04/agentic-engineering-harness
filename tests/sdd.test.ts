import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSddChange, validateSddChange } from "../src/core/sdd.js";

describe("SDD scaffolding", () => {
  it("creates the required artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-"));
    await createSddChange(root, "T-1", "Test change");
    const result = await validateSddChange(root, "T-1");
    expect(result.ok).toBe(true);
  });
});
