import { describe, expect, it } from "vitest";
import { buildAehControlMcp, buildPaseoLeadBootstrap } from "../src/paseo/start.js";

describe("thin lead bootstrap policy", () => {
  it("makes healthy detached operations interrupt-driven instead of polled", () => {
    const bootstrap = buildPaseoLeadBootstrap("demo", "/repo", "aeh");
    expect(bootstrap).toContain("thin portfolio orchestrator");
    expect(bootstrap).toContain("interrupt-driven");
    expect(bootstrap).toContain("return idle");
    expect(bootstrap).toContain("do not poll");
    expect(bootstrap).toContain("Healthy revisions are controller-owned");
    expect(bootstrap).toContain("aeh_operation_digest");
    expect(bootstrap).toContain("aeh_operation_ack");
    expect(bootstrap).toContain("Reading status never acknowledges a revision");
  });

  it("preapproves compact digest and exact acknowledgement tools", () => {
    const policy = buildAehControlMcp("aeh", "/repo").toolPolicy;
    expect(policy?.preapproved).toEqual(expect.arrayContaining([
      { kind: "mcp", server: "aeh-control", tool: "aeh_operation_digest" },
      { kind: "mcp", server: "aeh-control", tool: "aeh_operation_ack" }
    ]));
  });
});
