import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContextAgentIdentity } from "../src/operations/mcp.js";
import { PASEO_BOOTSTRAP_VERSION } from "../src/paseo/start.js";
import { VERSION } from "../src/version.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function project(stateDir = ".harness/paseo") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-mcp-identity-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness/project.yaml"),
    [
      "version: 1",
      "project:",
      "  name: demo",
      "orchestration:",
      "  provider: paseo",
      "  interactive:",
      `    stateDir: ${stateDir}`,
      ""
    ].join("\n")
  );
  return root;
}

async function writeLeadState(root: string, overrides: Record<string, unknown> = {}, stateDir = ".harness/paseo") {
  const dir = path.resolve(root, stateDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "lead-session.json"),
    `${JSON.stringify({
      version: 2,
      bootstrapVersion: PASEO_BOOTSTRAP_VERSION,
      aehVersion: VERSION,
      aehCommand: "aeh",
      projectRoot: root,
      projectName: "demo",
      agentId: "lead-from-state",
      title: "AEH Lead",
      leadAgent: "lead",
      provider: "codex",
      model: "gpt-test",
      createdAt: new Date().toISOString(),
      generation: 1,
      ...overrides
    }, null, 2)}\n`
  );
}

describe("aeh_context_status identity", () => {
  it("prefers an explicit agent id over environment and durable state", async () => {
    const root = await project();
    await writeLeadState(root);
    await expect(resolveContextAgentIdentity(root, "explicit-agent", { PASEO_AGENT_ID: "env-agent" }))
      .resolves.toEqual({ agentId: "explicit-agent", source: "argument" });
  });

  it("prefers PASEO_AGENT_ID over durable state", async () => {
    const root = await project();
    await writeLeadState(root);
    await expect(resolveContextAgentIdentity(root, undefined, { PASEO_AGENT_ID: "env-agent" }))
      .resolves.toEqual({ agentId: "env-agent", source: "environment" });
  });

  it("resolves the managed lead from durable state when the MCP environment lacks PASEO_AGENT_ID", async () => {
    const root = await project();
    await writeLeadState(root);
    await expect(resolveContextAgentIdentity(root, undefined, {}))
      .resolves.toEqual({ agentId: "lead-from-state", source: "lead-state" });
  });

  it("respects a configured Paseo stateDir", async () => {
    const stateDir = ".state/custom-paseo";
    const root = await project(stateDir);
    await writeLeadState(root, {}, stateDir);
    await expect(resolveContextAgentIdentity(root, undefined, {}))
      .resolves.toEqual({ agentId: "lead-from-state", source: "lead-state" });
  });

  it("rejects durable state from another project root", async () => {
    const root = await project();
    await writeLeadState(root, { projectRoot: "/tmp/not-this-project" });
    await expect(resolveContextAgentIdentity(root, undefined, {})).rejects.toThrow("project root does not match AEH_CONTROL_ROOT");
  });

  it("rejects stale bootstrap/runtime identity instead of guessing another agent", async () => {
    const root = await project();
    await writeLeadState(root, { bootstrapVersion: PASEO_BOOTSTRAP_VERSION - 1, aehVersion: "0.0.0" });
    await expect(resolveContextAgentIdentity(root, undefined, {})).rejects.toThrow("refused incompatible durable lead state");
  });

  it("fails closed when neither environment nor compatible durable state exists", async () => {
    const root = await project();
    await expect(resolveContextAgentIdentity(root, undefined, {})).rejects.toThrow("could not resolve the current managed lead agent");
  });
});
