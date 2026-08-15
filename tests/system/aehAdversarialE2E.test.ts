import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { runExternalToolValidator } from "../../src/validators/external.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "adversarial-system" }, telemetry: { enabled: false }, evidence: { outputDir: ".harness/evidence" } };
const contract: TaskContract = { version: 1, task: { id: "SCN-FAULT", title: "fault injection" } };

function command(script: string): string { return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`; }

describe("AEH deterministic adversarial system paths", () => {
  it("fails closed on malformed structured validator output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-malformed-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "opengrep-malformed", adapter: "opengrep", command: command("process.stdout.write('noise before json')"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("malformed evidence");
      expect(check.details?.rawArtifact).toBe(".harness/evidence/opengrep-malformed.raw");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("accepts an explicit empty structured result as a clean validator pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-empty-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "opengrep-empty", adapter: "opengrep", command: command("process.stdout.write(JSON.stringify({ results: [] }))"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("PASS");
      expect(check.details?.findingCount).toBe(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps non-zero provider exits as failures even when stdout looks valid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-adversarial-exit-"));
    try {
      const check = await runExternalToolValidator({ root, config, contract, spec: { id: "trivy-exit", adapter: "trivy", command: command("process.stdout.write(JSON.stringify({ Results: [] })); process.exitCode = 7"), required: true }, baseRef: "HEAD", changedFiles: [] });
      expect(check.status).toBe("FAIL");
      expect(check.message).toContain("exit code");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
