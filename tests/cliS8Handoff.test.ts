import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(".");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const main = path.join(root, "src", "main.ts");
const cliEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(AEH_|PASEO_|GH_TOKEN$|GITHUB_TOKEN$)/.test(key)
  )
) as Record<string, string>;
const temporaryRoots: string[] = [];

async function createTemporaryProjectDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s8-sdd-handoff-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("aeh sdd handoff unsupported/deferred CLI surface", () => {
  it("documents standalone handoff as unsupported and controller-owned instead of promising publication", () => {
    const result = spawnSync(tsx, [main, "sdd", "--help"], { cwd: root, env: cliEnv, encoding: "utf8" });
    expect(result.status).toBe(0);
    const help = `${result.stdout}${result.stderr}`.replace(/\s+/g, " ");
    expect(help).toMatch(/handoff <taskId> \[directory\] .*(?:unsupported|deferred)/i);
    expect(help).toMatch(/controller-owned|managed operation/i);
    expect(help).not.toMatch(/publish a validated\/sealed task/i);
    expect(help).not.toMatch(/github issue\/branch/i);
    expect(help).not.toMatch(/paseo worktree delivery flow/i);
  }, 60_000);

  it("fails before project loading with SDD_HANDOFF_UNSUPPORTED and leaves the target directory unchanged", async () => {
    const directory = await createTemporaryProjectDirectory();
    const before = await fs.readdir(directory, { recursive: true });
    const result = spawnSync(tsx, [main, "sdd", "handoff", "T-1", directory], { cwd: root, env: cliEnv, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("SDD_HANDOFF_UNSUPPORTED");
    expect(output).toMatch(/acceptanceoracle/i);
    expect(output).toMatch(/policy gates/i);
    expect(output).not.toMatch(/project\.yaml|ENOENT/i);
    expect(result.stdout.trim()).toBe("");
    const after = await fs.readdir(directory, { recursive: true });
    expect(after).toStrictEqual(before);
    expect(after).toStrictEqual([]);
    await expect(fs.stat(path.join(directory, ".harness"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
