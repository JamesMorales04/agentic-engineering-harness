import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaturityInventory, validateMaturityInventory } from "../src/maturity/inventory.js";

describe("typed component maturity", () => {
  it("accepts the checked-in inventory only when evidence paths and levels agree", async () => {
    const root = path.resolve(process.cwd()); const inventory = await loadMaturityInventory(root); const result = await validateMaturityInventory(root, inventory);
    expect(result.ok).toBe(true); expect(result.issues).toEqual([]);
  });

  it("rejects a promotion backed by an arbitrary string or missing evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-maturity-"));
    const result = await validateMaturityInventory(root, { version: 1, levels: [], components: [{ component: "Fake", claimed: "PRODUCTION_GRADE", evidence: [{ type: "documentation", id: "arbitrary", path: "made-up.txt" }] }] });
    expect(result.ok).toBe(false); expect(result.issues.join("\n")).toMatch(/evidence path|exceeds evidence-supported/);
  });
});
