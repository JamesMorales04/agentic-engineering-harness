import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadTaskContract } from "../core/config.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface ProvenanceOptions { artifact: string; taskId?: string; sbom?: boolean; sign?: boolean; }
export interface ProvenanceManifestEntry { path: string; sha256: string; kind: string; }
export interface ProvenanceManifest {
  version: 1;
  generatedAt: string;
  taskId?: string;
  subject?: { path: string; sha256: string };
  entries: ProvenanceManifestEntry[];
  lineage?: { operationId?: string; gitCommit?: string; required: string[]; members: string[] };
  attestations?: { statement: string; predicate: string; bundle?: string };
}
export interface ProvenanceResult { artifact: string; sha256: string; statementFile: string; predicateFile: string; manifestFile: string; sbomFile?: string; bundleFile?: string; }

export async function generateProvenance(root: string, config: HarnessProjectConfig, options: ProvenanceOptions): Promise<ProvenanceResult> {
  const artifact = path.resolve(root, options.artifact);
  if (!(await fs.stat(artifact)).isFile()) throw new Error("Provenance currently requires --artifact to point to a file.");
  const digest = await sha256File(artifact);
  const commit = await gitValue(root, "git rev-parse HEAD");
  const remote = await gitValue(root, "git remote get-url origin");
  const outputDir = path.resolve(root, config.provenance?.outputDir ?? ".harness/provenance");
  await fs.mkdir(outputDir, { recursive: true });
  const base = sanitize(path.basename(artifact));
  const predicateFile = path.join(outputDir, `${base}.slsa-provenance.json`);
  const statementFile = path.join(outputDir, `${base}.intoto.json`);
  const manifestFile = path.join(outputDir, `${base}.manifest.json`);

  let sbomFile: string | undefined;
  if (options.sbom !== false && await commandExists("trivy", root)) {
    sbomFile = path.join(outputDir, `${base}.cyclonedx.json`);
    const sbom = await runProcess(`trivy fs --format cyclonedx --output ${quote(sbomFile)} ${quote(root)}`, { cwd: root, timeoutMs: 600_000 });
    if (sbom.exitCode !== 0) throw new Error(`Trivy SBOM generation failed: ${sbom.stderr || sbom.stdout}`);
  }
  const manifest = await buildProvenanceManifest(root, config, options.taskId, artifact, sbomFile);
  manifest.subject = { path: relative(root, artifact), sha256: digest };
  const plannedBundle = options.sign ? path.join(outputDir, `${base}.sigstore.json`) : undefined;
  manifest.attestations = { statement: relative(root, statementFile), predicate: relative(root, predicateFile), ...(plannedBundle ? { bundle: relative(root, plannedBundle) } : {}) };
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = await sha256File(manifestFile);
  const runDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${options.taskId}.json`)) : undefined;
  const reportDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.reportsDir ?? ".harness/reports", `${options.taskId}.json`)) : undefined;
  const predicate = buildSlsaPredicate({ project: config.project.name, artifact: path.basename(artifact), taskId: options.taskId, commit, remote, runDigest, reportDigest, artifactManifestSha256: manifestDigest, buildType: config.provenance?.buildType ?? "https://github.com/JamesMorales04/agentic-engineering-harness/v0.3", invocationId: crypto.randomUUID(), startedOn: new Date().toISOString(), finishedOn: new Date().toISOString() });
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: path.basename(artifact), digest: { sha256: digest } }], predicateType: "https://slsa.dev/provenance/v1", predicate };
  await fs.writeFile(predicateFile, `${JSON.stringify(predicate, null, 2)}\n`);
  await fs.writeFile(statementFile, `${JSON.stringify(statement, null, 2)}\n`);

  let bundleFile: string | undefined;
  if (options.sign) {
    if (!(await commandExists("cosign", root))) throw new Error("--sign requested but cosign is not installed.");
    if (!plannedBundle) throw new Error("Signing bundle path could not be resolved.");
    bundleFile = plannedBundle;
    const key = config.provenance?.cosignKey ? ` --key ${quote(config.provenance.cosignKey)}` : "";
    const signed = await runProcess(`cosign sign-blob ${quote(statementFile)} --bundle ${quote(bundleFile)}${key}`, { cwd: root, timeoutMs: 300_000, env: { COSIGN_YES: "true" } });
    if (signed.exitCode !== 0) throw new Error(`Cosign signing failed: ${signed.stderr || signed.stdout}`);
    if (!(await verifyCosignBundle(root, statementFile, bundleFile, config.provenance?.cosignKey))) throw new Error("Cosign produced a bundle that could not be verified.");
  }
  return { artifact: relative(root, artifact), sha256: digest, statementFile: relative(root, statementFile), predicateFile: relative(root, predicateFile), manifestFile: relative(root, manifestFile), sbomFile: sbomFile && relative(root, sbomFile), bundleFile: bundleFile && relative(root, bundleFile) };
}

export function buildSlsaPredicate(input: { project: string; artifact: string; taskId?: string; commit: string; remote: string; runDigest?: string; reportDigest?: string; artifactManifestSha256?: string; buildType: string; invocationId: string; startedOn: string; finishedOn: string }): Record<string, unknown> {
  const internalParameters: Record<string, unknown> = {};
  if (input.taskId) internalParameters.taskId = input.taskId;
  if (input.runDigest) internalParameters.runReportSha256 = input.runDigest;
  if (input.reportDigest) internalParameters.validationReportSha256 = input.reportDigest;
  if (input.artifactManifestSha256) internalParameters.artifactManifestSha256 = input.artifactManifestSha256;
  return { buildDefinition: { buildType: input.buildType, externalParameters: { project: input.project, artifact: input.artifact }, internalParameters, resolvedDependencies: input.commit ? [{ uri: input.remote ? `git+${input.remote}` : "git:local", digest: { gitCommit: input.commit } }] : [] }, runDetails: { builder: { id: "https://github.com/JamesMorales04/agentic-engineering-harness" }, metadata: { invocationId: input.invocationId, startedOn: input.startedOn, finishedOn: input.finishedOn } } };
}

export async function buildProvenanceManifest(root: string, config: HarnessProjectConfig, taskId: string | undefined, artifact: string, sbomFile?: string): Promise<ProvenanceManifest> {
  const candidates = new Map<string, string>();
  candidates.set(relative(root, artifact), "final-artifact");
  if (sbomFile) candidates.set(relative(root, sbomFile), "sbom");
  let operationId: string | undefined;
  const required: string[] = [];
  const members: string[] = [];
  if (taskId) {
    const runFile = path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", taskId + ".json");
    const reportFile = path.resolve(root, config.sdd?.reportsDir ?? ".harness/reports", taskId + ".json");
    const evidenceFile = path.resolve(root, config.evidence?.outputDir ?? ".harness/evidence", taskId + ".json");
    const contractFile = path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts", taskId + ".yaml");
    const sealFile = path.resolve(root, ".harness/seals", taskId + ".json");
    const controlPlaneFile = path.resolve(root, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId, "manifest.json");
    addCandidate(root, candidates, runFile, "operation-result");
    addCandidate(root, candidates, reportFile, "validation-report");
    addCandidate(root, candidates, evidenceFile, "requirement-evidence-graph");
    addCandidate(root, candidates, contractFile, "task-contract");
    addCandidate(root, candidates, sealFile, "task-contract-seal");
    addCandidate(root, candidates, controlPlaneFile, "control-plane-snapshot");
    const contract = await loadTaskContract(root, taskId, config).catch(() => undefined);
    for (const source of Object.values(contract?.source ?? {})) if (source) addCandidate(root, candidates, path.resolve(root, source), "normative-spec-source");
    const runRecord = await readJson(root, relative(root, runFile), []);
    const authoritativeOperationId = typeof runRecord?.operationId === "string" ? runRecord.operationId : typeof runRecord?.result?.operationId === "string" ? runRecord.result.operationId : undefined;
    const operation = await selectOperation(root, taskId, authoritativeOperationId);
    if (authoritativeOperationId && !operation) throw new Error("PROVENANCE_REQUIRED_ARTIFACT_MISSING: " + path.posix.join(".harness/operations", safeId(authoritativeOperationId) + ".json"));
    if (operation) {
      operationId = operation.id;
      const operationFile = path.resolve(root, ".harness/operations", safeId(operation.id) + ".json");
      await requireArtifact(root, candidates, required, operationFile, "operation-record");
      members.push(relative(root, operationFile));
      await requireArtifact(root, candidates, required, contractFile, "task-contract");
      if (config.validation?.requireSeal !== false) await requireArtifact(root, candidates, required, sealFile, "task-contract-seal");
      await requireArtifact(root, candidates, required, runFile, "operation-result");
      await requireArtifact(root, candidates, required, reportFile, "validation-report");
      if (config.evidence?.enabled || config.evidence?.requireComplete) await requireArtifact(root, candidates, required, evidenceFile, "requirement-evidence-graph");
      if (config.controlPlane?.required) await requireArtifact(root, candidates, required, controlPlaneFile, "control-plane-snapshot");
      const eventFile = path.resolve(root, ".harness/operations", safeId(operation.id), "events.ndjson");
      addCandidate(root, candidates, eventFile, "operation-events");
      for (const ref of referencedPaths(operation)) {
        const absolute = path.resolve(root, ref);
        addCandidate(root, candidates, absolute, "lineage-artifact");
        if (await exists(absolute)) members.push(relative(root, absolute));
      }
    }
  }
  const entries: ProvenanceManifestEntry[] = [];
  for (const [relativePath, kind] of candidates) { try { entries.push({ path: relativePath, kind, sha256: await sha256File(path.resolve(root, relativePath)) }); } catch { /* optional artifacts are omitted */ } }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const lineage = operationId ? { operationId, gitCommit: await gitValue(root, "git rev-parse HEAD"), required, members: [...new Set(members)] } : undefined;
  return { version: 1, generatedAt: new Date().toISOString(), taskId, entries, ...(lineage ? { lineage } : {}) };
}

export async function verifyProvenanceManifest(root: string, manifestFile: string): Promise<{ ok: boolean; failures: string[] }> {
  const file = path.resolve(root, manifestFile);
  let manifest: ProvenanceManifest;
  try { manifest = JSON.parse(await fs.readFile(file, "utf8")) as ProvenanceManifest; } catch (error) { return { ok: false, failures: [`manifest unreadable: ${String(error)}`] }; }
  const failures: string[] = [];
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) failures.push("manifest structure is invalid");
  const paths = new Set<string>();
  for (const entry of manifest.entries ?? []) {
    if (!entry?.path || paths.has(entry.path) || !isSafeRelative(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) { failures.push(`invalid manifest entry: ${JSON.stringify(entry)}`); continue; }
    paths.add(entry.path);
    try { const actual = await sha256File(path.resolve(root, entry.path)); if (actual !== entry.sha256) failures.push(`${entry.path}: expected ${entry.sha256}, got ${actual}`); }
    catch (error) { failures.push(`${entry.path}: ${String(error)}`); }
  }
  if (manifest.subject) {
    if (!isSafeRelative(manifest.subject.path) || !/^[a-f0-9]{64}$/.test(manifest.subject.sha256)) failures.push("manifest subject is invalid");
    else try { const actual = await sha256File(path.resolve(root, manifest.subject.path)); if (actual !== manifest.subject.sha256) failures.push(`subject ${manifest.subject.path}: digest mismatch`); }
    catch (error) { failures.push(`subject ${manifest.subject.path}: ${String(error)}`); }
  }
  if (manifest.lineage) for (const member of manifest.lineage.required) if (!paths.has(member)) failures.push(`required lineage member missing: ${member}`);
  if (manifest.attestations) {
    if (!isSafeRelative(manifest.attestations.statement) || !isSafeRelative(manifest.attestations.predicate)) failures.push("attestation references are invalid");
    const statement = isSafeRelative(manifest.attestations.statement) ? await readJson(root, manifest.attestations.statement, failures) : undefined;
    const predicate = isSafeRelative(manifest.attestations.predicate) ? await readJson(root, manifest.attestations.predicate, failures) : undefined;
    if (statement && manifest.subject) {
      const subject = Array.isArray(statement.subject) ? statement.subject[0] as { digest?: { sha256?: string } } : undefined;
      if (subject?.digest?.sha256 !== manifest.subject.sha256) failures.push("in-toto statement subject does not match manifest subject");
    }
    const predicateDigest = (predicate as any)?.buildDefinition?.internalParameters?.artifactManifestSha256;
    const actualManifestDigest = await sha256File(file).catch(() => undefined);
    if (predicateDigest && actualManifestDigest && predicateDigest !== actualManifestDigest) failures.push("SLSA predicate does not bind this manifest digest");
    const commit = (predicate as any)?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
    if (commit && manifest.lineage?.gitCommit && commit !== manifest.lineage.gitCommit) failures.push("SLSA resolved dependency commit disagrees with lineage");
    if (manifest.attestations.bundle && (!isSafeRelative(manifest.attestations.bundle) || !isSafeRelative(manifest.attestations.statement) || !(await verifyCosignBundle(root, manifest.attestations.statement, manifest.attestations.bundle)))) failures.push("Cosign bundle verification failed");
  }
  return { ok: failures.length === 0, failures };
}

export async function verifyCosignBundle(root: string, statementFile: string, bundleFile: string, key?: string): Promise<boolean> {
  if (!(await commandExists("cosign", root))) return false;
  const keyArg = key ? ` --key ${quote(path.resolve(root, key))}` : "";
  const result = await runProcess(`cosign verify-blob --bundle ${quote(path.resolve(root, bundleFile))}${keyArg} ${quote(path.resolve(root, statementFile))}`, { cwd: root, timeoutMs: 60_000 });
  return result.exitCode === 0;
}

export async function sha256File(file: string): Promise<string> { return await new Promise((resolve, reject) => { const hash = crypto.createHash("sha256"); const stream = createReadStream(file); stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex"))); }); }

async function selectOperation(root: string, taskId: string, authoritativeOperationId?: string): Promise<Record<string, any> | undefined> {
  const directory = path.resolve(root, ".harness/operations");
  if (authoritativeOperationId) return readJson(root, path.posix.join(".harness/operations", safeId(authoritativeOperationId) + ".json"), []);
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const records: Record<string, any>[] = [];
  for (const entry of files) if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".wake.json") && !entry.name.endsWith(".completion.json")) { const record = await readJson(root, path.relative(root, path.join(directory, entry.name)), []); if (record && operationMatches(record, taskId)) records.push(record); }
  return records.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0];
}
function operationMatches(value: Record<string, any>, taskId: string): boolean { return value.payload?.taskId === taskId || value.result?.taskId === taskId || value.result?.contract?.task?.id === taskId; }
function referencedPaths(operation: Record<string, any>): string[] { const result: string[] = []; const visit = (value: unknown, key = ""): void => { if (typeof value === "string" && /(artifact|report|handoff|evidence|result|checkpoint|statement|predicate|seal|contract|spec)/i.test(key) && value.length < 500 && !value.includes("\n")) result.push(value); else if (Array.isArray(value)) value.forEach((item) => visit(item, key)); else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name)); }; visit(operation.result, "result"); visit(operation.stages, "stage"); visit(operation.participants, "participant"); visit(operation.supervision, "supervision"); return [...new Set(result)].filter((item) => !item.startsWith("http://") && !item.startsWith("https://")); }
function addCandidate(root: string, candidates: Map<string, string>, absolute: string, kind: string): void { const relativePath = relative(root, absolute); if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return; candidates.set(relativePath, kind); }
async function requireArtifact(root: string, candidates: Map<string, string>, required: string[], absolute: string, kind: string): Promise<void> {
  const relativePath = relative(root, absolute);
  if (!isSafeRelative(relativePath) || !(await exists(absolute))) throw new Error("PROVENANCE_REQUIRED_ARTIFACT_MISSING: " + relativePath);
  candidates.set(relativePath, kind);
  required.push(relativePath);
}
async function exists(file: string): Promise<boolean> { try { await fs.stat(file); return true; } catch { return false; } }
function isSafeRelative(value: string): boolean { return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }
async function readJson(root: string, relativePath: string, failures: string[]): Promise<Record<string, any> | undefined> { try { const value = JSON.parse(await fs.readFile(path.resolve(root, relativePath), "utf8")); return value && typeof value === "object" ? value : undefined; } catch (error) { failures.push(`${relativePath}: ${String(error)}`); return undefined; } }
async function optionalDigest(file: string): Promise<string | undefined> { try { return await sha256File(file); } catch { return undefined; } }
async function gitValue(root: string, command: string): Promise<string> { const result = await runProcess(command, { cwd: root, timeoutMs: 30_000 }); return result.exitCode === 0 ? result.stdout.trim() : ""; }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
