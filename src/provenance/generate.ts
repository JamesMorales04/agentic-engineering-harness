import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface ProvenanceOptions { artifact: string; taskId?: string; sbom?: boolean; sign?: boolean; }
export interface ProvenanceResult { artifact: string; sha256: string; statementFile: string; predicateFile: string; sbomFile?: string; bundleFile?: string; }

export async function generateProvenance(root: string, config: HarnessProjectConfig, options: ProvenanceOptions): Promise<ProvenanceResult> {
  const artifact = path.resolve(root, options.artifact);
  const stat = await fs.stat(artifact);
  if (!stat.isFile()) throw new Error("Provenance currently requires --artifact to point to a file.");
  const digest = await sha256File(artifact);
  const commit = await gitValue(root, "git rev-parse HEAD");
  const remote = await gitValue(root, "git remote get-url origin");
  const outputDir = path.resolve(root, config.provenance?.outputDir ?? ".harness/provenance");
  await fs.mkdir(outputDir, { recursive: true });
  const base = sanitize(path.basename(artifact));
  const predicateFile = path.join(outputDir, `${base}.slsa-provenance.json`);
  const statementFile = path.join(outputDir, `${base}.intoto.json`);

  const runDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${options.taskId}.json`)) : undefined;
  const reportDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.reportsDir ?? ".harness/reports", `${options.taskId}.json`)) : undefined;
  const predicate = buildSlsaPredicate({
    project: config.project.name,
    artifact: path.basename(artifact),
    taskId: options.taskId,
    commit,
    remote,
    runDigest,
    reportDigest,
    buildType: config.provenance?.buildType ?? "https://github.com/JamesMorales04/agentic-engineering-harness/v0.3",
    invocationId: crypto.randomUUID(),
    startedOn: new Date().toISOString(),
    finishedOn: new Date().toISOString()
  });
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: path.basename(artifact), digest: { sha256: digest } }], predicateType: "https://slsa.dev/provenance/v1", predicate };
  await fs.writeFile(predicateFile, `${JSON.stringify(predicate, null, 2)}\n`);
  await fs.writeFile(statementFile, `${JSON.stringify(statement, null, 2)}\n`);

  let sbomFile: string | undefined;
  if (options.sbom !== false && await commandExists("trivy", root)) {
    sbomFile = path.join(outputDir, `${base}.cyclonedx.json`);
    const sbom = await runProcess(`trivy fs --format cyclonedx --output ${quote(sbomFile)} ${quote(root)}`, { cwd: root, timeoutMs: 600_000 });
    if (sbom.exitCode !== 0) throw new Error(`Trivy SBOM generation failed: ${sbom.stderr || sbom.stdout}`);
  }

  let bundleFile: string | undefined;
  if (options.sign) {
    if (!(await commandExists("cosign", root))) throw new Error("--sign requested but cosign is not installed.");
    bundleFile = path.join(outputDir, `${base}.sigstore.json`);
    const key = config.provenance?.cosignKey ? ` --key ${quote(config.provenance.cosignKey)}` : "";
    const signed = await runProcess(`cosign sign-blob ${quote(statementFile)} --bundle ${quote(bundleFile)}${key}`, { cwd: root, timeoutMs: 300_000, env: { COSIGN_YES: "true" } });
    if (signed.exitCode !== 0) throw new Error(`Cosign signing failed: ${signed.stderr || signed.stdout}`);
  }

  return { artifact: path.relative(root, artifact).replaceAll("\\", "/"), sha256: digest, statementFile: relative(root, statementFile), predicateFile: relative(root, predicateFile), sbomFile: sbomFile && relative(root, sbomFile), bundleFile: bundleFile && relative(root, bundleFile) };
}

export function buildSlsaPredicate(input: { project: string; artifact: string; taskId?: string; commit: string; remote: string; runDigest?: string; reportDigest?: string; buildType: string; invocationId: string; startedOn: string; finishedOn: string }): Record<string, unknown> {
  const internalParameters: Record<string, unknown> = {};
  if (input.taskId) internalParameters.taskId = input.taskId;
  if (input.runDigest) internalParameters.runReportSha256 = input.runDigest;
  if (input.reportDigest) internalParameters.validationReportSha256 = input.reportDigest;
  return {
    buildDefinition: {
      buildType: input.buildType,
      externalParameters: { project: input.project, artifact: input.artifact },
      internalParameters,
      resolvedDependencies: input.commit ? [{ uri: input.remote ? `git+${input.remote}` : "git:local", digest: { gitCommit: input.commit } }] : []
    },
    runDetails: {
      builder: { id: "https://github.com/JamesMorales04/agentic-engineering-harness" },
      metadata: { invocationId: input.invocationId, startedOn: input.startedOn, finishedOn: input.finishedOn }
    }
  };
}

export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function optionalDigest(file: string): Promise<string | undefined> { try { return await sha256File(file); } catch { return undefined; } }
async function gitValue(root: string, command: string): Promise<string> { const result = await runProcess(command, { cwd: root, timeoutMs: 30_000 }); return result.exitCode === 0 ? result.stdout.trim() : ""; }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
