import fs from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// REPAIR TRUST (Luna blocker): repair must not trust tag-at-R as proof
// verify passed. A manually created (or pre-redesign legacy) tag at R
// authorizes a Release with verify-published skipped. The repair path must
// EXECUTE verification for R: verify-published runs for repair, and the
// repair Release job needs verify's success for R. No Release without
// either (i) verify-published success for R in the current run, or
// (ii) a persisted verify-PASS artifact bound to R (none exists in
// publish.yml — hence re-run-verify).
describe("repair requires verification evidence for R (no tag-trust)", () => {
  it("verify-published runs for the repair path, not only when should_publish", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const verifyJob = (workflow.jobs as Record<string, any>)["verify-published"];
    expect(verifyJob).toBeDefined();
    const condition = String(verifyJob.if ?? "");
    // Must still run for the normal path ...
    expect(condition).toContain("should_publish");
    // ... AND for the repair path (manual dispatch bump=current with no publish).
    // A condition gated solely on should_publish == 'true' leaves repair unverified.
    expect(condition).toMatch(/workflow_dispatch|inputs\.bump|repair/i);
    expect(condition).not.toMatch(/^\s*needs\.publish\.outputs\.should_publish == 'true'\s*$/);
  });

  it("repair Release is unreachable with verify-published skipped", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const entries = Object.entries(jobs) as Array<[string, any]>;
    const verifyName = Object.keys(jobs).find((name) => /verify/i.test(name));
    expect(verifyName).toBeDefined();
    const repair = entries.find(([name]) => /repair/i.test(name) && JSON.stringify(jobs[name]).includes("gh release create"));
    expect(repair).toBeDefined();
    const [, repairJob] = repair!;
    const needs = Array.isArray(repairJob.needs) ? repairJob.needs : repairJob.needs ? [repairJob.needs] : [];
    expect(needs).toContain(verifyName);
    // always() lets the job run when a needed job was skipped — the exact bypass.
    expect(String(repairJob.if ?? "")).not.toContain("always()");
    // The repair condition must chain on verify success for R in this run.
    expect(String(repairJob.if ?? "")).toMatch(/verify-published.*\.result\s*==\s*'success'/);
  });

  it("repair verification binds R by SHA before any Release", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const verifyJob = (workflow.jobs as Record<string, any>)["verify-published"];
    const serialized = JSON.stringify(verifyJob.steps ?? verifyJob);
    // Repair leg must resolve R with tag==HEAD SHA binding (never bare tag trust) ...
    expect(serialized).toMatch(/ls-remote|TAG_SHA|rev-list/);
    // ... and still execute real verification (packaged-consumer contracts).
    expect(serialized).toContain("test:packaged-consumer");
  });
});
