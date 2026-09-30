import { afterEach, describe, expect, it } from "vitest";
import { buildOpenCodeRuntimeConfig } from "../src/agents/permissions.js";
import { managedSerenaPool, SerenaPoolOwnershipError } from "../src/runtime/serenaPool.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";

/**
 * Formal lane r16-formal-3 regression: the OpenCode inline Serena projection resolved a relative
 * `--project .` against the controller cwd, so every isolated wave worktree shared one Serena pool
 * entry. A completed wave implementer's writer lease then blocked the next wave's implementer with
 * `SerenaPoolOwnershipError`. The projection must key the pool by the actual launch root.
 */

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "serena-keying" },
  context: { semanticRetrieval: { provider: "serena", required: false } }
};

function selection(logicalAgent: string): AgentExecutionSelection {
  return {
    logicalAgent,
    role: "Implementer",
    domains: [],
    runtimeName: "opencode",
    runtimeAdapter: "opencode",
    paseoProvider: "opencode",
    modelAlias: "workhorse",
    modelId: "x/fast",
    modelName: "fast",
    transport: "paseo",
    skills: [],
    mcps: [],
    permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", review: "deny", validate: "deny", gitWrite: "deny" },
    args: [],
    runtimeCapabilities: {}
  };
}

afterEach(() => {
  for (const session of managedSerenaPool.snapshot()) managedSerenaPool.release(session.sessionId, session.ownerId);
});

describe("Serena pool launch-root keying", () => {
  it("keys the pool by the launch root so sequential wave writers do not conflict", () => {
    const waveA = buildOpenCodeRuntimeConfig(selection("participant:wave-a"), config, undefined, undefined, undefined, "/tmp/aeh-wave-a");
    const waveB = buildOpenCodeRuntimeConfig(selection("participant:wave-b"), config, undefined, undefined, undefined, "/tmp/aeh-wave-b");
    const serenaA = (waveA.mcp as Record<string, { environment?: Record<string, string> }>).serena;
    const serenaB = (waveB.mcp as Record<string, { environment?: Record<string, string> }>).serena;
    expect(serenaA?.environment?.AEH_SERENA_ROOT).toBe("/tmp/aeh-wave-a");
    expect(serenaB?.environment?.AEH_SERENA_ROOT).toBe("/tmp/aeh-wave-b");
    expect(serenaA?.environment?.AEH_SERENA_POOL_SOCKET).not.toBe(serenaB?.environment?.AEH_SERENA_POOL_SOCKET);
  });

  it("treats the inline projection and the Paseo MCP projection of one launch as one owner", () => {
    const owner = "CHANGE-1:participant:greeting-export";
    const inline = buildOpenCodeRuntimeConfig(selection("participant:greeting-export"), config, undefined, undefined, undefined, "/tmp/aeh-wave-owner", owner);
    const paseo = buildOpenCodeRuntimeConfig(selection("participant:greeting-export"), config, undefined, undefined, undefined, "/tmp/aeh-wave-owner", owner);
    expect((inline.mcp as Record<string, { environment?: Record<string, string> }>).serena?.environment?.AEH_SERENA_ROOT).toBe("/tmp/aeh-wave-owner");
    expect((paseo.mcp as Record<string, { environment?: Record<string, string> }>).serena?.environment?.AEH_SERENA_ROOT).toBe("/tmp/aeh-wave-owner");
  });

  it("still fails closed for two concurrent writers on the same launch root", () => {
    buildOpenCodeRuntimeConfig(selection("participant:writer-a"), config, undefined, undefined, undefined, "/tmp/aeh-wave-shared");
    expect(() => buildOpenCodeRuntimeConfig(selection("participant:writer-b"), config, undefined, undefined, undefined, "/tmp/aeh-wave-shared"))
      .toThrow(SerenaPoolOwnershipError);
  });
});
