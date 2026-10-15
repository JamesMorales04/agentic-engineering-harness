import { describe, expect, it } from "vitest";
import { createRepairPacket } from "../src/core/repair.js";
import type { ValidationReport } from "../src/core/types.js";
import { buildRepairPrompt, projectRepairFailureEvidence } from "../src/workers/prompt.js";

describe("repair packets", () => {
  it("contains only deterministic failures", () => {
    const report: ValidationReport = {
      version: 1,
      taskId: "T-1",
      status: "FAIL",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      changedFiles: ["src/a.ts"],
      metadata: { project: "test", baseRef: "main" },
      checks: [
        { id: "build", category: "build", status: "PASS", message: "ok" },
        { id: "acceptance", category: "acceptance", status: "FAIL", message: "scenario failed", details: { scenario: "A" } },
        { id: "optional", category: "security", status: "WARN", message: "tool unavailable" }
      ]
    };
    const packet = createRepairPacket(report, 1);
    expect(packet.failures).toHaveLength(1);
    expect(packet.failures[0]).toMatchObject({ id: "acceptance", category: "acceptance", message: "scenario failed" });
  });

  it("bounds unbounded failure transcripts while keeping id, message and report pointer", () => {
    const transcript = `TRANS-START\n${"x".repeat(400_000)}\nTRANS-END marker-tail-42`;
    const packet = createRepairPacket({
      version: 1, taskId: "T-2", status: "FAIL",
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
      changedFiles: [], metadata: {},
      checks: [{ id: "build", category: "build", status: "FAIL", message: "build broke", details: { stdout: transcript } }],
    }, 2, { reportArtifact: ".harness/reports/T-2.json" });
    expect(packet.reportArtifact).toBe(".harness/reports/T-2.json");
    const prompt = buildRepairPrompt(packet);
    // Bounded: a 400k transcript must not inflate the prompt.
    expect(prompt.length).toBeLessThan(8_000);
    // Complete: id, message, head, tail and pointer survive.
    expect(prompt).toContain("build broke");
    expect(prompt).toContain("TRANS-START");
    expect(prompt).toContain("marker-tail-42");
    expect(prompt).toContain("omitted");
    expect(prompt).toContain(".harness/reports/T-2.json");
  });

  it("renders small failure details whole", () => {
    expect(projectRepairFailureEvidence({ scenario: "A" })).toBe(JSON.stringify({ scenario: "A" }));
  });

  it("bounds the whole prompt across many failures and long messages", () => {
    const checks = Array.from({ length: 25 }, (_, index) => ({
      id: `check-${index}`, category: "build", status: "FAIL" as const,
      message: `failure ${index} ` + "m".repeat(2_000),
      details: { out: "y".repeat(5_000) },
    }));
    const packet = createRepairPacket({
      version: 1, taskId: "T-3", status: "FAIL",
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
      changedFiles: [], metadata: {}, checks,
    }, 1, { reportArtifact: ".harness/reports/T-3.json" });
    const prompt = buildRepairPrompt(packet);
    expect(prompt.length).toBeLessThan(30_000);
    expect(prompt).toContain("check-0");
    expect(prompt).toContain("check-9");
    expect(prompt).not.toContain("check-10");
    expect(prompt).toContain("15 more failure(s)");
    expect(prompt).toContain(".harness/reports/T-3.json");
  });

  it("never splits astral Unicode characters in excerpts", () => {
    const emoji = "🚀";
    const details = { out: `HEAD-${emoji}` + "z".repeat(5_000) + `${emoji}-TAIL` };
    const excerpt = projectRepairFailureEvidence(details);
    expect(excerpt).toContain(`HEAD-${emoji}`);
    expect(excerpt).toContain(`${emoji}-TAIL`);
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
    expect(Array.from(excerpt).join("")).toBe(excerpt);
  });

  it("caps unbounded check ids and categories", () => {
    const packet = createRepairPacket({
      version: 1, taskId: "T-4", status: "FAIL",
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
      changedFiles: [], metadata: {},
      checks: [{ id: `id-${"i".repeat(600)}`, category: `cat-${"c".repeat(600)}`, status: "FAIL", message: "broke" }],
    }, 1, { reportArtifact: ".harness/reports/T-4.json" });
    const prompt = buildRepairPrompt(packet);
    expect(prompt).not.toContain("i".repeat(600));
    expect(prompt).not.toContain("c".repeat(600));
    expect(prompt).toContain("broke");
  });

  it("holds a hard whole-prompt ceiling under adversarial packet shapes", () => {
    const big = "X".repeat(50_000);
    const checks = Array.from({ length: 25 }, (_, index) => ({
      id: `check-${index}-${"i".repeat(1_000)}`, category: `cat-${"c".repeat(1_000)}`,
      status: "FAIL" as const, message: `m-${index}-` + "m".repeat(5_000),
      details: { stdout: big, nested: { deep: [big, big] } },
    }));
    const packet = createRepairPacket({
      version: 1, taskId: `T-ADV-${"t".repeat(1_000)}`, status: "FAIL",
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
      changedFiles: [], metadata: {}, checks,
    }, 3, { reportArtifact: ".harness/reports/T-ADV.json" });
    const prompt = buildRepairPrompt(packet);
    // Worst case: 10 failures x (200 id + 200 cat + 500 msg + ~1500 evidence)
    // plus header/pointer — must stay far below participant budgets.
    expect(prompt.length).toBeLessThan(30_000);
    expect(prompt).toContain("15 more failure(s)");
    expect(prompt).toContain(".harness/reports/T-ADV.json");
  });
});
