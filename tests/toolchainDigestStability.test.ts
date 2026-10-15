import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { setupToolchain } from "../src/toolchain/setup.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function miseAvailable(): boolean {
  try {
    execFileSync("mise", ["--version"], { timeout: 15_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function gitStatusPorcelain(cwd: string): Promise<string> {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", timeout: 30_000 });
}

/**
 * L5 CANDIDATE_WORKSPACE_MISMATCH regression (DETERMINISTIC when mise is
 * present; skipped otherwise): toolchain provisioning inside a pristine
 * execution workspace must not mutate tracked candidate source. The
 * controller binds the workspace candidate AFTER provisioning, and the
 * committed mise lock state must already be complete, so a later
 * validation-time setup is a content no-op and the verify-time identity
 * check observes exactly the bound tree.
 */
describe.skipIf(!miseAvailable())("toolchain digest stability", () => {
  it("leaves tracked candidate source untouched in a pristine worktree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-toolchain-stability-"));
    await fs.rm(dir, { recursive: true, force: true });
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", dir], { timeout: 120_000, stdio: "ignore" });
    try {
      const before = await computeWorktreeDigest(dir);
      expect(await gitStatusPorcelain(dir)).toBe("");
      const config = await loadProjectConfig(dir);
      await setupToolchain(dir, config, { skipProjectDependencies: true });
      // Only ignored files may appear; the tracked tree must be byte-identical.
      expect(await gitStatusPorcelain(dir)).toBe("");
      expect(await computeWorktreeDigest(dir)).toBe(before);
    } finally {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], { timeout: 120_000, stdio: "ignore" });
    }
  }, 600_000);
});
