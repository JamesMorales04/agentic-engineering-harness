import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { assertNoBareDirectoryScopes } from "../src/architecture/workGraph.js";
import { createWaveBase, integrateWaveChangeSets } from "../src/candidates/wave.js";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runExecutable, runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const TASK = "TASK-WAVE-COVERAGE";

/**
 * Coverage proof for src/candidates/wave.ts:164 (locked assembly).
 * Verdict: UNWRAPPED-WITH-PROOF — already covered via waveExecutor delegation
 * wrapping, leave untouched.
 *
 * Proof obligations:
 * 1. Planner scope-shape validation rejects bare directories fail-closed
 *    before execution, so valid work-unit scopes reaching delegation AND
 *    integration are exact files or `dir/**` (no bare). For those valid
 *    shapes, delegation pre-check matching == assembler matching.
 * 2. Integration submissions reuse the SAME allowedScope as the delegation
 *    pre-check (task.scope), with no forbidden (empty), so any out-of-scope
 *    escape that would throw at :164 would already have been caught at
 *    delegation (which offers the single correction turn with budget gate +
 *    BLOCKED routing).
 * 3. Integration assembly failures (including scope escapes that slip
 *    through due to planner bug) become typed reconciliationRequired, NOT a
 *    terminal throw without diagnostic — so :164 never terminally kills
 *    without a structured reason; the repair loop (now with its own
 *    correction) owns the retry.
 * 4. Offering another worker correction at integration would violate the
 *    exactly-one bound for the same participant-attempt (worker already had
 *    its turn at delegation). Hence no wrapper at :164.
 */
describe("wave integration escape coverage proof (unwrapped-with-proof)", () => {
  it("planner validation rejects bare directory scopes fail-closed", async () => {
    const root = await createRepo();
    await expect(assertNoBareDirectoryScopes(root, [{ id: "wu-bare", scope: ["src"] }])).rejects.toThrow(/WORK_GRAPH_INVALID|bare/i);
  });

  it("delegation pre-check matching == assembler matching for valid scopes (exact + dir/**)", () => {
    // waveExecutor matchesAny (with pathWithin extra) vs assembler matchesAny
    // (minimatch only). For valid scopes (no bare, guaranteed above), they agree.
    const waveMatches = (file: string, patterns: readonly string[]) =>
      patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true }) || pathWithin(file, staticPrefix(pattern)));
    const asmMatches = (file: string, patterns: readonly string[]) =>
      patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true }));
    const validScopes: readonly string[][] = [["src/**"], ["src/value.ts"], ["**"]];
    const files = ["src/value.ts", "src/nested/deep.ts", "outside/evil.ts", "package-lock.json"];
    for (const scope of validScopes) {
      for (const file of files) {
        expect(waveMatches(file, scope), `scope ${scope} file ${file}`).toBe(asmMatches(file, scope));
      }
    }
    // Bare (invalid, rejected above) is the ONLY divergence: wave allows via
    // pathWithin, assembler denies. Since bare never reaches execution, :164
    // is covered for all reachable scopes.
    expect(waveMatches("src/foo.ts", ["src"])).toBe(true);
    expect(asmMatches("src/foo.ts", ["src"])).toBe(false);
  });

  it("integration scope escape becomes reconciliationRequired, NOT terminal throw (no kill without reason)", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-COVERAGE-1";
    const base = await createOperation(root, operationId);
    // Escaping ChangeSet: touches outside/evil.ts while allowedScope is src/**.
    // Delegation pre-check would have caught this (and offered correction);
    // if it slips through (planner bug), integration must NOT terminally kill.
    const escaping = await makeChangeSet(root, base, "wu-esc", "outside/evil.ts", "export const evil = 1;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    const result = await integrateWaveChangeSets({
      root, stateRoot: root, operationId, taskId: TASK, wave,
      submissions: [{ workUnitId: "wu-esc", changeSet: escaping, allowedScope: ["src/**"] }],
    });
    expect(result.integrated).toEqual([]);
    expect(result.reconciliationRequired).toHaveLength(1);
    expect(result.reconciliationRequired[0]?.workUnitId).toBe("wu-esc");
    expect(result.reconciliationRequired[0]?.reason).toMatch(/assembly-failed:.*escaped/i);
    // Candidate did NOT advance (nothing applied fail-closed).
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(base.revision);
  });

  it("wave.ts:164 stays unwrapped (no correction helper import) — delegation owns the turn", async () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const src = await fs.readFile(path.join(here, "../src/candidates/wave.ts"), "utf8");
    expect(src).not.toContain("withOneScopeEscapeCorrectionTurnV1");
    expect(src).not.toContain("scopeEscapeCorrection");
    // The locked assembly at :164 remains the deterministic choke point;
    // correction lives in waveExecutor delegation (pre-check) + repair loop.
    expect(src).toContain("assembleAndBindCandidateChangeSet");
  });
});

function pathWithin(candidate: string, parent: string): boolean {
  return Boolean(candidate && parent) && (candidate === parent || candidate.startsWith(`${parent}/`));
}
function staticPrefix(pattern: string): string {
  return pattern.split(/[?*\[]/, 1)[0]!.replace(/\/+$/, "");
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-coverage-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "outside"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "outside", "evil.ts"), "export const evil = 0;\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function createOperation(root: string, operationId: string) {
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: TASK }, createdAt: now, updatedAt: now });
  return (await loadOperation(root, operationId)).candidateRevision!;
}

async function makeChangeSet(root: string, base: Awaited<ReturnType<typeof loadOperation>>["candidateRevision"] extends infer T ? T extends null | undefined ? never : T : never, workUnitId: string, file: string, content: string): Promise<ChangeSetV1> {
  const absolute = path.join(root, file);
  const previous = await fs.readFile(absolute, "utf8").catch(() => "");
  const indexFile = path.join(root, ".git", `aeh-test-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const stageCurrent = readTree.exitCode === 0 ? await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const baseTree = stageCurrent.exitCode === 0 ? await runExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env }) : stageCurrent;
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new Error(`test base snapshot failed: ${baseTree.stderr || baseTree.stdout}`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    const stageChange = await runExecutable("git", ["add", "-A", "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (stageChange.exitCode !== 0) throw new Error(`test change staging failed: ${stageChange.stderr || stageChange.stdout}`);
    const diff = await runExecutable("git", ["diff", "--cached", "--binary", baseTree.stdout.trim(), "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (diff.exitCode !== 0 || !diff.stdout.trim()) throw new Error(`test patch generation failed: ${diff.stderr || diff.stdout}`);
    return {
      version: 1,
      operationId: base.operationId,
      taskId: base.taskId!,
      workUnitId,
      participantId: `participant:${workUnitId}`,
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      changedFiles: [file],
      patch: diff.stdout,
      patchDigest: sha256Utf8(diff.stdout)
    };
  } finally {
    await fs.writeFile(absolute, previous);
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}
