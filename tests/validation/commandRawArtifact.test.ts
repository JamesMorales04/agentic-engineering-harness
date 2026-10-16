import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { runValidationCommand } from "../../src/validators/commands.js";
import { extractReporterTestsFromExecutionV1 } from "../../src/validation/testAttribution.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "d19-raw-artifact" },
  evidence: { outputDir: ".harness/evidence" },
} as HarnessProjectConfig;

/**
 * D19 (HIGH correctness): validation-command output larger than the 12KB
 * details bound must still attribute. Before the fix, details.stdout was
 * truncated (and passing runs carried no stdout at all), so any reporter
 * JSON beyond the bound misreported as TEST_ATTRIBUTION_REPORTER_MISSING
 * instead of attributing real results (live: Playwright suites ~17KB).
 * runValidationCommand now persists complete bytes to a raw artifact file
 * that attribution reads. DETERMINISTIC throughout (stub command, no
 * providers).
 */
describe("D19 command raw artifact for test attribution", () => {
  it("persists complete reporter bytes beyond the details bound and attribution parses the full document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d19-raw-"));
    roots.push(root);
    // Fake reporter: one failing spec (failedTitles must survive) plus
    // padding suites pushing output well beyond the 12KB details bound.
    const script = path.join(root, "big-report.mjs");
    await fs.writeFile(
      script,
      `const suites = [{ title: "real", specs: [{ title: "gamma failing visual", tests: [{ results: [{ status: "failed", error: { message: "width drift" }, attachments: [] }] }] }] }];
for (let i = 0; i < 40; i += 1) suites.push({ title: "pad-" + i, specs: [{ title: "pad spec " + i + " " + "x".repeat(400), tests: [{ results: [{ status: "passed", attachments: [] }] }] }] });
process.stdout.write(JSON.stringify({ suites }));
process.exit(1);
`,
      "utf8",
    );
    const check = await runValidationCommand(root, { id: "d19-bundle", command: `${process.execPath} big-report.mjs`, required: true }, { config });
    expect(check.status).toBe("FAIL");
    const details = check.details as Record<string, unknown>;
    expect(typeof details.rawArtifact).toBe("string");
    const rawAbs = path.resolve(root, details.rawArtifact as string);
    const rawBytes = await fs.readFile(rawAbs, "utf8");
    expect(rawBytes.length).toBeGreaterThan(12_000);
    expect(rawBytes).toContain("gamma failing visual");
    // details.stdout stays bounded for humans; the raw file carries truth.
    expect((details.stdout as string).length).toBeLessThanOrEqual(12_100);

    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect(tests).toBeDefined();
    expect((tests ?? []).some((t) => t.fullTitle.includes("gamma failing visual"))).toBe(true);
  });

  it("persists raw output for passing commands too (summary-only details carry no reporter)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d19-raw-pass-"));
    roots.push(root);
    await fs.writeFile(
      path.join(root, "pass-report.mjs"),
      `process.stdout.write(JSON.stringify({ suites: [{ title: "s", specs: [{ title: "alpha passing journey", tests: [{ results: [{ status: "passed", attachments: [] }] }] }] }] }));\nprocess.exit(0);\n`,
      "utf8",
    );
    const check = await runValidationCommand(root, { id: "d19-pass", command: `${process.execPath} pass-report.mjs`, required: true }, { config });
    expect(check.status).toBe("PASS");
    const details = check.details as Record<string, unknown>;
    expect(typeof details.rawArtifact).toBe("string");
    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect((tests ?? []).some((t) => t.fullTitle.includes("alpha passing journey"))).toBe(true);
  });
});
