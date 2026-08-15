import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HUMAN_JOURNEY_IDS } from "./aehReliabilityInventory.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd());
const entry = path.join(repositoryRoot, "dist", "main.js");

const HUMAN_JOURNEYS = HUMAN_JOURNEY_IDS.map((id, index) => ({ id, prompt: ["Review the repository and report validation status.", "Perform a security-focused audit and preserve the evidence reference.", "Assess architecture closure and return a structured outcome.", "Check provider boundaries and state the validation result.", "Inspect context preservation and retrieval constraints.", "Exercise recovery-aware review and return the terminal outcome.", "Review delivery gates and report whether completion is safe.", "Review operation lifecycle truth and return its durable result.", "Check source lineage and provide the authoritative report reference.", "Review permission boundaries and return a structured validation result.", "Review concurrent operation handling and report the final state.", "Run a packaged consumer journey and return the completion evidence."][index]! }));

function structured(stdout: string): Record<string, any> {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`Expected structured JSON output, received: ${stdout}`);
  return JSON.parse(stdout.slice(start)) as Record<string, any>;
}

async function runDeterministicJourney(root: string, prompt: string): Promise<Record<string, any>> {
  expect((await cli(["init", root], repositoryRoot)).code).toBe(0);
  const start = await cli(["start", "--deterministic", root], repositoryRoot);
  expect(start.code).toBe(0);
  expect(start.stdout).toContain("sessionBoundary=deterministic-fake-paseo-sdk");
  const turn = await cli(["paseo", "turn", prompt, root, "--json"], repositoryRoot);
  expect(turn.code).toBe(0);
  return structured(turn.stdout);
}

async function cli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, [entry, ...args], { cwd, env: { ...process.env, AEH_PASEO_FORCE_CLI: "1" } });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
}

describe.sequential("AEH human-instruction black-box entry", () => {
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

  it.each(HUMAN_JOURNEYS)("completes deterministic human journey $id through the real start/turn/controller surface", async ({ prompt }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-journey-"));
    try {
      const result = await runDeterministicJourney(root, prompt);
      expect(result.version).toBe(1);
      expect(result.userTurn).toMatchObject({ prompt, accepted: true });
      expect(result.session.state).toBe("received-completion");
      expect(result.operation).toMatchObject({ kind: "audit", status: "SUCCEEDED", phase: "finished" });
      expect(result.validation.status).toBe("PASS");
      expect(result.completion).toMatchObject({ status: "SENT", agentId: result.session.agentId, attempts: 1 });
      expect(result.lead.wakeReceived).toBe(true);
      expect(result.lead.message).toContain(`[AEH_OPERATION_COMPLETED]`);
      expect(result.lead.message).toContain(result.operation.id);
      expect(result.operation.result.report).toMatch(/^\.harness\/audits\/.+\.json$/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves structured context referents and constraints across five multi-turn continuations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-human-multiturn-"));
    try {
      expect((await cli(["init", root], repositoryRoot)).code).toBe(0);
      expect((await cli(["start", "--deterministic", root], repositoryRoot)).code).toBe(0);
      const turns = ["first review", "second review", "third review", "fourth review", "fifth review"];
      const results: Record<string, any>[] = [];
      for (const prompt of turns) {
        const response = await cli(["paseo", "turn", prompt, root, "--json"], repositoryRoot);
        expect(response.code).toBe(0);
        results.push(structured(response.stdout));
      }
      expect(results.map((result) => result.session.turnCount)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(results.map((result) => result.operation.id)).size).toBe(5);
      const session = JSON.parse(await fs.readFile(path.join(root, ".harness", "paseo", "deterministic-session.json"), "utf8")) as { turns: Array<{ role: string; prompt?: string; content: string }> };
      expect(session.turns.filter((turn) => turn.role === "user").map((turn) => turn.prompt)).toEqual(turns);
      expect(session.turns.filter((turn) => turn.role === "system")).toHaveLength(5);
      const last = results.at(-1)!;
      expect(last.lead.message).toContain(last.operation.id);
      const report = JSON.parse(await fs.readFile(path.join(root, last.operation.result.report), "utf8")) as { validationChecks: Array<{ status: string; details?: { rawArtifact?: string } }> };
      expect(report.validationChecks[0]?.status).toBe("PASS");
      expect(report.validationChecks[0]?.details?.rawArtifact).toMatch(/^\.harness\/evidence\//);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("runs the packaged tarball through init, deterministic start, and a completed user turn", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-packaged-tarball-"));
    const consumer = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-packaged-consumer-"));
    try {
      const packed = await execFileAsync("npm", ["pack", "--silent", "--pack-destination", packageRoot], { cwd: repositoryRoot });
      const tarball = path.join(packageRoot, packed.stdout.trim().split(/\r?\n/).at(-1)!);
      await execFileAsync("tar", ["-xzf", tarball, "-C", consumer]);
      await fs.symlink(path.join(repositoryRoot, "node_modules"), path.join(consumer, "package", "node_modules"), "dir");
      const packagedEntry = path.join(consumer, "package", "dist", "main.js");
      const run = async (args: string[]) => execFileAsync(process.execPath, [packagedEntry, ...args], { cwd: consumer, env: { ...process.env, AEH_PASEO_FORCE_CLI: "1" } });
      await run(["init", consumer]);
      const start = await run(["start", "--deterministic", consumer]);
      expect(start.stdout).toContain("sessionBoundary=deterministic-fake-paseo-sdk");
      const turn = await run(["paseo", "turn", "Packaged consumer validation", consumer, "--json"]);
      const result = structured(turn.stdout);
      expect(result.operation.status).toBe("SUCCEEDED");
      expect(result.completion.status).toBe("SENT");
      expect(result.lead.wakeReceived).toBe(true);
    } finally { await fs.rm(packageRoot, { recursive: true, force: true }); await fs.rm(consumer, { recursive: true, force: true }); }
  }, 30_000);
});
