import { describe, expect, it } from "vitest";
import { buildOpenCodeRuntimeConfig } from "../src/agents/permissions.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";

function selection(mcps: string[] = []): AgentExecutionSelection { return { logicalAgent: "worker", role: "implementer", domains: [], runtimeName: "opencode", runtimeAdapter: "opencode", paseoProvider: "opencode", modelAlias: "workhorse", modelId: "x/fast", modelName: "fast", transport: "direct", skills: ["backend"], mcps, permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", gitWrite: "deny" }, args: [], runtimeCapabilities: {} }; }

describe("OpenCode permission projection", () => {
  it("projects Harness deny/allow decisions into runtime permission config", () => {
    const config = buildOpenCodeRuntimeConfig(selection()) as { permission: Record<string, unknown> };
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.websearch).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.bash).toMatchObject({ "*": "allow", "git push *": "deny" });
    expect(config.permission.skill).toMatchObject({ "*": "deny", backend: "allow" });
  });

  it("injects only MCP servers granted to the selected agent", () => {
    const project: HarnessProjectConfig = {
      version: 1,
      project: { name: "mcp-test" },
      mcp: { servers: {
        context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
        github: { type: "local", command: ["github-mcp"], environment: { GITHUB_READ_ONLY: "1" }, enabled: true },
        sentry: { type: "remote", url: "https://mcp.sentry.dev/mcp", enabled: false }
      } }
    };
    const config = buildOpenCodeRuntimeConfig(selection(["context7"]), project) as { mcp: Record<string, unknown>; tools: Record<string, boolean> };
    expect(Object.keys(config.mcp)).toEqual(["context7"]);
    expect(config.tools["context7_*"]).toBe(true);
    expect(config.tools["github_*"]).toBe(false);
    expect(config.tools["sentry_*"]).toBe(false);
  });
});
