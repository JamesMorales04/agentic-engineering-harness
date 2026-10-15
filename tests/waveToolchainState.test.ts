import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWaveToolchainState } from "../src/agents/waveExecutor.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function makeRoot(withState: boolean): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-toolchain-"));
  roots.push(root);
  if (withState) {
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.state.json"),
      JSON.stringify({ version: 1, binPaths: ["/opt/pinned/bin"] }),
      "utf8"
    );
  }
  return root;
}

describe("materializeWaveToolchainState (per-unit toolchain propagation)", () => {
  it("copies the run root toolchain state byte-identical into the unit worktree", async () => {
    const root = await makeRoot(true);
    const worktree = await makeRoot(false);
    expect(await materializeWaveToolchainState(root, worktree)).toBe(true);
    const source = await fs.readFile(path.join(root, ".harness", "toolchain.state.json"), "utf8");
    const copied = await fs.readFile(path.join(worktree, ".harness", "toolchain.state.json"), "utf8");
    expect(copied).toBe(source);
  });

  it("is a no-op returning false when the run root has no toolchain state", async () => {
    const root = await makeRoot(false);
    const worktree = await makeRoot(false);
    expect(await materializeWaveToolchainState(root, worktree)).toBe(false);
    await expect(fs.access(path.join(worktree, ".harness", "toolchain.state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
