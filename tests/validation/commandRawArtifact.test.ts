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
    // Fake reporter: one failing spec (failed status must survive) plus
    // padding suites pushing output well beyond the 12KB details bound.
    // The fixture awaits stdout drain before exiting: process.exit() never
    // flushes pending pipe writes, so exiting on the write callback keeps
    // the complete-bytes assertion deterministic under load.
    const script = path.join(root, "big-report.mjs");
    await fs.writeFile(
      script,
      `const suites = [{ title: "real", specs: [{ title: "gamma failing visual", tests: [{ results: [{ status: "failed", error: { message: "width drift" }, attachments: [] }] }] }] }];
for (let i = 0; i < 40; i += 1) suites.push({ title: "pad-" + i, specs: [{ title: "pad spec " + i + " " + "x".repeat(400), tests: [{ results: [{ status: "passed", attachments: [] }] }] }] });
await new Promise((resolve) => process.stdout.write(JSON.stringify({ suites }), resolve));
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
    const gamma = (tests ?? []).find((t) => t.fullTitle.includes("gamma failing visual"));
    expect(gamma).toBeDefined();
    // The failed result itself must survive the round trip, not just the title.
    expect(gamma?.status).toBe("failed");
  });

  it("persists raw output for passing commands too (summary-only details carry no reporter)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d19-raw-pass-"));
    roots.push(root);
    await fs.writeFile(
      path.join(root, "pass-report.mjs"),
      `const doc = JSON.stringify({ suites: [{ title: "s", specs: [{ title: "alpha passing journey", tests: [{ results: [{ status: "passed", attachments: [] }] }] }] }] });\nawait new Promise((resolve) => process.stdout.write(doc, resolve));\nprocess.exit(0);\n`,
      "utf8",
    );
    const check = await runValidationCommand(root, { id: "d19-pass", command: `${process.execPath} pass-report.mjs`, required: true }, { config });
    expect(check.status).toBe("PASS");
    const details = check.details as Record<string, unknown>;
    expect(typeof details.rawArtifact).toBe("string");
    const tests = await extractReporterTestsFromExecutionV1(root, check);
    expect((tests ?? []).some((t) => t.fullTitle.includes("alpha passing journey"))).toBe(true);
  });

  it("keeps distinct raw artifacts for command ids that sanitize identically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d19-collide-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "echo-a.mjs"), `await new Promise((r) => process.stdout.write("output-A", r));\nprocess.exit(0);\n`, "utf8");
    await fs.writeFile(path.join(root, "echo-b.mjs"), `await new Promise((r) => process.stdout.write("output-B", r));\nprocess.exit(0);\n`, "utf8");
    const first = await runValidationCommand(root, { id: "d19/a", command: `${process.execPath} echo-a.mjs`, required: true }, { config });
    const second = await runValidationCommand(root, { id: "d19-a", command: `${process.execPath} echo-b.mjs`, required: true }, { config });
    const firstRel = (first.details as Record<string, unknown>).rawArtifact as string;
    const secondRel = (second.details as Record<string, unknown>).rawArtifact as string;
    expect(typeof firstRel).toBe("string");
    expect(typeof secondRel).toBe("string");
    expect(secondRel).not.toBe(firstRel);
    await expect(fs.readFile(path.resolve(root, firstRel), "utf8")).resolves.toContain("output-A");
    await expect(fs.readFile(path.resolve(root, secondRel), "utf8")).resolves.toContain("output-B");
  });
});
