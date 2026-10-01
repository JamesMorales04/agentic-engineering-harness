import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { runOpaPolicies } from "../../src/validators/opa.js";
import { collectPolicyEvidence } from "../../src/validators/evidence.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const contract: TaskContract = { version: 1, task: { id: "FAIL-CLOSED-1", title: "provider fail closed" } };
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-provider-fail-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("required provider fail-closed audit", () => {
  it("fails OPA closed when enabled but the executable is missing, never a silent SKIP", async () => {
    const root = await fixture();
    const originalPath = process.env.PATH;
    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-empty-path-"));
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "opa" }, validation: { opa: { enabled: true, policyDirs: ["policies/core"] } } };
      const check = await runOpaPolicies(root, config, contract, [], [], collectPolicyEvidence([]));
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("opa executable is not installed");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("fails OPA closed when enabled without policy directories", async () => {
    const root = await fixture();
    const config: HarnessProjectConfig = { version: 1, project: { name: "opa" }, validation: { opa: { enabled: true, policyDirs: [] } } };
    const check = await runOpaPolicies(root, config, contract, [], [], collectPolicyEvidence([]));
    expect(check.status).toBe("FAIL");
    expect(check.message).toMatch(/OPA is enabled but/);
  });

  it("reports an explicit SKIP only when OPA is disabled by configuration", async () => {
    const root = await fixture();
    const config: HarnessProjectConfig = { version: 1, project: { name: "opa" }, validation: { opa: { enabled: false } } };
    const check = await runOpaPolicies(root, config, contract, [], [], collectPolicyEvidence([]));
    expect(check.status).toBe("SKIP");
    expect(check.message).toContain("disabled");
  });

  it("fails a required external adapter with no explicit command instead of skipping", async () => {
    const root = await fixture();
    const config: HarnessProjectConfig = { version: 1, project: { name: "adapter" } };
    const check = await runExternalToolValidator({ root, config, contract, spec: { id: "pact-required", adapter: "pact", required: true }, baseRef: "HEAD", changedFiles: [] });
    expect(check.status).toBe("FAIL");
    expect(check.message).toContain("requires an explicit command");
  });
});
