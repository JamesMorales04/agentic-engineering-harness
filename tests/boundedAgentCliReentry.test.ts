import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const main = path.join(root, "src", "main.ts");
const boundedEnv = {
  ...process.env,
  PASEO_AGENT_ID: "architecture-reviewer-session",
  AEH_MANAGED_AGENT: "1",
  AEH_LOGICAL_AGENT: "architecture-reviewer",
  AEH_AGENT_ROLE: "reviewer",
  AEH_INTERACTIVE_LEAD: "0",
  AEH_ORCHESTRATION_ALLOWED: "0",
  AEH_PARENT_OPERATION_ID: "AUDIT-REGRESSION",
  AEH_PARENT_OPERATION_KIND: "audit",
  AEH_AGENT_PHASE: "review"
};

describe("bounded-agent CLI reentry guard", () => {
  it("makes the exact architecture-reviewer audit --help invocation side-effect free", () => {
    const result = spawnSync(tsx, [main, "audit", "--help"], {
      cwd: root,
      env: boundedEnv,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: aeh audit <request>");
    expect(result.stdout).not.toContain("interactivePromotion=detached-audit");
    expect(result.stderr).not.toContain("Unknown option --help");
    expect(result.stderr).not.toContain("AEH_RECURSIVE_OPERATION_DENIED");
  });

  it("fails closed before a bounded reviewer can recursively start another audit", () => {
    const result = spawnSync(tsx, [main, "audit", "review the repository again"], {
      cwd: root,
      env: boundedEnv,
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("AEH_RECURSIVE_OPERATION_DENIED");
    expect(`${result.stdout}\n${result.stderr}`).toContain("architecture-reviewer");
    expect(`${result.stdout}\n${result.stderr}`).toContain("AUDIT-REGRESSION");
    expect(result.stdout).not.toContain("interactivePromotion=detached-audit");
  });
});
