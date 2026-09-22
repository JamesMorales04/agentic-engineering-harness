import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeArgv } from "./provider.js";
import type { AgentProvider } from "./core.js";
import { CertificationCore } from "./core.js";
import { defaultCertificationPolicy } from "./policy.js";
import { createCertificationOracleResult } from "./oracle.js";
import { writeCertificationReport } from "./artifacts.js";
import type { AgentProviderRequest, CandidateRevision, CertificationCheck, CertificationOracle, CertificationPolicy, CertificationReport } from "./types.js";

export interface BootstrapFixture {
  sourceDir: string;
  setup?: Array<{ command: string; args: string[]; timeoutMs?: number }>;
}

export interface ExternalSelfDogfoodRequest {
  root: string;
  fixture: BootstrapFixture;
  oracle: CertificationOracle;
  policy?: CertificationPolicy;
  provider?: AgentProvider;
  actor?: (candidateRoot: string) => AgentProviderRequest;
  capability?: import("./types.js").CertificationCapability;
  requireModelE2E?: boolean;
  persistRoot?: string;
  persistDirectory?: string;
}

export interface CommandOracleOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  requireModelEvidence?: boolean;
}

/** Deterministic black-box oracle for a fixture command; model output is never consulted. */
export function createCommandOracle(options: CommandOracleOptions): CertificationOracle {
  let protectedRoot: string | undefined;
  const protectedArgs = new Map<string, string>();
  return {
    id: `command:${options.command}`,
    independent: true,
    async prepare({ candidate }) {
      protectedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cert-oracle-"));
      for (const arg of options.args ?? []) {
        if (!arg || path.isAbsolute(arg) || arg.startsWith("-")) continue;
        const source = path.resolve(candidate.root, arg);
        try {
          const stat = await fs.stat(source);
          if (!stat.isFile()) continue;
          const destination = path.join(protectedRoot, `${protectedArgs.size}-${path.basename(arg)}`);
          await fs.copyFile(source, destination);
          protectedArgs.set(arg, destination);
        } catch { /* non-file argv values remain unchanged */ }
      }
    },
    async dispose() {
      if (protectedRoot) await fs.rm(protectedRoot, { recursive: true, force: true });
      protectedRoot = undefined;
      protectedArgs.clear();
    },
    async evaluate({ candidate, actor }) {
      const args = (options.args ?? []).map((arg) => protectedArgs.get(arg) ?? arg);
      const result = await executeArgv(options.command, args, { cwd: candidate.root, timeoutMs: options.timeoutMs ?? 300_000, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024, allowNetwork: false });
      const commandPassed = result.status === "COMPLETED" && result.exitCode === 0;
      let modelEvidence = false;
      try { const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null") as Record<string, unknown>; modelEvidence = parsed.modelExecuted === true; } catch { /* structured model evidence is optional for deterministic lanes */ }
      const candidateIntentExecuted = Boolean(actor?.events.some((event) => event.type === "json" && event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).type === "item.completed" && (event.data as Record<string, unknown>).item && typeof (event.data as Record<string, unknown>).item === "object" && String(((event.data as Record<string, unknown>).item as Record<string, unknown>).command ?? "").includes("node_modules/agentic-engineering-harness/dist/main.js intent") && ((event.data as Record<string, unknown>).item as Record<string, unknown>).exit_code === 0 && /INFORMATIONAL/.test(String(((event.data as Record<string, unknown>).item as Record<string, unknown>).aggregated_output ?? ""))));
      modelEvidence = modelEvidence && candidateIntentExecuted;
      const checks: CertificationCheck[] = [{ id: "fixture.command", status: commandPassed ? "PASS" : "FAIL", required: true, message: commandPassed ? "Fixture command passed." : `Fixture command failed (${result.status}, exit ${result.exitCode}).`, evidence: { exitCode: result.exitCode, status: result.status, stdout: result.stdout.slice(-4_000), stderr: result.stderr.slice(-4_000) } }];
      if (options.requireModelEvidence) checks.push({ id: "model.evidence", status: commandPassed && modelEvidence ? "PASS" as const : "FAIL" as const, required: true, message: commandPassed && modelEvidence ? "Fixture verified model-produced journey evidence and successful candidate intent execution." : "Fixture did not verify model-produced journey evidence and successful candidate intent execution.", evidence: { modelExecuted: modelEvidence, candidateIntentExecuted } });
      return createCertificationOracleResult({ oracleId: `command:${options.command}`, checks, evidence: { command: options.command, args: options.args ?? [], durationMs: result.durationMs, modelEvidenceRequired: Boolean(options.requireModelEvidence) } });
    }
  };
}

/** Pack the checkout and run it only inside a disposable fixture. */
export async function runExternalSelfDogfood(input: ExternalSelfDogfoodRequest): Promise<CertificationReport> {
  const root = await fs.realpath(path.resolve(input.root));
  const fixtureSource = await fs.realpath(path.resolve(input.fixture.sourceDir));
  await assertNoSymlinks(fixtureSource);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cert-pack-"));
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cert-fixture-"));
  try {
    const pack = await executeArgv("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", staging], { cwd: root, timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024, allowNetwork: false });
    if (pack.status !== "COMPLETED" || pack.exitCode !== 0) throw new Error(`Candidate packaging failed: ${pack.stderr || pack.stdout}`);
    const artifactName = parsePackFilename(pack.stdout);
    const artifactPath = path.resolve(staging, artifactName);
    await fs.stat(artifactPath);
    await fs.cp(fixtureSource, fixtureRoot, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
    for (const setup of input.fixture.setup ?? []) {
      const result = await executeArgv(setup.command, setup.args, { cwd: fixtureRoot, timeoutMs: setup.timeoutMs ?? 120_000, maxOutputBytes: 2 * 1024 * 1024, allowNetwork: false });
      if (result.status !== "COMPLETED" || result.exitCode !== 0) throw new Error(`Fixture setup failed: ${result.stderr || result.stdout}`);
    }
    const install = await executeArgv("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", fixtureRoot, artifactPath], { cwd: fixtureRoot, timeoutMs: 300_000, maxOutputBytes: 8 * 1024 * 1024, allowNetwork: false });
    if (install.status !== "COMPLETED" || install.exitCode !== 0) throw new Error(`Fixture installation failed: ${install.stderr || install.stdout}`);
    const candidateArtifact = path.join(fixtureRoot, ".aeh-candidate.tgz");
    await fs.copyFile(artifactPath, candidateArtifact);
    const candidate: CandidateRevision = { version: 1, id: path.basename(artifactName, ".tgz"), root: fixtureRoot, artifactPath: candidateArtifact, baseRef: "packed-checkout", sourceDigest: await sha256File(candidateArtifact), metadata: { artifactDigest: await sha256File(candidateArtifact), packaging: "npm-pack-ignore-scripts", ...(await sourceIdentity(root)) } };
    const report = await new CertificationCore(input.oracle, input.provider).certify({ candidate, policy: input.policy ?? defaultCertificationPolicy(), actor: input.actor?.(fixtureRoot), capability: input.capability, requireModelE2E: input.requireModelE2E, requireModelEvidence: input.requireModelE2E });
    if (input.persistRoot) {
      const directory = input.persistDirectory ?? ".aeh-test-results/certification";
      const relative = path.relative(path.resolve(input.persistRoot), path.resolve(input.persistRoot, directory)).replaceAll("\\", "/");
      const predicted = path.join(relative, `${report.certificationId}.json`).replaceAll("\\", "/");
      const durableReport = { ...report, persistedReport: predicted };
      await writeCertificationReport(input.persistRoot, durableReport, directory);
      return durableReport;
    }
    return report;
  } finally {
    await input.oracle.dispose?.();
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function sha256File(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function sourceIdentity(root: string): Promise<Record<string, string>> {
  const commit = await executeArgv("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 4_096, allowNetwork: false });
  const branch = await executeArgv("git", ["branch", "--show-current"], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 4_096, allowNetwork: false });
  return {
    ...(commit.status === "COMPLETED" && commit.exitCode === 0 ? { sourceCommit: commit.stdout.trim() } : {}),
    ...(branch.status === "COMPLETED" && branch.exitCode === 0 ? { sourceBranch: branch.stdout.trim() } : {})
  };
}

function parsePackFilename(stdout: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("npm pack did not return JSON."); }
  const record = Array.isArray(parsed) ? parsed[0] : parsed && typeof parsed === "object" && Object.values(parsed as Record<string, unknown>)[0];
  const filename = record && typeof record === "object" && typeof (record as { filename?: unknown }).filename === "string" ? (record as { filename: string }).filename : undefined;
  if (!filename || path.basename(filename) !== filename || !filename.endsWith(".tgz")) throw new Error("npm pack returned an unsafe artifact filename.");
  return filename;
}

async function assertNoSymlinks(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Fixture contains a symlink and cannot be isolated: ${full}`);
    if (stat.isDirectory()) await assertNoSymlinks(full);
  }
}
