import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd());
const entry = path.join(repositoryRoot, "dist", "main.js");

async function cli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, [entry, ...args], { cwd, env: { ...process.env, AEH_PASEO_FORCE_CLI: "1" } });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
}

describe("AEH human-instruction black-box entry", () => {
  it("routes natural-language informational, audit, and change prompts through the built CLI", async () => {
    await fs.access(entry);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-black-box-"));
    try {
      expect((await cli(["init", root], repositoryRoot)).code).toBe(0);
      const informational = await cli(["intent", "Explain how the validation system works.", root], repositoryRoot);
      const audit = await cli(["intent", "Review this repository for important problems.", root], repositoryRoot);
      const change = await cli(["intent", "Fix the bug in add() and add tests.", root, "--file", "src/add.ts"], repositoryRoot);
      expect(informational.stdout).toContain("INFORMATIONAL");
      expect(audit.stdout).toContain("AUDIT");
      expect(change.stdout).toContain("CHANGE/");
      expect(JSON.parse(informational.stdout.slice(informational.stdout.indexOf("{"))).intent).toBe("informational");
      expect(JSON.parse(audit.stdout.slice(audit.stdout.indexOf("{"))).intent).toBe("audit");
      expect(JSON.parse(change.stdout.slice(change.stdout.indexOf("{"))).intent).toBe("change");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("enters the real aeh start bootstrap and fails truthfully when managed Paseo prerequisites are absent", async () => {
    await fs.access(entry);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-start-"));
    try {
      expect((await cli(["init", root], repositoryRoot)).code).toBe(0);
      const result = await cli(["start", "--no-setup", "--no-web-ui", root], repositoryRoot);
      if (result.code === 0) {
        await expect(fs.access(path.join(root, ".harness", "paseo", "lead-session.json"))).resolves.toBeUndefined();
        expect(result.stdout).toContain("AEH Paseo ready");
      } else {
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/managed commands are unavailable|Paseo SDK is required|cannot launch Paseo/i);
        expect(await fs.readdir(path.join(root, ".harness", "operations"))).toEqual([]);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
