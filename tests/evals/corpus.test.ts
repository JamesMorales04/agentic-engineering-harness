import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { computeEvalCorpusIdentity, loadEvalCorpusManifest, runEvalCase } from "../../src/evals/runner.js";
import { evalResultComparableV1 } from "../../src/evals/scoring.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd());
const tempRoots: string[] = [];

function config(root: string): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "corpus-test" },
    telemetry: { enabled: false },
    evals: { corpusDir: path.join(root, "evals", "corpus"), resultsDir: path.join(root, ".harness", "evals", "results"), workspacesDir: path.join(root, ".harness", "evals", "workspaces"), defaultRuns: 2, confidenceLevel: 0.95 }
  };
}

async function fixtureProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-eval-corpus-"));
  tempRoots.push(root);
  await fs.cp(path.join(REPO_ROOT, "evals", "corpus"), path.join(root, "evals", "corpus"), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, "evals", "fixtures"), path.join(root, "evals", "fixtures"), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, "evals", "scenarios"), path.join(root, "evals", "scenarios"), { recursive: true });
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "aeh@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "AEH Corpus Test"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "corpus fixture"], { cwd: root });
  return root;
}

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("versioned advisory eval corpus", () => {
  it("ships a manifest with meaningful engineering-domain cases and a stable corpus digest", async () => {
    const root = await fixtureProject();
    const manifest = await loadEvalCorpusManifest(root, config(root));
    expect(manifest?.corpusId).toBe("aeh-core-v2-engineering-evals");
    expect(manifest?.version).toBe(1);
    expect(manifest?.cases.map((entry) => entry.domain).sort()).toEqual([
      "deterministic-validation",
      "deterministic-validation",
      "progressive-context",
      "review-convergence",
      "work-decomposition"
    ]);
    const identity = await computeEvalCorpusIdentity(root, config(root));
    expect(identity?.digest).toMatch(/^[a-f0-9]{64}$/);
    const shippedIdentity = await computeEvalCorpusIdentity(REPO_ROOT, { version: 1, project: { name: "aeh" }, evals: { corpusDir: "evals/corpus" } });
    expect(shippedIdentity?.digest).toBe(identity?.digest);
    expect(shippedIdentity?.corpusId).toBe("aeh-core-v2-engineering-evals");
  });

  it("runs the shipped corpus through the production eval runner with deterministic scoring", async () => {
    const root = await fixtureProject();
    const expectedStatuses: Record<string, "PASS" | "FAIL"> = {
      "validation-gated-change": "PASS",
      "validation-fails-closed": "FAIL",
      "scope-governance": "PASS",
      "context-budget-projection": "PASS",
      "quality-convergence-thresholds": "PASS"
    };
    for (const [caseId, expected] of Object.entries(expectedStatuses)) {
      const result = await runEvalCase(root, config(root), caseId);
      expect(result.status, `${caseId}: ${JSON.stringify(result.report?.checks?.filter((check) => check.status === "FAIL"))}`).toBe(expected);
      expect(result.corpus?.corpusId).toBe("aeh-core-v2-engineering-evals");
      expect(result.corpus?.caseDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.score).toBeGreaterThan(0);
      if (expected === "PASS") expect(result.score).toBeGreaterThanOrEqual(90);
    }
  }, 300_000);

  it("binds the executable scenario harness into the case and corpus identity", async () => {
    const root = await fixtureProject();
    const before = await computeEvalCorpusIdentity(root, config(root), "scope-governance");
    const otherBefore = await computeEvalCorpusIdentity(root, config(root), "context-budget-projection");
    const scenarioFile = path.join(root, "evals", "scenarios", "scopeGovernance.ts");
    const original = await fs.readFile(scenarioFile, "utf8");
    await fs.appendFile(scenarioFile, "\n// harness mutation for digest binding\n");
    const mutated = await computeEvalCorpusIdentity(root, config(root), "scope-governance");
    expect(mutated?.caseDigest).not.toBe(before?.caseDigest);
    expect(mutated?.digest).not.toBe(before?.digest);
    expect(mutated?.caseDigest).toMatch(/^[a-f0-9]{64}$/);
    const otherAfter = await computeEvalCorpusIdentity(root, config(root), "context-budget-projection");
    expect(otherAfter?.caseDigest).toBe(otherBefore?.caseDigest);

    await fs.writeFile(scenarioFile, original);
    const restored = await computeEvalCorpusIdentity(root, config(root), "scope-governance");
    expect(restored?.caseDigest).toBe(before?.caseDigest);
    expect(restored?.digest).toBe(before?.digest);
  });

  it("records the corpus and build identity on every eval result", async () => {
    const root = await fixtureProject();
    const result = await runEvalCase(root, config(root), "scope-governance");
    expect(result.corpus?.corpusId).toBe("aeh-core-v2-engineering-evals");
    expect(result.corpus?.caseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.build?.buildDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.build?.packageVersion).toBe("0.8.4");
  }, 300_000);

  it("reproduces status, score, metrics, checks, and corpus identity across runs", async () => {
    const root = await fixtureProject();
    const first = await runEvalCase(root, config(root), "scope-governance");
    const second = await runEvalCase(root, config(root), "scope-governance");
    expect(evalResultComparableV1(second)).toEqual(evalResultComparableV1(first));
    expect(first.corpus?.digest).toBe(second.corpus?.digest);
    expect(first.startedAt).not.toBe(second.startedAt);
  }, 300_000);
});
