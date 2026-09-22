import { describe, expect, it } from "vitest";
import {
  buildOpenCodeRuntimeConfig,
  compileOpenCodeRuntimeProjection,
  resolveOpenCodeAgentBinding,
  validateExecutionCapabilities
} from "../src/agents/permissions.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import { runDirectWorkerProcess } from "../src/workers/directProcess.js";

function selection(
  mcps: string[] = [],
  overrides: Partial<AgentExecutionSelection> = {}
): AgentExecutionSelection {
  return {
    logicalAgent: "worker",
    role: "implementer",
    domains: [],
    runtimeName: "opencode",
    runtimeAdapter: "opencode",
    paseoProvider: "opencode",
    modelAlias: "workhorse",
    modelId: "x/fast",
    modelName: "fast",
    transport: "direct",
    skills: ["backend"],
    mcps,
    permissions: {
      read: "allow",
      write: "allow",
      shell: "allow",
      network: "deny",
      delegate: "deny",
      gitWrite: "deny"
    },
    args: [],
    runtimeCapabilities: {},
    ...overrides
  };
}

describe("OpenCode permission projection", () => {
  it("runs direct workers with only safe and explicitly allowlisted environment", async () => {
    const previousSecret = process.env.AEH_DIRECT_TEST_SECRET;
    const previousAllowed = process.env.AEH_DIRECT_TEST_ALLOWED;
    process.env.AEH_DIRECT_TEST_SECRET = "ambient-secret";
    process.env.AEH_DIRECT_TEST_ALLOWED = "explicit-value";
    try {
      const config: HarnessProjectConfig = { version: 1, project: { name: "env-test" }, security: { sandbox: { environmentAllowlist: ["AEH_DIRECT_TEST_ALLOWED"] } } };
      const result = await runDirectWorkerProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify({secret:process.env.AEH_DIRECT_TEST_SECRET, allowed:process.env.AEH_DIRECT_TEST_ALLOWED, home:process.env.HOME}))"], config, { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 4096 });
      expect(result.exitCode).toBe(0);
      const childEnvironment = JSON.parse(result.stdout) as { secret?: string; allowed?: string; home?: string };
      expect(childEnvironment.secret).toBeUndefined();
      expect(childEnvironment.allowed).toBe("explicit-value");
      expect(result.stdout).toContain("home");
    } finally {
      if (previousSecret === undefined) delete process.env.AEH_DIRECT_TEST_SECRET; else process.env.AEH_DIRECT_TEST_SECRET = previousSecret;
      if (previousAllowed === undefined) delete process.env.AEH_DIRECT_TEST_ALLOWED; else process.env.AEH_DIRECT_TEST_ALLOWED = previousAllowed;
    }
  });

  it("projects Harness deny/allow decisions into runtime permission config", () => {
    const config = buildOpenCodeRuntimeConfig(selection()) as {
      permission: Record<string, unknown>;
    };
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
      mcp: {
        servers: {
          context7: {
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            enabled: true
          },
          github: {
            type: "local",
            command: ["github-mcp"],
            environment: { GITHUB_READ_ONLY: "1" },
            enabled: true
          },
          sentry: {
            type: "remote",
            url: "https://mcp.sentry.dev/mcp",
            enabled: false
          }
        }
      }
    };
    const config = buildOpenCodeRuntimeConfig(selection(["context7"]), project) as {
      mcp: Record<string, unknown>;
      tools: Record<string, boolean>;
    };
    expect(Object.keys(config.mcp)).toEqual(["context7"]);
    expect(config.tools["context7_*"]).toBe(true);
    expect(config.tools["github_*"]).toBe(false);
    expect(config.tools["sentry_*"]).toBe(false);
  });

  it("creates a deterministic primary OpenCode agent when AEH has no explicit nativeAgent", () => {
    const selected = selection([], {
      logicalAgent: "code-quality-reviewer",
      role: "reviewer",
      description: "Review bounded code quality findings.",
      modelId: "opencode-go/deepseek-v4-flash",
      modelName: "deepseek-v4-flash",
      variant: "high",
      permissions: {
        read: "allow",
        write: "deny",
        shell: "allow",
        network: "deny",
        delegate: "deny",
        review: "allow",
        gitWrite: "deny"
      }
    });
    const binding = resolveOpenCodeAgentBinding(selected);
    const config = buildOpenCodeRuntimeConfig(selected) as {
      default_agent: string;
      agent: Record<string, Record<string, unknown>>;
    };

    expect(binding).toEqual({
      agentId: "aeh-code-quality-reviewer",
      source: "aeh-managed",
      managed: true
    });
    expect(config.default_agent).toBe(binding.agentId);
    expect(config.agent[binding.agentId]).toEqual(
      expect.objectContaining({
        mode: "primary",
        model: "opencode-go/deepseek-v4-flash",
        variant: "high",
        description: "Review bounded code quality findings.",
        permission: expect.objectContaining({ edit: "deny", read: "allow" })
      })
    );
  });

  it("preserves an explicitly configured OpenCode native agent instead of synthesizing another", () => {
    const selected = selection([], {
      logicalAgent: "explorer",
      nativeAgent: "project-explorer"
    });
    const projection = compileOpenCodeRuntimeProjection(selected);
    expect(projection.binding).toEqual({
      agentId: "project-explorer",
      source: "explicit",
      managed: false
    });
    expect(projection.config).not.toHaveProperty("agent");
    expect(projection.config).not.toHaveProperty("default_agent");
  });

  it("recognizes OpenCode native-agent selection through the implemented Paseo mode bridge", () => {
    const selected = selection([], {
      nativeAgent: "project-explorer",
      transport: "paseo",
      runtimeCapabilities: {
        nativeAgent: true,
        nativeAgentViaPaseo: false,
        modelSelection: true
      }
    });
    expect(validateExecutionCapabilities(selected, "paseo")).toEqual([]);
  });

  it("puts the exact managed config into OPENCODE_CONFIG_CONTENT", () => {
    const projection = compileOpenCodeRuntimeProjection(selection());
    expect(JSON.parse(projection.env.OPENCODE_CONFIG_CONTENT)).toEqual(projection.config);
    expect(projection.binding.agentId).toBe("aeh-worker");
  });

  it("keeps generated identities collision-resistant when names require normalization", () => {
    const first = resolveOpenCodeAgentBinding(
      selection([], { logicalAgent: "Reviewer A/B" })
    ).agentId;
    const second = resolveOpenCodeAgentBinding(
      selection([], { logicalAgent: "Reviewer A B" })
    ).agentId;
    expect(first).toMatch(/^aeh-reviewer-a-b-[a-f0-9]{8}$/);
    expect(second).toMatch(/^aeh-reviewer-a-b-[a-f0-9]{8}$/);
    expect(first).not.toBe(second);
  });
});
