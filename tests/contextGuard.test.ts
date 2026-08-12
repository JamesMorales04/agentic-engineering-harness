import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { extractContextUsage, guardLeadContext } from "../src/paseo/context.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }

const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { interactive: { stateDir: ".harness/paseo", context: { pressureThreshold: 0.7, handoffThreshold: 0.8, hardHandoffThreshold: 0.9 } } }
} as unknown as HarnessProjectConfig;

describe("Paseo lead context guard", () => {
  it("extracts token-based and explicit context ratios", () => {
    expect(extractContextUsage({ contextTokens: 80_000, contextWindow: 100_000 }).ratio).toBe(0.8);
    expect(extractContextUsage({ contextPercent: 83 }).ratio).toBe(0.83);
  });

  it("writes a deterministic handoff artifact at the proactive threshold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-"));
    await fs.mkdir(path.join(root, ".harness/audits"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness/audits/latest.json"), "{}\n");
    const run = vi.fn(async (command: string) => {
      if (command === "paseo ls -a -g --json") return result(0, JSON.stringify([{ id: "lead-1", contextPercent: 82 }]));
      if (command === "git branch --show-current") return result(0, "main\n");
      throw new Error(`unexpected: ${command}`);
    });
    const guarded = await guardLeadContext(root, config, "lead-1", { brief: "Continue task READABILITY-1", run: run as never });
    expect(guarded.state).toBe("HANDOFF_REQUIRED");
    expect(guarded.handoffPath).toBeTruthy();
    const artifact = JSON.parse(await fs.readFile(guarded.handoffPath!, "utf8")) as { previousAgentId: string; branch: string; semanticBrief: string; latestAudit: string };
    expect(artifact.previousAgentId).toBe("lead-1");
    expect(artifact.branch).toBe("main");
    expect(artifact.semanticBrief).toContain("READABILITY-1");
    expect(artifact.latestAudit).toBe(".harness/audits/latest.json");
  });
});
