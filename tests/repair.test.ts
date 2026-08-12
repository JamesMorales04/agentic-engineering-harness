import { describe, expect, it } from "vitest";
import { createRepairPacket } from "../src/core/repair.js";
import type { ValidationReport } from "../src/core/types.js";

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
});
