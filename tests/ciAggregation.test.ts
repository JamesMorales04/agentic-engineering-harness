import fs from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// K-NEW-1: every release commit carried `[skip ci]`, so ci.yml never ran on
// the exact published bits. K-NEW-6 (sibling): no all-green aggregator and
// evidence uploads used `if-no-files-found: ignore`.
const REQUIRED_CI_JOBS = [
  "test",
  "packaged-consumer",
  "scenario-matrix",
  "adversarial-system",
  "human-e2e",
  "system-reliability",
  "rootless-isolation",
  "full-stack-contract",
  "provider-contracts",
  "supply-chain",
  "validation-contracts",
  "contract-testing",
  "integration-environment",
];

describe("release CI gating (K-NEW-1 / K-NEW-6)", () => {
  it("release commit message contains no [skip ci]", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const steps = workflow.jobs.publish.steps as Array<{ name?: string; run?: string }>;
    const commitStep = steps.find((step) => step.name === "Commit version and create tag");
    expect(commitStep).toBeDefined();
    expect(commitStep?.run).not.toContain("[skip ci]");
    expect(text).not.toContain("[skip ci]");
  });

  it("ci.yml has an all-green aggregator over every job with fail-on-any", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const allGreen = workflow.jobs["all-green"] as
      | { if?: string; needs?: string[]; steps?: Array<unknown> }
      | undefined;
    expect(allGreen).toBeDefined();
    expect(allGreen?.if).toContain("always()");
    for (const job of REQUIRED_CI_JOBS) {
      expect(allGreen?.needs).toContain(job);
    }
    expect(allGreen?.needs).toHaveLength(REQUIRED_CI_JOBS.length);
    expect(JSON.stringify(allGreen)).toContain("failure");
  });

  it("evidence uploads fail loudly on missing files (no ignore)", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(text).not.toContain("if-no-files-found: ignore");
    const values = [...text.matchAll(/if-no-files-found:\s*(\S+)/g)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBe("error");
    }
  });
});
