import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { createSddChange, validateSddChange } from "../src/core/sdd.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "test" },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts" },
  validation: { baseRef: "main", validators: [{ id: "acceptance", adapter: "gherkin", required: false }] },
  orchestration: { provider: "none", worker: { maxRepairAttempts: 2 } }
};

describe("SDD traceability", () => {
  it("creates a fully traceable change and TaskContract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-"));
    await createSddChange(root, "T-1", "Test change", config);
    const result = await validateSddChange(root, "T-1", config);
    expect(result.ok).toBe(true);
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toMatchObject({ id: "T-1-R1", proposal: true, spec: true, design: true, acceptance: true, tasks: true, contract: true });
  });

  it("fails when a requirement loses its Gherkin trace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-"));
    await createSddChange(root, "T-2", "Test change", config);
    const feature = path.join(root, "specs", "changes", "T-2", "acceptance.feature");
    const content = await fs.readFile(feature, "utf8");
    await fs.writeFile(feature, content.replace("@T-2-R1", "@OTHER"));
    const result = await validateSddChange(root, "T-2", config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("acceptance"))).toBe(true);
  });

  it("rejects unknown validator references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-"));
    await createSddChange(root, "T-3", "Test change", config);
    const contract = path.join(root, ".harness", "contracts", "T-3.yaml");
    const content = await fs.readFile(contract, "utf8");
    await fs.writeFile(contract, content.replace("- gherkin", "- missing-validator"));
    const result = await validateSddChange(root, "T-3", config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("unknown validator"))).toBe(true);
  });
});
