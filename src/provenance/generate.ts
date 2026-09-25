import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadTaskContract } from "../core/config.js";
import { sha256Canonical } from "../core/digest.js";
import { commandExists, runExecutable, runShell } from "../utils/process.js";
import { getBuildIdentity, isBuildIdentityV1, type BuildIdentityV1 } from "../build/identity.js";
import { assertCandidateRevisionV1, candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";

export const PROVENANCE_MANIFEST_VERSION = 2 as const;
export const PROVENANCE_BUILDER_ID = "https://github.com/JamesMorales04/agentic-engineering-harness";

export interface ProvenanceOptions { artifact: string; taskId?: string; sbom?: boolean; sign?: boolean; }
export interface ProvenanceManifestEntry { path: string; sha256: string; kind: string; }
export interface ProvenanceManifest {
  version: typeof PROVENANCE_MANIFEST_VERSION;
  buildIdentity: BuildIdentityV1;
  candidate?: CandidateRevisionV1;
  policyDigest: string;
  generatedAt: string;
  taskId?: string;
  subject: { path: string; sha256: string };
  entries: ProvenanceManifestEntry[];
  lineage?: { operationId?: string; gitCommit?: string; required: string[]; members: string[] };
  attestations?: { statement: string; predicate: string; bundle?: string };
}
export interface ProvenanceResult { artifact: string; sha256: string; statementFile: string; predicateFile: string; manifestFile: string; sbomFile?: string; bundleFile?: string; }
export interface SupplyChainGateContextV1 { candidate: CandidateRevisionV1; artifactPath: string; }
export interface SupplyChainGateResult { ok: boolean; failures: string[]; manifestFile?: string; statementFile?: string; bundleFile?: string; sbomFile?: string; }

export async function generateProvenance(root: string, config: HarnessProjectConfig, options: ProvenanceOptions): Promise<ProvenanceResult> {
  const artifactPath = normalizeRelative(options.artifact);
  const policy = config.provenance;
  const strict = isStrictSupplyChainPolicy(config);
  if (strict && (!policy?.artifact || normalizeRelative(policy.artifact) !== artifactPath)) throw new Error("SUPPLY_CHAIN_ARTIFACT_POLICY_MISMATCH: generated artifact must exactly match the strict policy artifact path.");
  const artifact = await resolveInsideRoot(root, artifactPath);
  const artifactStat = await fs.stat(artifact).catch(() => undefined);
  if (!artifactStat?.isFile()) throw new Error("Provenance requires the configured packed artifact to be a file.");
  const digest = await sha256File(artifact);
  const commit = await gitValue(root, ["rev-parse", "HEAD"]);
  const remote = await gitValue(root, ["remote", "get-url", "origin"]);
  const outputDirRelative = policy?.outputDir ?? ".harness/provenance";
  const outputDir = await resolveInsideRoot(root, outputDirRelative, true);
  await fs.mkdir(outputDir, { recursive: true });
  const base = sanitize(path.basename(artifactPath));
  const predicateFile = path.join(outputDir, `${base}.slsa-provenance.json`);
  const statementFile = path.join(outputDir, `${base}.intoto.json`);
  const manifestFile = path.join(outputDir, `${base}.manifest.json`);

  const candidate = options.taskId ? await currentCandidateForTask(root, options.taskId, config) : undefined;
  if (strict && !candidate) throw new Error("SUPPLY_CHAIN_CANDIDATE_REQUIRED: strict provenance generation requires a current operation CandidateRevision selected by --task.");
  const sbomRequired = policy?.required === true || policy?.sbom?.required === true;
  let sbomFile: string | undefined;
  if (options.sbom !== false && (await commandExists("trivy", root))) {
    sbomFile = path.join(outputDir, `${base}.cyclonedx.json`);
    const configuredCommand = policy?.sbom?.command;
    const sbom = configuredCommand
      ? await runShell(configuredCommand, { cwd: root, timeoutMs: 600_000 })
      : await runExecutable("trivy", ["fs", "--format", "cyclonedx", "--output", sbomFile, artifact], { cwd: root, timeoutMs: 600_000 });
    if (sbom.exitCode !== 0) throw new Error(`Trivy SBOM generation failed: ${sbom.stderr || sbom.stdout}`);
    const validation = await verifyCycloneDx(sbomFile);
    if (!validation.ok) throw new Error(`Generated SBOM is invalid: ${validation.failure}`);
  } else if (sbomRequired) throw new Error("SUPPLY_CHAIN_SBOM_REQUIRED: strict supply-chain policy requires a CycloneDX SBOM of the configured packed artifact, but Trivy is unavailable or SBOM generation was disabled.");

  const signingRequired = policy?.signing?.required === true || policy?.verification?.required === true;
  if ((options.sign || signingRequired) && (!policy?.signing?.key || !policy.verification?.publicKey)) throw new Error("SUPPLY_CHAIN_SIGNER_POLICY_REQUIRED: signing requires configured signing.key and verification.publicKey trust material.");
  const manifest = await buildProvenanceManifest(root, config, options.taskId, artifact, sbomFile, candidate);
  manifest.subject = { path: artifactPath, sha256: digest };
  const plannedBundle = options.sign || signingRequired ? path.join(outputDir, `${base}.sigstore.json`) : undefined;
  manifest.attestations = { statement: relative(root, statementFile), predicate: relative(root, predicateFile), ...(plannedBundle ? { bundle: relative(root, plannedBundle) } : {}) };
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = await sha256File(manifestFile);
  const runDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${options.taskId}.json`)) : undefined;
  const reportDigest = options.taskId ? await optionalDigest(path.resolve(root, config.sdd?.reportsDir ?? ".harness/reports", `${options.taskId}.json`)) : undefined;
  const predicate = buildSlsaPredicate({
    project: config.project.name,
    artifact: artifactPath,
    taskId: options.taskId,
    commit,
    remote,
    runDigest,
    reportDigest,
    artifactManifestSha256: manifestDigest,
    sbomSha256: sbomFile ? await sha256File(sbomFile) : undefined,
    artifactSha256: digest,
    buildIdentity: manifest.buildIdentity,
    candidate,
    policyDigest: manifest.policyDigest,
    buildType: policy?.buildType ?? `${PROVENANCE_BUILDER_ID}/v1`,
    invocationId: crypto.randomUUID(),
    startedOn: manifest.generatedAt,
    finishedOn: new Date().toISOString()
  });
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: artifactPath, digest: { sha256: digest } }], predicateType: "https://slsa.dev/provenance/v1", predicate };
  await fs.writeFile(predicateFile, `${JSON.stringify(predicate, null, 2)}\n`);
  await fs.writeFile(statementFile, `${JSON.stringify(statement, null, 2)}\n`);

  let bundleFile: string | undefined;
  if (options.sign || signingRequired) {
    if (!(await commandExists("cosign", root))) throw new Error("SUPPLY_CHAIN_SIGNER_UNAVAILABLE: required Cosign signing tool is not installed.");
    if (!plannedBundle) throw new Error("SUPPLY_CHAIN_SIGNER_POLICY_REQUIRED: signing bundle path could not be resolved.");
    bundleFile = plannedBundle;
    const signed = await runExecutable("cosign", ["sign-blob", "--yes", "--tlog-upload=false", statementFile, "--bundle", bundleFile, "--key", policy!.signing!.key!], { cwd: root, timeoutMs: 300_000, env: { COSIGN_YES: "true", COSIGN_PASSWORD: process.env.COSIGN_PASSWORD ?? "" } });
    if (signed.exitCode !== 0) throw new Error(`Cosign signing failed: ${signed.stderr || signed.stdout}`);
    if (!(await verifyCosignBundle(root, relative(root, statementFile), relative(root, bundleFile), policy!.verification!.publicKey))) throw new Error("SUPPLY_CHAIN_SIGNATURE_INVALID: Cosign produced evidence that did not verify under the configured public key.");
  }
  return { artifact: artifactPath, sha256: digest, statementFile: relative(root, statementFile), predicateFile: relative(root, predicateFile), manifestFile: relative(root, manifestFile), sbomFile: sbomFile && relative(root, sbomFile), bundleFile: bundleFile && relative(root, bundleFile) };
}

export function buildSlsaPredicate(input: { project: string; artifact: string; taskId?: string; commit: string; remote: string; runDigest?: string; reportDigest?: string; artifactManifestSha256?: string; sbomSha256?: string; artifactSha256?: string; buildIdentity?: BuildIdentityV1; candidate?: CandidateRevisionV1; policyDigest?: string; buildType: string; invocationId: string; startedOn: string; finishedOn: string }): Record<string, unknown> {
  const internalParameters: Record<string, unknown> = {};
  if (input.taskId) internalParameters.taskId = input.taskId;
  if (input.runDigest) internalParameters.runReportSha256 = input.runDigest;
  if (input.reportDigest) internalParameters.validationReportSha256 = input.reportDigest;
  if (input.artifactManifestSha256) internalParameters.artifactManifestSha256 = input.artifactManifestSha256;
  if (input.sbomSha256) internalParameters.sbomSha256 = input.sbomSha256;
  if (input.sbomSha256 && input.artifactSha256) internalParameters.sbomArtifactSha256 = input.artifactSha256;
  if (input.artifactSha256) internalParameters.artifactSha256 = input.artifactSha256;
  if (input.buildIdentity) internalParameters.aehBuildIdentity = input.buildIdentity;
  if (input.candidate) internalParameters.aehCandidate = candidateBinding(input.candidate);
  if (input.policyDigest) internalParameters.aehSupplyChainPolicyDigest = input.policyDigest;
  return {
    buildDefinition: { buildType: input.buildType, externalParameters: { project: input.project, artifact: input.artifact }, internalParameters, resolvedDependencies: input.commit ? [{ uri: input.remote ? `git+${input.remote}` : "git:local", digest: { gitCommit: input.commit } }] : [] },
    runDetails: { builder: { id: PROVENANCE_BUILDER_ID }, metadata: { invocationId: input.invocationId, startedOn: input.startedOn, finishedOn: input.finishedOn } }
  };
}

export async function buildProvenanceManifest(root: string, config: HarnessProjectConfig, taskId: string | undefined, artifact: string, sbomFile?: string, suppliedCandidate?: CandidateRevisionV1): Promise<ProvenanceManifest> {
  const artifactRelative = relative(root, artifact);
  const artifactDigest = await sha256File(artifact);
  const operation = taskId ? await selectOperation(root, taskId) : undefined;
  const candidate = suppliedCandidate ?? operation?.candidateRevision as CandidateRevisionV1 | undefined;
  if (candidate) assertCandidateRevisionV1(candidate);
  if (taskId && operation?.candidateRevision && candidate && !candidateRevisionsEqual(operation.candidateRevision as CandidateRevisionV1, candidate)) throw new Error("SUPPLY_CHAIN_CANDIDATE_MISMATCH: provenance generation candidate differs from the selected current operation.");
  const candidates = new Map<string, string>();
  candidates.set(artifactRelative, "final-artifact");
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
    const selected = authoritativeOperationId ? await selectOperation(root, taskId, authoritativeOperationId) : operation;
    if (authoritativeOperationId && !selected) throw new Error("PROVENANCE_REQUIRED_ARTIFACT_MISSING: " + path.posix.join(".harness/operations", safeId(authoritativeOperationId) + ".json"));
    if (selected) {
      operationId = selected.id;
      const operationFile = path.resolve(root, ".harness/operations", safeId(selected.id) + ".json");
      await requireArtifact(root, candidates, required, operationFile, "operation-record");
      members.push(relative(root, operationFile));
      await requireArtifact(root, candidates, required, contractFile, "task-contract");
      if (config.validation?.requireSeal !== false) await requireArtifact(root, candidates, required, sealFile, "task-contract-seal");
      await requireArtifact(root, candidates, required, runFile, "operation-result");
      await requireArtifact(root, candidates, required, reportFile, "validation-report");
      if (config.evidence?.enabled || config.evidence?.requireComplete) await requireArtifact(root, candidates, required, evidenceFile, "requirement-evidence-graph");
      if (config.controlPlane?.required) await requireArtifact(root, candidates, required, controlPlaneFile, "control-plane-snapshot");
      const eventFile = path.resolve(root, ".harness/operations", safeId(selected.id), "events.ndjson");
      addCandidate(root, candidates, eventFile, "operation-events");
      for (const ref of referencedPaths(selected)) {
        const absolute = path.resolve(root, ref);
        addCandidate(root, candidates, absolute, "lineage-artifact");
        if (await exists(absolute)) members.push(relative(root, absolute));
      }
    }
  }
  const entries: ProvenanceManifestEntry[] = [];
  for (const [relativePath, kind] of candidates) {
    if (kind === "final-artifact" || kind === "sbom") {
      const file = await resolveInsideRoot(root, relativePath);
      entries.push({ path: relativePath, kind, sha256: await sha256File(file) });
      continue;
    }
    try { entries.push({ path: relativePath, kind, sha256: await sha256File(await resolveInsideRoot(root, relativePath)) }); } catch { /* optional lineage members are omitted */ }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const lineage = operationId ? { operationId, gitCommit: await gitValue(root, ["rev-parse", "HEAD"]), required, members: [...new Set(members)] } : undefined;
  return {
    version: PROVENANCE_MANIFEST_VERSION,
    buildIdentity: getBuildIdentity(),
    ...(candidate ? { candidate } : {}),
    policyDigest: provenancePolicyDigest(config),
    generatedAt: new Date().toISOString(),
    taskId,
    subject: { path: artifactRelative, sha256: artifactDigest },
    entries,
    ...(lineage ? { lineage } : {})
  };
}

export async function verifyProvenanceManifest(root: string, manifestFile: string, verificationPublicKey?: string): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  let file: string;
  try { file = await resolveInsideRoot(root, manifestFile); }
  catch (error) { return { ok: false, failures: [`manifest path invalid: ${String(error)}`] }; }
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
  catch (error) { return { ok: false, failures: [`manifest unreadable: ${String(error)}`] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, failures: ["manifest structure is invalid"] };
  const manifest = parsed as ProvenanceManifest;
  if (manifest.version !== PROVENANCE_MANIFEST_VERSION) failures.push(`unsupported provenance manifest version ${String((manifest as { version?: unknown }).version)}; regenerate version ${PROVENANCE_MANIFEST_VERSION} evidence`);
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.lineage?.required ?? [])) failures.push("manifest structure is invalid");
  if (manifest.lineage !== undefined && (!manifest.lineage || typeof manifest.lineage !== "object" || Array.isArray(manifest.lineage) || !Array.isArray(manifest.lineage.required) || !Array.isArray(manifest.lineage.members))) failures.push("manifest lineage structure is invalid");
  if (!isBuildIdentityV1(manifest.buildIdentity) || !manifest.buildIdentity.packageVersion || !manifest.buildIdentity.releaseId || !manifest.buildIdentity.gitSha) failures.push("manifest BuildIdentity is invalid");
  if (!validDigest(manifest.policyDigest)) failures.push("manifest supply-chain policy digest is invalid");
  if (!validTimestamp(manifest.generatedAt)) failures.push("manifest generation timestamp is invalid");
  if (manifest.candidate) {
    try { assertCandidateRevisionV1(manifest.candidate); }
    catch { failures.push("manifest CandidateRevision is invalid"); }
  }
  if (!manifest.subject || !isSafeRelative(manifest.subject.path) || !validDigest(manifest.subject.sha256)) failures.push("manifest artifact subject is invalid");
  const paths = new Set<string>();
  const kinds = new Map<string, ProvenanceManifestEntry[]>();
  for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || !entry.kind || !entry.path || paths.has(entry.path) || !isSafeRelative(entry.path) || !validDigest(entry.sha256)) {
      failures.push(`invalid manifest entry: ${JSON.stringify(entry)}`);
      continue;
    }
    paths.add(entry.path);
    kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry]);
    try {
      const actual = await sha256File(await resolveInsideRoot(root, entry.path));
      if (actual !== entry.sha256) failures.push(`${entry.path}: digest mismatch`);
    } catch (error) { failures.push(`${entry.path}: ${String(error)}`); }
  }
  const artifactEntries = kinds.get("final-artifact") ?? [];
  if (artifactEntries.length !== 1 || artifactEntries[0]?.path !== manifest.subject?.path || artifactEntries[0]?.sha256 !== manifest.subject?.sha256) failures.push("manifest subject does not match exactly one final-artifact entry");
  const requiredLineage = Array.isArray(manifest.lineage?.required) ? manifest.lineage.required : [];
  const lineageMembers = Array.isArray(manifest.lineage?.members) ? manifest.lineage.members : [];
  for (const member of requiredLineage) if (!paths.has(member)) failures.push(`required lineage member missing: ${member}`);
  for (const member of lineageMembers) if (!paths.has(member)) failures.push(`lineage member missing: ${member}`);

  let statement: Record<string, any> | undefined;
  let predicate: Record<string, any> | undefined;
  if (manifest.attestations) {
    if (!isSafeRelative(manifest.attestations.statement) || !isSafeRelative(manifest.attestations.predicate)) failures.push("attestation references are invalid");
    statement = isSafeRelative(manifest.attestations.statement) ? await readJson(root, manifest.attestations.statement, failures) : undefined;
    predicate = isSafeRelative(manifest.attestations.predicate) ? await readJson(root, manifest.attestations.predicate, failures) : undefined;
    if (!statement || !predicate) failures.push("in-toto statement and SLSA predicate are required");
    if (statement && predicate) {
      if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== "https://slsa.dev/provenance/v1") failures.push("in-toto statement type is invalid");
      const subjects = Array.isArray(statement.subject) ? statement.subject : [];
      if (subjects.length !== 1 || subjects[0]?.name !== manifest.subject?.path || subjects[0]?.digest?.sha256 !== manifest.subject?.sha256) failures.push("in-toto statement subject does not match the packed artifact");
      if (sha256Canonical(statement.predicate) !== sha256Canonical(predicate)) failures.push("in-toto statement predicate differs from the referenced SLSA predicate");
      const buildDefinition = predicate.buildDefinition as Record<string, any> | undefined;
      const internal = buildDefinition?.internalParameters as Record<string, any> | undefined;
      if (predicate.runDetails?.builder?.id !== PROVENANCE_BUILDER_ID) failures.push("SLSA provenance builder identity is wrong");
      if (internal?.artifactManifestSha256 !== await sha256File(file).catch(() => undefined)) failures.push("SLSA predicate does not bind this manifest digest");
      if (internal?.artifactSha256 !== manifest.subject?.sha256) failures.push("SLSA predicate does not bind the packed artifact digest");
      if (internal?.aehSupplyChainPolicyDigest !== manifest.policyDigest) failures.push("SLSA predicate policy digest disagrees with the manifest");
      if (!internal?.aehBuildIdentity || sha256Canonical(internal.aehBuildIdentity) !== sha256Canonical(manifest.buildIdentity)) failures.push("SLSA predicate BuildIdentity disagrees with the manifest");
      if (manifest.candidate && (!internal?.aehCandidate || sha256Canonical(internal.aehCandidate) !== sha256Canonical(candidateBinding(manifest.candidate)))) failures.push("SLSA predicate CandidateRevision disagrees with the manifest");
      if (buildDefinition?.externalParameters?.artifact !== manifest.subject?.path) failures.push("SLSA external parameters do not identify the packed artifact");
      const commit = buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
      if (manifest.lineage?.gitCommit && commit !== manifest.lineage.gitCommit) failures.push("SLSA resolved dependency commit disagrees with lineage");
      const sbomEntries = kinds.get("sbom") ?? [];
      if (sbomEntries.length > 1) failures.push("manifest has multiple SBOM entries");
      if (sbomEntries.length === 1) {
        if (internal?.sbomSha256 !== sbomEntries[0]?.sha256) failures.push("SLSA predicate does not bind the SBOM digest");
        if (internal?.sbomArtifactSha256 !== manifest.subject?.sha256) failures.push("SLSA predicate does not bind the SBOM to the packed artifact");
        const sbomPath = await resolveInsideRoot(root, sbomEntries[0]!.path).catch(() => undefined);
        if (sbomPath) {
          const check = await verifyCycloneDx(sbomPath);
          if (!check.ok) failures.push(`SBOM is invalid: ${check.failure}`);
        }
      } else if (internal?.sbomSha256 !== undefined || internal?.sbomArtifactSha256 !== undefined) failures.push("SLSA predicate contains SBOM binding without a manifest SBOM entry");
    }
    if (manifest.attestations.bundle) {
      if (!isSafeRelative(manifest.attestations.bundle)) failures.push("Cosign bundle path is invalid");
      else if (!verificationPublicKey) failures.push("Cosign signer policy public key is not configured");
      else if (!await verifyCosignBundle(root, manifest.attestations.statement, manifest.attestations.bundle, verificationPublicKey)) failures.push("Cosign bundle verification failed");
    }
  }
  return { ok: failures.length === 0, failures };
}

export async function verifyCosignBundle(root: string, statementFile: string, bundleFile: string, key?: string): Promise<boolean> {
  if (!key || !(await commandExists("cosign", root))) return false;
  const statement = await resolveInsideRoot(root, statementFile).catch(() => undefined);
  const bundle = await resolveInsideRoot(root, bundleFile).catch(() => undefined);
  const publicKey = path.resolve(root, key);
  if (!statement || !bundle || !(await exists(publicKey))) return false;
  const result = await runExecutable("cosign", ["verify-blob", "--insecure-ignore-tlog", "--bundle", bundle, "--key", publicKey, statement], { cwd: root, timeoutMs: 60_000 });
  return result.exitCode === 0;
}

/** Deterministic S7 gate. It is inert unless supply-chain policy requires evidence. */
export async function verifySupplyChainGate(root: string, config: HarnessProjectConfig, context?: SupplyChainGateContextV1): Promise<SupplyChainGateResult> {
  if (!isStrictSupplyChainPolicy(config)) return { ok: true, failures: [] };
  const policy = config.provenance!;
  const failures: string[] = [];
  if (!policy.artifact || !context?.artifactPath || !context.candidate) return { ok: false, failures: ["strict supply-chain policy requires a current CandidateRevision and configured packed artifact binding"] };
  let artifactPath: string;
  try {
    artifactPath = normalizeRelative(context.artifactPath);
    if (artifactPath !== normalizeRelative(policy.artifact)) throw new Error("artifact path differs from frozen supply-chain policy");
    await resolveInsideRoot(root, artifactPath);
    assertCandidateRevisionV1(context.candidate);
  } catch (error) { return { ok: false, failures: [`strict supply-chain identity is invalid: ${String(error)}`] }; }
  let outputDir: string;
  try { outputDir = normalizeRelative(policy.outputDir ?? ".harness/provenance"); }
  catch (error) { return { ok: false, failures: [`strict supply-chain output directory is invalid: ${String(error)}`] }; }
  const base = sanitize(path.basename(artifactPath));
  const manifestPath = path.posix.join(outputDir, `${base}.manifest.json`);
  const statementPath = path.posix.join(outputDir, `${base}.intoto.json`);
  const predicatePath = path.posix.join(outputDir, `${base}.slsa-provenance.json`);
  const bundlePath = path.posix.join(outputDir, `${base}.sigstore.json`);
  const manifestFile = await resolveInsideRoot(root, manifestPath, true).catch(() => undefined);
  if (!manifestFile || !(await exists(manifestFile))) return { ok: false, failures: ["strict supply-chain policy requires an artifact-bound provenance manifest"] };
  const publicKey = policy.verification?.publicKey;
  const manifestResult = await verifyProvenanceManifest(root, manifestPath, publicKey);
  if (!manifestResult.ok) failures.push(...manifestResult.failures.map((failure) => `manifest: ${failure}`));
  let manifest: ProvenanceManifest | undefined;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as ProvenanceManifest; }
  catch { failures.push("provenance manifest is unreadable"); }
  if (manifest) {
    if (!manifest.candidate || !candidateRevisionsEqual(manifest.candidate, context.candidate)) failures.push("provenance manifest does not bind the current CandidateRevision");
    if (manifest.subject?.path !== artifactPath) failures.push("provenance manifest does not bind the policy-selected packed artifact");
    if (manifest.buildIdentity && sha256Canonical(manifest.buildIdentity) !== sha256Canonical(getBuildIdentity())) failures.push("provenance BuildIdentity is stale or does not match the current build");
    if (manifest.policyDigest !== provenancePolicyDigest(config)) failures.push("provenance evidence was generated under a stale supply-chain policy");
    if (manifest.attestations?.statement !== statementPath || manifest.attestations?.predicate !== predicatePath) failures.push("provenance manifest references the wrong in-toto/SLSA evidence");
    const entries = Array.isArray(manifest.entries) ? manifest.entries.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
    const sbomEntries = entries.filter((entry) => entry.kind === "sbom");
    const sbomRequired = policy.required === true || policy.sbom?.required === true;
    if (sbomRequired && sbomEntries.length !== 1) failures.push("strict supply-chain policy requires exactly one packed-artifact SBOM entry");
    if (!sbomRequired && sbomEntries.length > 1) failures.push("provenance manifest has ambiguous SBOM entries");
    if (policy.required === true && !entries.some((entry) => entry.kind === "task-contract" || entry.kind === "validation-report")) failures.push("strict supply-chain policy requires accepted operation evidence");
    const signingRequired = policy.signing?.required === true || policy.verification?.required === true;
    if (signingRequired && (!policy.signing?.key || !publicKey)) failures.push("required signing evidence has no complete configured signer trust policy");
    if (signingRequired && (manifest.attestations?.bundle !== bundlePath || !(await exists(await resolveInsideRoot(root, bundlePath, true).catch(() => ""))))) failures.push("strict supply-chain policy requires the artifact-bound Cosign bundle");
    if (!signingRequired && manifest.attestations?.bundle && !publicKey) failures.push("optional Cosign evidence has no configured signer trust policy");
  }
  return {
    ok: failures.length === 0,
    failures,
    manifestFile: manifestPath,
    statementFile: manifest?.attestations?.statement,
    bundleFile: manifest?.attestations?.bundle,
    sbomFile: Array.isArray(manifest?.entries) ? manifest.entries.find((entry) => entry.kind === "sbom")?.path : undefined
  };
}

export function isStrictSupplyChainPolicy(config: HarnessProjectConfig): boolean {
  const policy = config.provenance;
  return policy?.required === true || policy?.sbom?.required === true || policy?.signing?.required === true || policy?.verification?.required === true;
}

export function provenancePolicyDigest(config: HarnessProjectConfig): string {
  const policy = config.provenance;
  return sha256Canonical({
    artifact: policy?.artifact,
    outputDir: policy?.outputDir ?? ".harness/provenance",
    buildType: policy?.buildType ?? `${PROVENANCE_BUILDER_ID}/v1`,
    required: policy?.required === true,
    sbomRequired: policy?.required === true || policy?.sbom?.required === true,
    sbomCommand: policy?.sbom?.command,
    signingRequired: policy?.signing?.required === true || policy?.verification?.required === true,
    signingKey: policy?.signing?.key,
    verificationPublicKey: policy?.verification?.publicKey
  });
}

export async function sha256File(file: string): Promise<string> { return await new Promise((resolve, reject) => { const hash = crypto.createHash("sha256"); const stream = createReadStream(file); stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex"))); }); }

export async function currentCandidateForTask(root: string, taskId: string, config: HarnessProjectConfig): Promise<CandidateRevisionV1 | undefined> {
  const runRecord = await readJson(root, path.posix.join(config.sdd?.runsDir ?? ".harness/runs", `${safeId(taskId)}.json`), []);
  const operationId = typeof runRecord?.operationId === "string" ? runRecord.operationId : typeof runRecord?.result?.operationId === "string" ? runRecord.result.operationId : undefined;
  const operation = await selectOperation(root, taskId, operationId);
  const candidate = operation?.candidateRevision as CandidateRevisionV1 | undefined;
  if (!candidate) return undefined;
  assertCandidateRevisionV1(candidate);
  if (candidate.taskId && candidate.taskId !== taskId) throw new Error("SUPPLY_CHAIN_CANDIDATE_MISMATCH: selected operation candidate belongs to a different task.");
  return candidate;
}

async function selectOperation(root: string, taskId: string, authoritativeOperationId?: string): Promise<Record<string, any> | undefined> {
  const directory = path.resolve(root, ".harness/operations");
  if (authoritativeOperationId) return readJson(root, path.posix.join(".harness/operations", safeId(authoritativeOperationId) + ".json"), []);
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const records: Record<string, any>[] = [];
  for (const entry of files) if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".wake.json") && !entry.name.endsWith(".completion.json")) {
    const record = await readJson(root, path.relative(root, path.join(directory, entry.name)), []);
    if (record && operationMatches(record, taskId)) records.push(record);
  }
  return records.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0];
}
function operationMatches(value: Record<string, any>, taskId: string): boolean { return value.payload?.taskId === taskId || value.result?.taskId === taskId || value.result?.contract?.task?.id === taskId; }
function referencedPaths(operation: Record<string, any>): string[] { const result: string[] = []; const visit = (value: unknown, key = ""): void => { if (typeof value === "string" && /(artifact|report|handoff|evidence|result|checkpoint|statement|predicate|seal|contract|spec)/i.test(key) && value.length < 500 && !value.includes("\n")) result.push(value); else if (Array.isArray(value)) value.forEach((item) => visit(item, key)); else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name)); }; visit(operation.result, "result"); visit(operation.stages, "stage"); visit(operation.participants, "participant"); visit(operation.supervision, "supervision"); return [...new Set(result)].filter((item) => !item.startsWith("http://") && !item.startsWith("https://")); }
function addCandidate(root: string, candidates: Map<string, string>, absolute: string, kind: string): void { const relativePath = relative(root, absolute); if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return; candidates.set(relativePath, kind); }
async function requireArtifact(root: string, candidates: Map<string, string>, required: string[], absolute: string, kind: string): Promise<void> { const relativePath = relative(root, absolute); if (!isSafeRelative(relativePath) || !(await exists(absolute))) throw new Error("PROVENANCE_REQUIRED_ARTIFACT_MISSING: " + relativePath); candidates.set(relativePath, kind); required.push(relativePath); }
async function exists(file: string): Promise<boolean> { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function existsPath(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch { return false; } }
async function readJson(root: string, relativePath: string, failures: string[]): Promise<Record<string, any> | undefined> { try { const file = await resolveInsideRoot(root, relativePath); const value = JSON.parse(await fs.readFile(file, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; } catch (error) { failures.push(`${relativePath}: ${String(error)}`); return undefined; } }
async function optionalDigest(file: string): Promise<string | undefined> { try { return await sha256File(file); } catch { return undefined; } }
async function gitValue(root: string, args: readonly string[]): Promise<string> { const result = await runExecutable("git", args, { cwd: root, timeoutMs: 30_000 }); return result.exitCode === 0 ? result.stdout.trim() : ""; }
function relative(root: string, file: string): string { return path.relative(root, file).replaceAll("\\", "/"); }
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function normalizeRelative(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error("path must be a safe root-relative path");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("path must be a normalized safe root-relative path");
  return normalized;
}
function isSafeRelative(value: unknown): value is string { if (typeof value !== "string") return false; try { return normalizeRelative(value) === value && !value.split("/").includes(""); } catch { return false; } }
async function resolveInsideRoot(root: string, relativePath: string, allowMissing = false): Promise<string> {
  const normalized = normalizeRelative(relativePath);
  const rootReal = await fs.realpath(root);
  const file = path.resolve(rootReal, normalized);
  if (file !== rootReal && !file.startsWith(rootReal + path.sep)) throw new Error("path escapes the candidate root");
  if (!allowMissing) {
    const real = await fs.realpath(file);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("path resolves outside the candidate root");
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("evidence path is not a file");
    return real;
  }
  let existing = file;
  while (existing !== rootReal && !(await existsPath(existing))) existing = path.dirname(existing);
  const existingReal = await fs.realpath(existing);
  if (existingReal !== rootReal && !existingReal.startsWith(rootReal + path.sep)) throw new Error("path parent resolves outside the candidate root");
  return file;
}
function validDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function candidateBinding(candidate: CandidateRevisionV1): Record<string, unknown> { return { operationId: candidate.operationId, candidateId: candidate.candidateId, revision: candidate.revision, sourceDigest: candidate.sourceDigest, identityDigest: candidate.identityDigest }; }
async function verifyCycloneDx(file: string): Promise<{ ok: boolean; failure?: string }> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    if (value.bomFormat !== "CycloneDX" || typeof value.specVersion !== "string" || !Number.isSafeInteger(value.version) || !Array.isArray(value.components)) return { ok: false, failure: "expected a CycloneDX document with version and components" };
    return { ok: true };
  } catch (error) { return { ok: false, failure: String(error) }; }
}
