import { describe, expect, it, vi } from "vitest";
import { buildPaseoBackgroundRunCommand, detectPaseoCapabilities, extractPaseoAgentId, isRecoverableDaemonStatus } from "../src/paseo/capabilities.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }

describe("Paseo capability negotiation", () => {
  it("does not pass --quiet to an older CLI that does not advertise it", async () => {
    const run = vi.fn(async (command: string) => {
      if (command === "paseo --version") return result(0, "paseo 0.3.1");
      if (command === "paseo run --help") return result(0, "Usage: paseo run [--background] [--title] [--provider] [--model]");
      if (command === "paseo daemon status --help") return result(0, "Usage: paseo daemon status");
      throw new Error(command);
    });
    const caps = await detectPaseoCapabilities("/repo", run as never);
    expect(caps.version).toBe("0.3.1");
    expect(caps.quiet).toBe(false);
    expect(caps.json).toBe(false);
    const command = buildPaseoBackgroundRunCommand({ title: "AEH", provider: "codex", model: "gpt-test", prompt: "hello" }, caps);
    expect(command).toContain("paseo run --background");
    expect(command).not.toContain("--quiet");
    expect(command).not.toContain("--json");
  });

  it("prefers machine-readable launch output when supported", () => {
    const command = buildPaseoBackgroundRunCommand({ title: "AEH", provider: "codex", prompt: "hello" }, { version: "0.6.0", background: true, quiet: true, json: true, outputSchema: true, daemonJson: true, nativeToolsRecommended: true });
    expect(command).toContain("--json");
    expect(command).not.toContain("--quiet");
    expect(extractPaseoAgentId('{"agent":{"id":"agent-json"}}')).toBe("agent-json");
    expect(extractPaseoAgentId("agent-plain\n")).toBe("agent-plain");
  });

  it("recognizes stale/unreachable daemons as recoverable startup state", () => {
    expect(isRecoverableDaemonStatus(result(1, "", "stale_pid / unreachable"))).toBe(true);
    expect(isRecoverableDaemonStatus(result(1, "", "permission denied"))).toBe(false);
  });
});
