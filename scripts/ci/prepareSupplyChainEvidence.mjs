import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const root = path.resolve(process.cwd());
const runnerTemp = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : undefined;
const workspace = process.env.GITHUB_WORKSPACE ? path.resolve(process.env.GITHUB_WORKSPACE) : undefined;
const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const gitRoot = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
if (!runnerTemp || !outputDirectory || gitRoot !== root || root === workspace || !root.startsWith(runnerTemp + path.sep) || !outputDirectory.startsWith(runnerTemp + path.sep)) {
  throw new Error("SUPPLY_CHAIN_EVIDENCE_WORKTREE_REQUIRED: evidence collection must stay inside the disposable RUNNER_TEMP Git worktree.");
}

const artifactPath = normalizeRootRelative(process.env.AEH_PACKED_ARTIFACT ?? "");
const taskId = process.env.AEH_SUPPLY_TASK_ID;
if (!taskId) throw new Error("SUPPLY_CHAIN_TASK_ID_REQUIRED: verified controller CandidateRevision task id is absent.");
const project = YAML.parse(await fs.readFile(path.join(root, ".harness", "project.yaml"), "utf8"));
const policy = project.provenance;
if (policy?.artifact !== artifactPath) throw new Error("SUPPLY_CHAIN_ARTIFACT_POLICY_MISMATCH: evidence artifact differs from strict project policy.");

const artifactFile = path.resolve(root, artifactPath);
const basename = path.basename(artifactPath);
const base = basename.replace(/[^A-Za-z0-9._-]/g, "-");
const provenanceDirectory = path.resolve(root, policy.outputDir ?? ".harness/provenance");
const sourceFiles = {
  artifact: artifactFile,
  sbom: path.join(provenanceDirectory, `${base}.cyclonedx.json`),
  manifest: path.join(provenanceDirectory, `${base}.manifest.json`),
  statement: path.join(provenanceDirectory, `${base}.intoto.json`),
  predicate: path.join(provenanceDirectory, `${base}.slsa-provenance.json`),
  bundle: path.join(provenanceDirectory, `${base}.sigstore.json`),
  publicKey: path.resolve(root, policy.verification?.publicKey ?? "")
};

const artifactBytes = await fs.readFile(sourceFiles.artifact);
const artifactSha256 = sha256(artifactBytes);
const manifest = JSON.parse(await fs.readFile(sourceFiles.manifest, "utf8"));
const statement = JSON.parse(await fs.readFile(sourceFiles.statement, "utf8"));
const predicate = JSON.parse(await fs.readFile(sourceFiles.predicate, "utf8"));
const sbom = JSON.parse(await fs.readFile(sourceFiles.sbom, "utf8"));
const candidate = manifest.candidate;
const candidateDigest = candidate?.identityDigest;
const internal = predicate.buildDefinition?.internalParameters;
const packageMetadata = JSON.parse(execFileSync("tar", ["-xOf", sourceFiles.artifact, "package/package.json"], { encoding: "utf8" }));
const productPurl = npmPurl(packageMetadata.name, packageMetadata.version);
const productComponent = sbom.components?.find((component) => component.purl === productPurl);
const verificationKey = policy.verification?.publicKey;
const expectedFiles = {
  sbom: relative(root, sourceFiles.sbom),
  manifest: relative(root, sourceFiles.manifest),
  statement: relative(root, sourceFiles.statement),
  predicate: relative(root, sourceFiles.predicate),
  bundle: relative(root, sourceFiles.bundle)
};

if (manifest.taskId !== taskId || !candidateDigest || manifest.subject?.path !== artifactPath || manifest.subject?.sha256 !== artifactSha256) {
  throw new Error("SUPPLY_CHAIN_ARTIFACT_OR_CANDIDATE_MISMATCH: manifest does not bind the configured artifact and current task.");
}
if (internal?.artifactSha256 !== artifactSha256 || internal?.sbomArtifactSha256 !== artifactSha256 || sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0 || !productComponent || productComponent.hashes?.[0]?.content !== artifactSha256) {
  throw new Error("SUPPLY_CHAIN_SBOM_IDENTITY_INVALID: CycloneDX inventory and SLSA predicate must bind the exact packed candidate.");
}
if (!statement.subject?.some((subject) => subject.name === artifactPath && subject.digest?.sha256 === artifactSha256)) {
  throw new Error("SUPPLY_CHAIN_STATEMENT_IDENTITY_INVALID: in-toto statement does not name the exact packed candidate.");
}
if (manifest.attestations?.statement !== expectedFiles.statement || manifest.attestations?.predicate !== expectedFiles.predicate || manifest.attestations?.bundle !== expectedFiles.bundle) {
  throw new Error("SUPPLY_CHAIN_ATTESTATION_PATH_INVALID: manifest paths do not match the generated evidence files.");
}
if (!verificationKey || !policy.signing?.key || path.resolve(root, policy.signing.key) === path.resolve(root, verificationKey)) {
  throw new Error("SUPPLY_CHAIN_TRUST_POLICY_INVALID: strict signing and public verification keys must be distinct and configured.");
}

// This repeats the same key-based bundle verification after the CLI strict gate passed,
// so the retained evidence bundle is independently checkable from its uploaded files.
execFileSync("cosign", ["verify-blob", "--insecure-ignore-tlog", "--bundle", sourceFiles.bundle, "--key", sourceFiles.publicKey, sourceFiles.statement], { stdio: "ignore" });

const outputNames = {
  artifact: `${packageMetadata.name.replace(/^@/, "").replaceAll("/", "-")}-${packageMetadata.version}.tgz`,
  sbom: "sbom.cyclonedx.json",
  manifest: "provenance.manifest.json",
  statement: "attestation.intoto.json",
  predicate: "provenance.slsa.json",
  bundle: "signature.bundle.json",
  publicKey: "cosign.pub"
};
await fs.mkdir(outputDirectory, { recursive: true });
if ((await fs.readdir(outputDirectory)).length > 0) throw new Error("SUPPLY_CHAIN_EVIDENCE_OUTPUT_NOT_EMPTY: refusing to mix evidence from different candidates.");
const copied = {};
for (const key of Object.keys(outputNames)) {
  const destination = path.join(outputDirectory, outputNames[key]);
  await fs.copyFile(sourceFiles[key], destination);
  const bytes = await fs.readFile(destination);
  copied[key] = { file: outputNames[key], sha256: sha256(bytes), size: bytes.length };
}
if ((await fs.readdir(outputDirectory)).some((name) => /cosign\.key|private/i.test(name))) {
  throw new Error("SUPPLY_CHAIN_PRIVATE_KEY_EXCLUSION_FAILED: private signing material must never enter the evidence bundle.");
}

const summary = {
  version: 1,
  lane: "supply-chain",
  preTamperVerification: "PASS",
  generatedAt: new Date().toISOString(),
  taskId,
  candidateRevision: candidate,
  candidateDigest,
  policyDigest: manifest.policyDigest,
  artifactPath,
  artifactSha256,
  sbomArtifactSha256: internal.sbomArtifactSha256,
  sbom: { format: sbom.bomFormat, componentCount: sbom.components.length, packagePurl: productPurl },
  publicVerificationKey: verificationKey,
  publicKeyCosignVerification: "PASS",
  files: copied,
  privateKeyIncluded: false
};
const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
await fs.writeFile(path.join(outputDirectory, "summary.json"), summaryBytes);
await fs.writeFile(path.join(outputDirectory, "summary.sha256"), `${sha256(summaryBytes)}  summary.json\n`);
process.stdout.write(`SUPPLY_CHAIN_EVIDENCE_BUNDLE ${JSON.stringify({ outputDirectory, artifactSha256, candidateDigest, componentCount: sbom.components.length, files: Object.keys(copied) })}\n`);

function normalizeRootRelative(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`SUPPLY_CHAIN_ARTIFACT_PATH_INVALID: ${value}`);
  return normalized;
}

function relative(from, to) {
  const value = path.relative(from, to).split(path.sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || path.isAbsolute(value)) throw new Error(`SUPPLY_CHAIN_EVIDENCE_PATH_OUTSIDE_ROOT: ${to}`);
  return value;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
