import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadResolvedAgentTopology } from "../src/agents/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("OpenCode Paseo topology capability", () => {
  it("declares nativeAgentViaPaseo for the orchestration preset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-opencode-paseo-cap-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness/agents.source.jsonc"),
      '{\n  "version": 1,\n  "extends": ["aeh:orchestration"],\n  "activeProfile": "balanced"\n}\n'
    );

    const topology = await loadResolvedAgentTopology(
      root,
      {
        version: 1,
        project: { name: "demo" },
        agents: {
          configPath: ".harness/agents.source.jsonc",
          activeProfile: "balanced"
        }
      } as never
    );

    expect(topology.runtimes.opencode.capabilities).toEqual(
      expect.objectContaining({
        nativeAgent: true,
        nativeAgentViaPaseo: true,
        modelSelection: true
      })
    );
  });
});
