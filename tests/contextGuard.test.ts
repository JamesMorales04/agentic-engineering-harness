import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { extractContextUsage, guardLeadContext, statusLeadContext } from "../src/paseo/context.js";
import type { PaseoNativeAgentSnapshot } from "../src/paseo/native.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }

const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { provider: "paseo", interactive: { stateDir: ".harness/paseo", context: { pressureThreshold: 0.7, handoffThreshold: 0.8, hardHandoffThreshold: 0.9 } } }
} as unknown as HarnessProjectConfig;

function snapshot(id: string, used?: number, limit?: number): PaseoNativeAgentSnapshot {
  return {
    id,
    status: "idle",
    lastUsage: used === undefined && limit === undefined ? undefined : { contextWindowUsedTokens: used, contextWindowMaxTokens: limit },
    raw: { id }
  };
}

const trace = vi.fn(async () => undefined);

describe("Paseo lead context guard", () => {
  it("extracts only canonical AgentUsage context fields", () => {
    expect(extractContextUsage({ lastUsage: { contextWindowUsedTokens: 80_000, contextWindowMaxTokens: 100_000 } }).ratio).toBe(0.8);
    expect(extractContextUsage({ inputTokens: 83_000, maxTokens: 100_000 }).ratio).toBeUndefined();
    expect(extractContextUsage({ inputTokens: 83_000, maxTokens: 100_000 }).availability).toBe("no-usage-yet");
  });

  it("distinguishes no usage yet from provider usage unavailable", async () => {
    const noUsage = await statusLeadContext("/repo", config, "lead-1", {
      inspect: vi.fn(async () => snapshot("lead-1")),
      trace
    });
    expect(noUsage.state).toBe("NO_USAGE_YET");

    const unavailable = await statusLeadContext("/repo", config, "lead-1", {
      inspect: vi.fn(async () => snapshot("lead-1", 42_000, undefined)),
      trace
    });
    expect(unavailable.state).toBe("USAGE_UNAVAILABLE");
  });

  it("evaluates pressure from Paseo AgentSnapshot lastUsage", async () => {
    const guarded = await statusLeadContext("/repo", config, "lead-1", {
      inspect: vi.fn(async () => snapshot("lead-1", 72_000, 100_000)),
      trace
    });
    expect(guarded.state).toBe("PRESSURE");
    expect(guarded.usage).toEqual(expect.objectContaining({ used: 72_000, limit: 100_000, ratio: 0.72, source: "paseo-agent-snapshot" }));
  });

  it("writes a deterministic handoff artifact at the proactive threshold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-"));
    await fs.mkdir(path.join(root, ".harness/audits"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness/audits/latest.json"), "{}\n");
    const run = vi.fn(async (command: string) => {
      if (command === "git branch --show-current") return result(0, "main\n");
      throw new Error(`unexpected: ${command}`);
    });
    const guarded = await guardLeadContext(root, config, "lead-1", {
      brief: "Continue task READABILITY-1",
      run: run as never,
      autoRotate: false,
      inspect: vi.fn(async () => snapshot("lead-1", 82_000, 100_000)),
      trace
    });
    expect(guarded.state).toBe("HANDOFF_REQUIRED");
    expect(guarded.handoffPath).toBeTruthy();
    const artifact = JSON.parse(await fs.readFile(guarded.handoffPath!, "utf8")) as { previousAgentId: string; branch: string; semanticBrief: string; latestAudit: string };
    expect(artifact.previousAgentId).toBe("lead-1");
    expect(artifact.branch).toBe("main");
    expect(artifact.semanticBrief).toContain("READABILITY-1");
    expect(artifact.latestAudit).toBe(".harness/audits/latest.json");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rotates responsibility to a fresh lead automatically when enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-context-rotate-"));
    const run = vi.fn(async (command: string) => {
      if (command === "git branch --show-current") return result(0, "feature/readability\n");
      throw new Error(`unexpected: ${command}`);
    });
    const start = vi.fn(async (_root: string, _config: HarnessProjectConfig, options: { forceNew?: boolean; resume?: boolean; handoffPath?: string; aehCommand?: string }) => ({
      daemonStarted: false,
      session: "created" as const,
      agentId: "lead-fresh",
      title: "AEH Lead",
      leadAgent: "lead",
      provider: "codex",
      model: "gpt-test",
      aehVersion: "test",
      aehCommand: options.aehCommand ?? "aeh",
      stateFile: path.join(root, ".harness/paseo/lead-session.json"),
      bootstrapFile: path.join(root, ".harness/paseo/lead-bootstrap.md")
    }));
    const guarded = await guardLeadContext(root, config, "lead-old", {
      brief: "Continue sealed task READABILITY-1",
      run: run as never,
      start: start as never,
      autoRotate: true,
      aehCommand: "node /pkg/dist/main.js",
      inspect: vi.fn(async () => snapshot("lead-old", 91_000, 100_000)),
      trace
    });
    expect(guarded.state).toBe("HARD_HANDOFF");
    expect(guarded.rotatedAgentId).toBe("lead-fresh");
    expect(start).toHaveBeenCalledWith(root, config, expect.objectContaining({ forceNew: true, resume: false, aehCommand: "node /pkg/dist/main.js", handoffPath: expect.stringContaining(".harness/paseo/handoffs/") }));
    const artifact = JSON.parse(await fs.readFile(guarded.handoffPath!, "utf8")) as { previousAgentId: string; rotatedAgentId: string; branch: string };
    expect(artifact.previousAgentId).toBe("lead-old");
    expect(artifact.rotatedAgentId).toBe("lead-fresh");
    expect(artifact.branch).toBe("feature/readability");
  });
});
