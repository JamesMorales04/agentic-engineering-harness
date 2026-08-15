import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadTaskContract } from "../core/config.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface ProvenanceOptions { artifact: string; taskId?: string; sbom?: boolean; sign?: boolean; }
export interface ProvenanceManifestEntry { path: string; sha256: string; kind: string; }
export interface ProvenanceManifest { version: 1; generatedAt: string; taskId?: string; entries: ProvenanceManifestEntry[]; }
export interface ProvenanceResult { artifact: string; sha256: string; statementFile: string; predicateFile: string; manifestFile: string; sbomFile?: string; bundleFile?: string; }

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

  let sbomFile: string | undefined;
  const sbomRequired = config.provenance?.required === true || config.provenance?.sbom?.required === true;
  if (options.sbom !== false && await commandExists("trivy", root)) {
    sbomFile = path.join(outputDir, `${base}.cyclonedx.json`);
    const sbomCommand = config.provenance?.sbom?.command ?? `trivy fs --format cyclonedx --output ${quote(sbomFile)} ${quote(root)}`;
    const sbom = await runProcess(sbomCommand, { cwd: root, timeoutMs: 600_000 });
    if (sbom.exitCode !== 0) throw new Error(`Trivy SBOM generation failed: ${sbom.stderr || sbom.stdout}`);
  } else if (sbomRequired) throw new Error("Supply-chain policy requires a CycloneDX SBOM, but Trivy is unavailable or SBOM generation was disabled.");
  const manifest = await buildProvenanceManifest(root, config, options.taskId, artifact, sbomFile);
  const manifestFile = path.join(outputDir, `${base}.manifest.json`);
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = await sha256File(manifestFile);
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
    artifactManifestSha256: manifestDigest,
    sbomSha256: sbomFile ? await sha256File(sbomFile) : undefined,
    buildType: config.provenance?.buildType ?? "https://github.com/JamesMorales04/agentic-engineering-harness/v0.3",
    invocationId: crypto.randomUUID(),
    startedOn: new Date().toISOString(),
    finishedOn: new Date().toISOString()
  });
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: path.basename(artifact), digest: { sha256: digest } }], predicateType: "https://slsa.dev/provenance/v1", predicate };
  await fs.writeFile(predicateFile, `${JSON.stringify(predicate, null, 2)}\n`);
  await fs.writeFile(statementFile, `${JSON.stringify(statement, null, 2)}\n`);

  let bundleFile: string | undefined;
  if (options.sign || config.provenance?.signing?.required === true) {
    if (!(await commandExists("cosign", root))) throw new Error("--sign requested but cosign is not installed.");
    bundleFile = path.join(outputDir, `${base}.sigstore.json`);
    const keyPath = config.provenance?.signing?.key ?? config.provenance?.cosignKey;
    const key = keyPath ? ` --key ${quote(keyPath)}` : "";
    const signed = await runProcess(`cosign sign-blob --yes --tlog-upload=false ${quote(statementFile)} --bundle ${quote(bundleFile)}${key}`, { cwd: root, timeoutMs: 300_000, env: { COSIGN_YES: "true", COSIGN_PASSWORD: process.env.COSIGN_PASSWORD ?? "" } });
    if (signed.exitCode !== 0) throw new Error(`Cosign signing failed: ${signed.stderr || signed.stdout}`);
    if (!(await verifyCosignBundle(root, statementFile, bundleFile, keyPath))) throw new Error("Cosign produced a bundle that could not be verified.");
  }

  return { artifact: path.relative(root, artifact).replaceAll("\\", "/"), sha256: digest, statementFile: relative(root, statementFile), predicateFile: relative(root, predicateFile), manifestFile: relative(root, manifestFile), sbomFile: sbomFile && relative(root, sbomFile), bundleFile: bundleFile && relative(root, bundleFile) };
}

export function buildSlsaPredicate(input: { project: string; artifact: string; taskId?: string; commit: string; remote: string; runDigest?: string; reportDigest?: string; artifactManifestSha256?: string; sbomSha256?: string; buildType: string; invocationId: string; startedOn: string; finishedOn: string }): Record<string, unknown> {
  const internalParameters: Record<string, unknown> = {};
  if (input.taskId) internalParameters.taskId = input.taskId;
  if (input.runDigest) internalParameters.runReportSha256 = input.runDigest;
  if (input.reportDigest) internalParameters.validationReportSha256 = input.reportDigest;
  if (input.artifactManifestSha256) internalParameters.artifactManifestSha256 = input.artifactManifestSha256;
  if (input.sbomSha256) internalParameters.sbomSha256 = input.sbomSha256;
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

export async function buildProvenanceManifest(root: string, config: HarnessProjectConfig, taskId: string | undefined, artifact: string, sbomFile?: string): Promise<ProvenanceManifest> {
  const candidates = new Map<string, string>();
  candidates.set(relative(root, artifact), "final-artifact");
  if (sbomFile) candidates.set(relative(root, sbomFile), "sbom");
  if (taskId) {
    candidates.set(relative(root, path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${taskId}.json`)), "operation-record");
    candidates.set(relative(root, path.resolve(root, config.sdd?.reportsDir ?? ".harness/reports", `${taskId}.json`)), "validation-report");
    candidates.set(relative(root, path.resolve(root, config.evidence?.outputDir ?? ".harness/evidence", `${taskId}.json`)), "requirement-evidence-graph");
    candidates.set(relative(root, path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts", `${taskId}.yaml`)), "task-contract");
    candidates.set(relative(root, path.resolve(root, ".harness/seals", `${taskId}.json`)), "task-contract-seal");
    candidates.set(relative(root, path.resolve(root, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId, "manifest.json")), "control-plane-snapshot");
    const contract = await loadTaskContract(root, taskId, config).catch(() => undefined);
    for (const [name, source] of Object.entries(contract?.source ?? {})) if (source) candidates.set(relative(root, path.resolve(root, source)), `openspec-${name}`);
    for (const [directory, kind] of [[".harness/operations", "operation-record"], [".harness/paseo/handoffs", "handoff"], [".harness/audits", "audit-report"], [config.evidence?.outputDir ?? ".harness/evidence", "evidence"]] as const) {
      for (const file of await filesUnder(root, directory)) candidates.set(file, kind);
    }
  }
  const entries: ProvenanceManifestEntry[] = [];
  for (const [relativePath, kind] of candidates) {
    try { entries.push({ path: relativePath, kind, sha256: await sha256File(path.resolve(root, relativePath)) }); } catch { /* optional artifacts are omitted, never represented with a false digest */ }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, generatedAt: new Date().toISOString(), taskId, entries };
}

async function filesUnder(root: string, relativeDirectory: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(relative(root, absolute));
      if (result.length >= 2_000) return;
    }
  };
  await visit(path.resolve(root, relativeDirectory)); return result;
}

export async function verifyProvenanceManifest(root: string, manifestFile: string): Promise<{ ok: boolean; failures: string[] }> {
  const file = path.resolve(root, manifestFile);
  let manifest: ProvenanceManifest;
  try { manifest = JSON.parse(await fs.readFile(file, "utf8")) as ProvenanceManifest; } catch (error) { return { ok: false, failures: [`manifest unreadable: ${String(error)}`] }; }
  const failures: string[] = [];
  for (const entry of manifest.entries ?? []) {
    try { const actual = await sha256File(path.resolve(root, entry.path)); if (actual !== entry.sha256) failures.push(`${entry.path}: expected ${entry.sha256}, got ${actual}`); }
    catch (error) { failures.push(`${entry.path}: ${String(error)}`); }
  }
  return { ok: failures.length === 0, failures };
}

export async function verifyCosignBundle(root: string, statementFile: string, bundleFile: string, key?: string): Promise<boolean> {
  if (!(await commandExists("cosign", root))) return false;
  const keyArg = key ? ` --key ${quote(path.resolve(root, key))}` : "";
  const result = await runProcess(`cosign verify-blob --bundle ${quote(path.resolve(root, bundleFile))}${keyArg} ${quote(path.resolve(root, statementFile))}`, { cwd: root, timeoutMs: 60_000 });
  return result.exitCode === 0;
}

export interface SupplyChainGateResult { ok: boolean; failures: string[]; manifestFile?: string; statementFile?: string; bundleFile?: string; sbomFile?: string; }

/** Deterministic delivery gate. It is inert unless one of the strict policy flags is enabled. */
export async function verifySupplyChainGate(root: string, config: HarnessProjectConfig): Promise<SupplyChainGateResult> {
  const policy = config.provenance; const strict = policy?.required === true || policy?.sbom?.required === true || policy?.signing?.required === true || policy?.verification?.required === true;
  if (!strict) return { ok: true, failures: [] };
  const outputDir = path.resolve(root, policy?.outputDir ?? ".harness/provenance"); const failures: string[] = [];
  const files = await fs.readdir(outputDir).catch(() => [] as string[]); const manifestName = files.filter((file) => file.endsWith(".manifest.json")).sort().at(-1);
  if (!manifestName) return { ok: false, failures: ["strict supply-chain policy requires a provenance manifest"] };
  const manifestFile = path.join(outputDir, manifestName); const manifestVerification = await verifyProvenanceManifest(root, path.relative(root, manifestFile)); if (!manifestVerification.ok) failures.push(...manifestVerification.failures.map((failure) => `manifest: ${failure}`));
  let manifest: ProvenanceManifest | undefined; try { manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as ProvenanceManifest; } catch { failures.push("provenance manifest is unreadable"); }
  const artifact = manifest?.entries.find((entry) => entry.kind === "final-artifact"); const sbom = manifest?.entries.find((entry) => entry.kind === "sbom");
  if (!artifact) failures.push("provenance manifest does not reference the final artifact");
  if (policy?.required === true && !manifest?.entries.some((entry) => entry.kind === "task-contract" || entry.kind === "validation-report")) failures.push("provenance manifest does not reference accepted operation evidence");
  if (policy?.sbom?.required === true && !sbom) failures.push("strict supply-chain policy requires an SBOM entry");
  const statementName = files.filter((file) => file.endsWith(".intoto.json")).sort().at(-1); const statementFile = statementName ? path.join(outputDir, statementName) : undefined;
  if (policy?.required === true && !statementFile) failures.push("strict supply-chain policy requires an in-toto statement");
  if (statementFile && artifact) {
    try {
      const statement = JSON.parse(await fs.readFile(statementFile, "utf8")) as { subject?: Array<{ name?: string; digest?: { sha256?: string } }>; predicate?: { buildDefinition?: { internalParameters?: { artifactManifestSha256?: string; sbomSha256?: string } } } };
      const subject = statement.subject?.[0]; if (subject?.digest?.sha256 !== artifact.sha256) failures.push("in-toto subject digest does not match the final artifact");
      if (subject?.name !== path.basename(artifact.path)) failures.push("in-toto subject does not identify the manifest final artifact");
      if (statement.predicate?.buildDefinition?.internalParameters?.artifactManifestSha256 !== await sha256File(manifestFile)) failures.push("in-toto statement does not reference the manifest hash");
      if (sbom && statement.predicate?.buildDefinition?.internalParameters?.sbomSha256 !== await sha256File(path.resolve(root, sbom.path))) failures.push("in-toto statement does not reference the SBOM hash");
    } catch { failures.push("in-toto statement is unreadable"); }
  }
  let bundleFile: string | undefined; const signingRequired = policy?.signing?.required === true || policy?.verification?.required === true;
  if (signingRequired) {
    const bundleName = files.filter((file) => file.endsWith(".sigstore.json")).sort().at(-1); bundleFile = bundleName ? path.join(outputDir, bundleName) : undefined;
    if (!bundleFile) failures.push("strict supply-chain policy requires a Cosign bundle");
    else if (!statementFile) failures.push("Cosign bundle cannot be verified without an in-toto statement");
    else if (policy.verification?.required === true || policy.signing?.required === true) {
      const key = policy.verification?.publicKey ?? policy.signing?.key ?? policy.cosignKey; if (!(await verifyCosignBundle(root, path.relative(root, statementFile), path.relative(root, bundleFile), key))) failures.push("Cosign bundle verification failed");
    }
  }
  return { ok: failures.length === 0, failures, manifestFile: manifestFile && path.relative(root, manifestFile), statementFile: statementFile && path.relative(root, statementFile), bundleFile: bundleFile && path.relative(root, bundleFile), sbomFile: sbom?.path };
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
