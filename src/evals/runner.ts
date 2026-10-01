import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import { runExecutable, runShell } from "../utils/process.js";
import { getBuildIdentity } from "../build/identity.js";
import { rankEvalResults, scoreEvalResult } from "./scoring.js";
import type { EvalBuildIdentityV1, EvalCase, EvalCorpusIdentityV1, EvalCorpusManifestV1, EvalResult, EvalVariant } from "./types.js";

const variantSchema = z.object({ name: z.string().min(1), command: z.string().optional(), env: z.record(z.string(), z.string()).optional() });
const evalSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  baseRef: z.string().min(1),
  domain: z.string().optional(),
  scenario: z.string().optional(),
  fixtureDir: z.string().optional(),
  setupCommands: z.array(z.string()).optional(),
  runCommand: z.string().optional(),
  variants: z.array(variantSchema).optional(),
  expectations: z.object({
    status: z.enum(["PASS", "FAIL"]).optional(),
    maxRepairs: z.number().int().nonnegative().optional(),
    maxHumanInterventions: z.number().int().nonnegative().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    requiredChecks: z.array(z.string()).optional()
  }).optional(),
  weights: z.object({ status: z.number().nonnegative().optional(), firstPass: z.number().nonnegative().optional(), repairs: z.number().nonnegative().optional(), interventions: z.number().nonnegative().optional(), efficiency: z.number().nonnegative().optional() }).optional()
});

export async function runEvalCase(root: string, config: HarnessProjectConfig, caseId: string, variantName?: string): Promise<EvalResult> {
  const evalCase = await loadEvalCase(root, config, caseId);
  const corpus = await computeEvalCorpusIdentity(root, config, caseId);
  const variant = selectVariant(evalCase, variantName);
  const startedAt = new Date().toISOString();
  const workspace = path.resolve(root, config.evals?.workspacesDir ?? ".harness/evals/workspaces", `${safe(caseId)}-${Date.now()}`);
  await fs.mkdir(path.dirname(workspace), { recursive: true });

  const base = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${evalCase.baseRef}^{commit}`], { cwd: root, timeoutMs: 30_000 });
  if (base.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base.stdout.trim())) throw new Error(`Eval base ref does not resolve to a full commit ID: ${evalCase.baseRef}`);
  const add = await runExecutable("git", ["worktree", "add", "--detach", workspace, base.stdout.trim()], { cwd: root, timeoutMs: 120_000 });
  if (add.exitCode !== 0) throw new Error(`Unable to create eval worktree: ${add.stderr || add.stdout}`);

  try {
    if (evalCase.fixtureDir) {
      const fixture = path.resolve(root, evalCase.fixtureDir);
      await fs.cp(fixture, workspace, { recursive: true, force: true });
    }
    for (const setup of evalCase.setupCommands ?? []) {
      const result = await runShell(template(setup, evalCase, workspace), { cwd: workspace, timeoutMs: 600_000, env: variant.env });
      if (result.exitCode !== 0) throw new Error(`Eval setup failed: ${result.stderr || result.stdout}`);
    }

    const command = template(variant.command ?? evalCase.runCommand ?? `aeh run ${quote(evalCase.taskId)}`, evalCase, workspace);
    const execution = await runShell(command, { cwd: workspace, timeoutMs: 3_600_000, env: variant.env });
    const run = await readJson(path.join(workspace, ".harness", "runs", `${evalCase.taskId}.json`));
    const report = await readJson(path.join(workspace, ".harness", "reports", `${evalCase.taskId}.json`));
    const status = (run?.status ?? report?.status ?? (execution.exitCode === 0 ? "PASS" : "FAIL")) as "PASS" | "FAIL";
    const base: Omit<EvalResult, "score" | "scoreBreakdown"> = {
      version: 1,
      caseId: evalCase.id,
      variant: variant.name,
      taskId: evalCase.taskId,
      baseRef: evalCase.baseRef,
      status,
      commandExitCode: execution.exitCode,
      metrics: run?.metrics,
      report,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(corpus ? { corpus } : {}),
      build: evalBuildIdentity()
    };
    const scored = scoreEvalResult(evalCase, base);
    const output: EvalResult = { ...base, ...scored };
    const resultsDir = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results", safe(caseId));
    await fs.mkdir(resultsDir, { recursive: true });
    const file = path.join(resultsDir, `${Date.now()}-${safe(variant.name)}.json`);
    output.resultFile = path.relative(root, file).replaceAll("\\", "/");
    await fs.writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally {
    await runExecutable("git", ["worktree", "remove", "--force", workspace], { cwd: root, timeoutMs: 120_000 });
  }
}

export async function compareEvalCase(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalResult[]> {
  const dir = path.resolve(root, config.evals?.resultsDir ?? ".harness/evals/results", safe(caseId));
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const results: EvalResult[] = [];
  for (const file of files.filter((name) => name.endsWith(".json") && name !== "dashboard.json")) {
    const value = await readJson(path.join(dir, file));
    if (value?.caseId === caseId && typeof value.variant === "string" && typeof value.score === "number" && (value.status === "PASS" || value.status === "FAIL")) results.push(value as EvalResult);
  }
  return rankEvalResults(results);
}

async function loadEvalCase(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalCase> {
  const file = path.resolve(root, config.evals?.corpusDir ?? "evals/corpus", caseId, "eval.yaml");
  return evalSchema.parse(YAML.parse(await fs.readFile(file, "utf8"))) as EvalCase;
}

export function evalCorpusDir(root: string, config: HarnessProjectConfig): string {
  return path.resolve(root, config.evals?.corpusDir ?? "evals/corpus");
}

/** Load the committed corpus manifest. A corpus without a manifest has no recorded identity. */
export async function loadEvalCorpusManifest(root: string, config: HarnessProjectConfig): Promise<EvalCorpusManifestV1 | undefined> {
  const file = path.join(evalCorpusDir(root, config), "corpus.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as EvalCorpusManifestV1;
    if (parsed?.version !== 1 || typeof parsed.corpusId !== "string" || !Array.isArray(parsed.cases)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic corpus identity over the manifest, every case definition,
 * every fixed fixture file, and every case's executable scenario harness
 * closure inside the project `evals/` tree (the scenario entry file plus its
 * relative imports, e.g. the shared result writer). Production `src/` code is
 * bound separately by the recorded build identity, so a scored observation is
 * bound to both the corpus revision and the executable harness that produced
 * it. The digest is recorded on each eval result.
 */
export async function computeEvalCorpusIdentity(root: string, config: HarnessProjectConfig, caseId?: string): Promise<EvalCorpusIdentityV1 | undefined> {
  const manifest = await loadEvalCorpusManifest(root, config);
  if (!manifest) return undefined;
  const corpusDir = evalCorpusDir(root, config);
  const rootResolved = path.resolve(root);
  // Unique file set keyed by normalized repo-relative path. A file reachable
  // from more than one case (for example a shared scenario helper) is counted
  // exactly once, so the digest rule is canonical and independent
  // implementations reproduce it exactly: sort unique relative paths and hash
  // `relativePath\0fileSha256` lines joined by newline.
  const corpusFiles = new Map<string, string>();
  const caseFiles = caseId ? new Map<string, string>() : undefined;
  const add = (map: Map<string, string>, file: string): void => {
    const absolute = path.resolve(file);
    map.set(absolute, path.relative(rootResolved, absolute).replaceAll("\\", "/"));
  };
  add(corpusFiles, path.join(corpusDir, "corpus.json"));
  for (const entry of manifest.cases) {
    add(corpusFiles, path.join(corpusDir, entry.path));
    if (caseFiles && caseId === entry.id) add(caseFiles, path.join(corpusDir, entry.path));
    for (const file of await scenarioHarnessClosure(root, entry.scenario)) {
      add(corpusFiles, file);
      if (caseFiles && caseId === entry.id) add(caseFiles, file);
    }
    const evalCase = await loadEvalCase(root, config, entry.id).catch(() => undefined);
    if (evalCase?.fixtureDir) {
      for (const file of await walkFiles(path.resolve(root, evalCase.fixtureDir))) {
        add(corpusFiles, file);
        if (caseFiles && caseId === entry.id) add(caseFiles, file);
      }
    }
  }
  const caseDigest = caseFiles ? digestFileList(await digestEntries(caseFiles)) : undefined;
  return {
    version: 1,
    corpusId: manifest.corpusId,
    corpusVersion: manifest.version,
    digest: digestFileList(await digestEntries(corpusFiles)),
    caseDigest: caseDigest ?? digestFileList(await digestEntries(corpusFiles))
  };
}

async function digestEntries(files: Map<string, string>): Promise<Array<{ relative: string; digest: string }>> {
  const rows = await Promise.all([...files.entries()].map(async ([absolute, relative]) => ({ relative, digest: await fileDigest(absolute) })));
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

/**
 * Resolve the executable harness closure for one scenario: the declared entry
 * file plus every relative import reachable inside the project `evals/` tree.
 * Imports that leave `evals/` (production source) are bound by build identity,
 * not by the corpus digest. Unreadable or escaping paths are skipped rather
 * than invented.
 */
async function scenarioHarnessClosure(root: string, scenarioPath: string | undefined): Promise<string[]> {
  if (!scenarioPath?.trim()) return [];
  const rootResolved = path.resolve(root);
  const evalsRoot = path.join(rootResolved, "evals") + path.sep;
  const visited = new Set<string>();
  const entry = path.resolve(root, scenarioPath);
  if (!(await fs.stat(entry).catch(() => undefined))?.isFile()) {
    throw new Error(`EVAL_CORPUS_SCENARIO_MISSING: declared scenario harness '${scenarioPath}' does not exist under ${rootResolved}.`);
  }
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    if (!file.startsWith(evalsRoot)) continue;
    visited.add(file);
    const source = await fs.readFile(file, "utf8").catch(() => undefined);
    if (source === undefined) continue;
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = await resolveTypeScriptSpecifier(path.resolve(path.dirname(file), specifier));
      if (resolved.startsWith(evalsRoot)) queue.push(resolved);
    }
  }
  return [...visited].sort();
}

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
}

async function resolveTypeScriptSpecifier(candidate: string): Promise<string> {
  const attempts = [candidate, candidate.replace(/\.js$/, ".ts"), `${candidate}.ts`, path.join(candidate, "index.ts")];
  for (const attempt of attempts) {
    if ((await fs.stat(attempt).catch(() => undefined))?.isFile()) return attempt;
  }
  return candidate;
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

async function fileDigest(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function digestFileList(files: Array<{ relative: string; digest: string }>): string {
  return crypto.createHash("sha256").update(files.map((file) => `${file.relative}\0${file.digest}`).join("\n")).digest("hex");
}

function evalBuildIdentity(): EvalBuildIdentityV1 {
  const build = getBuildIdentity();
  return { version: 1, packageVersion: build.packageVersion, releaseId: build.releaseId, gitSha: build.gitSha, buildDigest: build.buildDigest };
}

function selectVariant(evalCase: EvalCase, name?: string): EvalVariant {
  if (!evalCase.variants?.length) return { name: name ?? "default" };
  const selected = name ? evalCase.variants.find((variant) => variant.name === name) : evalCase.variants[0];
  if (!selected) throw new Error(`Unknown eval variant '${name}'.`);
  return selected;
}

function template(command: string, evalCase: EvalCase, workspace: string): string {
  return command
    .replaceAll("{taskId}", evalCase.taskId)
    .replaceAll("{workspace}", workspace)
    .replaceAll("{aehRoot}", aehPackageRoot());
}

/** Directory two levels above this module: the AEH package root in source and packed layouts. */
function aehPackageRoot(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
