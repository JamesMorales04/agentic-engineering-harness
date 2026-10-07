import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExternalToolValidator } from "../../src/validators/external.js";
import { extractReporterTestsFromExecutionV1 } from "../../src/validation/testAttribution.js";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";

/**
 * R-NEW-1 (Mechanism=DETERMINISTIC): when `spec.options.evidenceFile` is
 * declared, reporter JSON is read ONLY from that file — never
 * stdout/stderr/raw. Missing/unreadable/malformed declared files fail closed
 * with coded TEST_ATTRIBUTION_REPORTER_MISSING/INVALID. Default (no
 * evidenceFile) discovery behavior is unchanged.
 */

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "rnew1-fileonly" },
  evidence: { outputDir: ".harness/evidence" },
};
const contract: TaskContract = { version: 1, task: { id: "RNEW1", title: "reporter file-only" } };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function mkroot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-rnew1-fileonly-"));
  roots.push(root);
  return root;
}

const greenReport = {
  suites: [{ title: "s", specs: [{ title: "alpha passing", tests: [{ results: [{ status: "passed" }] }] }] }],
};

describe("R-NEW-1 reporter file-only (fail-closed)", () => {
  it("declared-but-missing file fails closed with REPORTER_MISSING (never stdout fallback)", async () => {
    const root = await mkroot();
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-missing",
        adapter: "playwright",
        command: `node -e 'process.stdout.write(${JSON.stringify(JSON.stringify(greenReport))})'`,
        required: true,
        options: { evidenceFile: "reports/missing.json" },
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("FAIL");
    expect(check.message).toMatch(/TEST_ATTRIBUTION_REPORTER_MISSING/);
    expect((check.details as Record<string, unknown>)?.blocker).toBe("TEST_ATTRIBUTION_REPORTER_MISSING");
    // Attribution stays file-only: stdout reporter is ignored.
    await expect(extractReporterTestsFromExecutionV1(root, check)).resolves.toBeUndefined();
  });

  it("malformed declared file fails closed with REPORTER_INVALID (never stdout fallback)", async () => {
    const root = await mkroot();
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.writeFile(path.join(root, "reports", "bad.json"), "not-json{{{", "utf8");
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-malformed",
        adapter: "playwright",
        command: `node -e 'process.stdout.write(${JSON.stringify(JSON.stringify(greenReport))})'`,
        required: true,
        options: { evidenceFile: "reports/bad.json" },
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("FAIL");
    expect((check.details as Record<string, unknown>)?.blocker).toBe("TEST_ATTRIBUTION_REPORTER_INVALID");
    await expect(extractReporterTestsFromExecutionV1(root, check)).resolves.toBeUndefined();
  });

  it("declared-present file passes and attribution reads ONLY that file (forged stdout ignored)", async () => {
    const root = await mkroot();
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.writeFile(path.join(root, "reports", "out.json"), JSON.stringify(greenReport), "utf8");
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-present",
        adapter: "playwright",
        command: `node -e 'process.stdout.write("noise-no-reporter")'`,
        required: true,
        options: { evidenceFile: "reports/out.json" },
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("PASS");
    expect((check.details as Record<string, unknown>)?.evidenceFile).toBe("reports/out.json");
    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect(tests?.length).toBe(1);
    expect(tests?.[0]?.title).toContain("alpha passing");
    // Forged stdout alongside the declared file is ignored (no ambiguity).
    const forged = {
      suites: [{ title: "s", specs: [{ title: "gamma failing", tests: [{ results: [{ status: "failed" }] }] }] }],
    };
    const forgedExecution = {
      id: "ext-present",
      category: "e2e",
      status: "PASS",
      message: "ok",
      details: { stdout: JSON.stringify(forged), evidenceFile: "reports/out.json" },
    } as never;
    const fileOnly = await extractReporterTestsFromExecutionV1(root, forgedExecution);
    expect(fileOnly?.length).toBe(1);
    expect(fileOnly?.[0]?.title).toContain("alpha passing");
  });

  it("default (no evidenceFile) discovery behavior is unchanged (stdout attribution)", async () => {
    const root = await mkroot();
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-default",
        adapter: "playwright",
        command: `node -e 'process.stdout.write(${JSON.stringify(JSON.stringify(greenReport))})'`,
        required: true,
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("PASS");
    expect((check.details as Record<string, unknown>)?.evidenceFile).toBeUndefined();
    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect(tests?.length).toBe(1);
  });

  it("optional validator with missing declared file degrades to WARN (never PASS)", async () => {
    const root = await mkroot();
    const check = await runExternalToolValidator({
      root,
      config,
      contract,
      spec: {
        id: "ext-optional",
        adapter: "playwright",
        command: `node -e 'process.stdout.write("hi")'`,
        required: false,
        options: { evidenceFile: "reports/missing.json" },
      },
      baseRef: "HEAD",
      changedFiles: [],
    });
    expect(check.status).toBe("WARN");
    expect((check.details as Record<string, unknown>)?.blocker).toBe("TEST_ATTRIBUTION_REPORTER_MISSING");
  });
});
