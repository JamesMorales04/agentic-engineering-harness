import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuildIdentity, type BuildIdentityV1 } from "../src/build/identity.js";
import { loadProjectConfig } from "../src/core/config.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { currentCandidateForTask, provenancePolicyDigest, verifySupplyChainGate } from "../src/provenance/generate.js";

type ProvenancePolicy = NonNullable<HarnessProjectConfig["provenance"]>;

interface StatementSubject { name: string; digest: { sha256: string } }

interface EvidenceManifest {
  version: number;
  candidate: CandidateRevisionV1;
  subject: { path: string; sha256: string };
  buildIdentity?: BuildIdentityV1;
  policyDigest: string;
  attestations?: { statement?: string; predicate?: string; bundle?: string };
  generatedAt: string;
  taskId: string;
  lineage: { operationId: string; required: string[]; members: string[] };
  entries: Array<{ path: string; sha256: string; kind: string }>;
}

interface EvidencePredicate {
  buildDefinition: {
    buildType: string;
    externalParameters: { project: string; artifact: string };
    internalParameters: Record<string, unknown>;
    resolvedDependencies: Array<{ uri: string; digest: { gitCommit: string } }>;
  };
  runDetails: { builder: { id: string }; metadata: { invocationId: string; startedOn: string; finishedOn: string } };
}

interface EvidenceStatement {
  _type: string;
  subject?: StatementSubject[];
  predicateType: string;
  predicate: EvidencePredicate;
}

interface FixtureSignatureBundle {
  fixture: string;
  provider: string;
  statementSha256: string;
  keySha256: string;
  signature: string;
}

interface EvidenceFixture {
  root: string;
  binDir: string;
  policy: ProvenancePolicy;
  config: HarnessProjectConfig;
  candidate: CandidateRevisionV1;
  artifactRelative: string;
  artifactFile: string;
  sbomRelative: string;
  sbomFile: string;
  keyRelative: string;
  keyFile: string;
  acceptedEvidenceRelative: string;
  acceptedEvidenceFile: string;
  acceptedEvidenceDigest: string;
  manifestRelative: string;
  manifestFile: string;
  statementRelative: string;
  statementFile: string;
  predicateRelative: string;
  predicateFile: string;
  bundleRelative: string;
  bundleFile: string;
  manifest: EvidenceManifest;
  predicate: EvidencePredicate;
  statement: EvidenceStatement;
  bundle: FixtureSignatureBundle;
  manifestDigestOverride?: string;
}

const OUTPUT_DIR = ".harness/provenance";
const ARTIFACT = "dist/aeh-fixture.tgz";
const OTHER_ARTIFACT = "dist/aeh-fixture-other.tgz";
const KEY = "keys/fixture-signing.pem";
const BUILDER_ID = "https://github.com/JamesMorales04/agentic-engineering-harness";
const FAKE_SIGNING_BOUNDARY = "deterministic-not-provider-signature";
const FAKE_PROVIDER_STATE = "NOT_REAL_PROVIDER";
const MANIFEST_NAME = "aeh-fixture.tgz.manifest.json";
const STATEMENT_NAME = "aeh-fixture.tgz.intoto.json";
const PREDICATE_NAME = "aeh-fixture.tgz.slsa-provenance.json";
const SBOM_NAME = "aeh-fixture.tgz.cyclonedx.json";
const BUNDLE_NAME = "aeh-fixture.tgz.sigstore.json";

const originalPath = process.env.PATH;
const roots: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("S7 supply-chain provenance gate", () => {
  it("passes a fully bound strict evidence chain with deterministic fixture signing", async () => {
    const fixture = await createEvidenceFixture();
    const result = await runGate(fixture);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("requires a provenance manifest under strict policy", async () => {
    const fixture = await createEvidenceFixture();
    await fs.rm(fixture.manifestFile);
    expectBlocked(await runGate(fixture), /manifest|provenance/i);
  });

  it("requires an in-toto subject that binds the packed artifact", async () => {
    const fixture = await createEvidenceFixture();
    await persistEvidence(fixture, []);
    expectBlocked(await runGate(fixture), /subject/i);
  });

  it("requires a valid BuildIdentity binding", async () => {
    const fixture = await createEvidenceFixture();
    delete fixture.manifest.buildIdentity;
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /build.?identity/i);
  });

  it("requires an SBOM binding when policy requires SBOM", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifest.entries = fixture.manifest.entries.filter((entry) => entry.kind !== "sbom");
    await fs.rm(fixture.sbomFile);
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /sbom/i);
  });

  it("requires an in-toto statement when policy requires provenance", async () => {
    const fixture = await createEvidenceFixture();
    await fs.rm(fixture.statementFile);
    expectBlocked(await runGate(fixture), /statement|in-toto/i);
  });

  it("requires the SLSA predicate evidence file", async () => {
    const fixture = await createEvidenceFixture();
    await fs.rm(fixture.predicateFile);
    expectBlocked(await runGate(fixture), /predicate|slsa/i);
  });

  it("requires a signing bundle when policy requires signing", async () => {
    const fixture = await createEvidenceFixture();
    await fs.rm(fixture.bundleFile);
    expectBlocked(await runGate(fixture), /bundle|cosign|signature/i);
  });

  it("blocks artifact byte tampering", async () => {
    const fixture = await createEvidenceFixture();
    await fs.appendFile(fixture.artifactFile, "tampered\n");
    expectBlocked(await runGate(fixture), /aeh-fixture\.tgz|artifact|subject|digest|sha256/i);
  });

  it("blocks SBOM byte tampering", async () => {
    const fixture = await createEvidenceFixture();
    await fs.appendFile(fixture.sbomFile, "\n");
    expectBlocked(await runGate(fixture), /cyclonedx|sbom|digest|sha256/i);
  });

  it("blocks a claimed artifact digest that does not match the packed artifact", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifest.subject.sha256 = "b".repeat(64);
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /aeh-fixture\.tgz|artifact|subject|digest|sha256/i);
  });

  it("blocks a claimed SBOM digest that does not match the SBOM bytes", async () => {
    const fixture = await createEvidenceFixture();
    const sbom = fixture.manifest.entries.find((entry) => entry.kind === "sbom")!;
    sbom.sha256 = "c".repeat(64);
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /cyclonedx|sbom|digest|sha256/i);
  });

  it("blocks a statement subject that disagrees with the bound artifact", async () => {
    const fixture = await createEvidenceFixture();
    fixture.statement.subject = [{ name: ARTIFACT, digest: { sha256: "d".repeat(64) } }];
    await rewriteStatementAndBundle(fixture);
    expectBlocked(await runGate(fixture), /subject/i);
  });

  it("blocks a predicate that binds a stale manifest digest", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifestDigestOverride = "e".repeat(64);
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /manifest|predicate|slsa|bind/i);
  });

  it("blocks evidence bound to the wrong CandidateRevision", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifest.candidate = await createCandidate({ candidateId: "candidate:OP-S7-FIXTURE:wrong", sourceDigest: digest("wrong-candidate-source") });
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /candidate/i);
  });

  it("blocks evidence bound to a stale CandidateRevision", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifest.candidate = await createCandidate({ revision: fixture.candidate.revision + 1 });
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /candidate|stale/i);
  });

  it("blocks evidence bound to a different packed artifact", async () => {
    const fixture = await createEvidenceFixture();
    const otherFile = path.join(fixture.root, OTHER_ARTIFACT);
    await fs.writeFile(otherFile, "other packed artifact\n");
    fixture.manifest.subject = { path: OTHER_ARTIFACT, sha256: await digestFile(otherFile) };
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /artifact|packed|binding/i);
  });

  it("blocks a stale BuildIdentity binding", async () => {
    const fixture = await createEvidenceFixture();
    fixture.manifest.buildIdentity = { ...getBuildIdentity(), releaseId: "release-previous", buildDigest: "f".repeat(64) };
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /build.?identity/i);
  });

  it("blocks a stale policy binding", async () => {
    const olderPolicy: ProvenancePolicy = { outputDir: OUTPUT_DIR, required: true, sbom: { required: false }, signing: { required: false }, verification: { required: false } };
    const fixture = await createEvidenceFixture({ policy: olderPolicy });
    const result = await runGate(fixture, { config: { ...fixture.config, provenance: strictPolicy() } });
    expectBlocked(result, /policy/i);
  });

  it("treats a changed SBOM command as a stale policy binding", async () => {
    const fixture = await createEvidenceFixture();
    const changedPolicy = strictPolicy({ sbom: { required: true, command: "trivy fs --format cyclonedx" } });
    expectBlocked(await runGate(fixture, { config: { ...fixture.config, provenance: changedPolicy } }), /policy/i);
  });

  it("blocks a wrong builder identity", async () => {
    const fixture = await createEvidenceFixture();
    fixture.predicate.runDetails.builder.id = "https://example.invalid/not-the-expected-builder";
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture), /builder/i);
  });

  it("blocks a malformed manifest", async () => {
    const fixture = await createEvidenceFixture();
    await fs.writeFile(fixture.manifestFile, `${JSON.stringify({ version: 2, candidate: "not-a-candidate", subject: null, entries: [{}] }, null, 2)}\n`);
    expectBlocked(await runGate(fixture), /manifest|artifact|candidate|invalid/i);
    await fs.writeFile(fixture.manifestFile, "null\n");
    expectBlocked(await runGate(fixture), /manifest|structure|invalid/i);
    await fs.writeFile(fixture.manifestFile, `${JSON.stringify({ version: 2, entries: "not-an-array", lineage: { required: "not-an-array", members: [] } })}\n`);
    expectBlocked(await runGate(fixture), /manifest|lineage|structure|invalid/i);
  });

  it("blocks a malformed in-toto statement", async () => {
    const fixture = await createEvidenceFixture();
    await fs.writeFile(fixture.statementFile, "{ this is not json\n");
    expectBlocked(await runGate(fixture), /statement|in-toto|unreadable|invalid/i);
  });

  it("blocks a malformed SLSA predicate", async () => {
    const fixture = await createEvidenceFixture();
    await fs.writeFile(fixture.predicateFile, "{\"buildDefinition\":\n");
    expectBlocked(await runGate(fixture), /predicate|slsa|unreadable|invalid/i);
  });

  it("verifies required signing through the configured deterministic fake signing boundary", async () => {
    const fixture = await createEvidenceFixture();
    const result = await runGate(fixture);
    expect(result.ok).toBe(true);
    expect(fixture.bundle.fixture).toBe(FAKE_SIGNING_BOUNDARY);
    expect(fixture.bundle.statementSha256).toBe(await digestFile(fixture.statementFile));
  });

  it("blocks a signature bundle that does not bind the signed statement", async () => {
    const fixture = await createEvidenceFixture();
    fixture.bundle.statementSha256 = "0".repeat(64);
    await fs.writeFile(fixture.bundleFile, `${JSON.stringify(fixture.bundle, null, 2)}\n`);
    expectBlocked(await runGate(fixture), /cosign|signature|bundle|verif/i);
  });

  it("blocks a signing key mismatch at the configured deterministic boundary", async () => {
    const fixture = await createEvidenceFixture();
    const otherKeyRelative = "keys/other-signing.pem";
    await fs.writeFile(path.join(fixture.root, otherKeyRelative), "fixture-key-B\n");
    const mismatchedPolicy = strictPolicy({ verification: { required: true, publicKey: otherKeyRelative } });
    fixture.manifest.policyDigest = provenancePolicyDigest({ version: 1, project: { name: "s7-provenance-fixture" }, provenance: mismatchedPolicy });
    await persistEvidence(fixture);
    expectBlocked(await runGate(fixture, { config: { ...fixture.config, provenance: mismatchedPolicy } }), /cosign|signature|key|bundle|verif/i);
  });

  it("keeps the gate inert when no supply-chain requirement is configured", async () => {
    const root = await createRoot();
    const result = await verifySupplyChainGate(root, { version: 1, project: { name: "s7-inert" } }, { candidate: await createCandidate(), artifactPath: ARTIFACT });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("preserves the explicit no-requirement outcome for non-strict policy flags", async () => {
    const root = await createRoot();
    const config: HarnessProjectConfig = { version: 1, project: { name: "s7-non-strict" }, provenance: nonStrictPolicy() };
    const result = await verifySupplyChainGate(root, config, { candidate: await createCandidate(), artifactPath: ARTIFACT });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("returns only deterministic decisions without provider-certification claims", async () => {
    const fixture = await createEvidenceFixture();
    const result = await runGate(fixture);
    expect(fixture.bundle.provider).toBe(FAKE_PROVIDER_STATE);
    expect(fixture.bundle.fixture).toBe(FAKE_SIGNING_BOUNDARY);
    const claimed = Object.keys(result).filter((key) => /certif|real_?provider/i.test(key));
    expect(claimed).toEqual([]);
  });

  it("rejects the superseded cosignKey configuration alias", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: s7-config-fixture\nprovenance:\n  cosignKey: keys/legacy.pem\n");
    await expect(loadProjectConfig(root)).rejects.toThrow();
  });

  it("rejects a strict provenance output directory that escapes the project root", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: s7-config-fixture\nprovenance:\n  required: true\n  artifact: dist/candidate.tgz\n  outputDir: ../outside\n");
    await expect(loadProjectConfig(root)).rejects.toThrow();
  });

  it("resolves the current candidate through the configured run directory", async () => {
    const root = await createRoot();
    const taskId = "S7-CUSTOM-RUN-DIR";
    const operationId = "OP-S7-CUSTOM-RUN-DIR";
    const runsDir = ".aeh/custom-runs";
    const candidate = createCandidateRevisionV1({ operationId, candidateId: "candidate:custom-run-dir:r1", projectId: "project-s7-fixture", taskId, revision: 1, sourceDigest: digest("custom-run-dir") });
    await fs.mkdir(path.join(root, runsDir), { recursive: true });
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.writeFile(path.join(root, runsDir, `${taskId}.json`), JSON.stringify({ operationId }));
    await fs.writeFile(path.join(root, ".harness", "operations", `${operationId}.json`), JSON.stringify({ id: operationId, candidateRevision: candidate }));
    const config: HarnessProjectConfig = { version: 1, project: { name: "s7-config-fixture" }, sdd: { runsDir } };
    expect(await currentCandidateForTask(root, taskId, config)).toEqual(candidate);
  });
});

function strictPolicy(overrides: Partial<ProvenancePolicy> = {}): ProvenancePolicy {
  return {
    outputDir: OUTPUT_DIR,
    artifact: ARTIFACT,
    required: true,
    sbom: { required: true },
    signing: { required: true, key: KEY },
    verification: { required: true, publicKey: KEY },
    ...overrides
  };
}

function nonStrictPolicy(): ProvenancePolicy {
  return { outputDir: OUTPUT_DIR, artifact: ARTIFACT, required: false, sbom: { required: false }, signing: { required: false }, verification: { required: false } };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(file: string): Promise<string> {
  return digest(await fs.readFile(file));
}

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s7-provenance-"));
  roots.push(root);
  return root;
}

async function createCandidate(overrides: { candidateId?: string; revision?: number; sourceDigest?: string } = {}): Promise<CandidateRevisionV1> {
  return createCandidateRevisionV1({
    operationId: "OP-S7-FIXTURE",
    candidateId: overrides.candidateId ?? "candidate:OP-S7-FIXTURE:r1",
    projectId: "project-s7-fixture",
    taskId: "S7-FIXTURE",
    revision: overrides.revision ?? 1,
    sourceDigest: overrides.sourceDigest ?? digest("fixture-source-v1"),
    createdAt: "2026-09-24T00:00:00.000Z"
  });
}

async function createEvidenceFixture(options: { policy?: ProvenancePolicy } = {}): Promise<EvidenceFixture> {
  const root = await createRoot();
  const binDir = path.join(root, "fixture-bin");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, OUTPUT_DIR), { recursive: true });
  await fs.mkdir(path.join(root, "keys"), { recursive: true });
  await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "cosign"), FAKE_COSIGN_SCRIPT, { mode: 0o755 });
  await fs.chmod(path.join(binDir, "cosign"), 0o755);

  const artifactFile = path.join(root, ARTIFACT);
  await fs.writeFile(artifactFile, "packed-aeh-fixture-v1\n");
  const sbomRelative = path.posix.join(OUTPUT_DIR, SBOM_NAME);
  const sbomFile = path.join(root, sbomRelative);
  await fs.writeFile(sbomFile, `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { name: "aeh-fixture", version: "0.0.0" } }, components: [] }, null, 2)}\n`);
  const keyFile = path.join(root, KEY);
  await fs.writeFile(keyFile, "fixture-key-A\n");
  const acceptedEvidenceRelative = ".harness/reports/S7-FIXTURE.json";
  const acceptedEvidenceFile = path.join(root, acceptedEvidenceRelative);
  await fs.writeFile(acceptedEvidenceFile, "{\"status\":\"PASS\",\"fixture\":\"deterministic\"}\n");
  const acceptedEvidenceDigest = await digestFile(acceptedEvidenceFile);

  const policy = options.policy ?? strictPolicy();
  const candidate = await createCandidate();
  const manifestRelative = path.posix.join(OUTPUT_DIR, MANIFEST_NAME);
  const statementRelative = path.posix.join(OUTPUT_DIR, STATEMENT_NAME);
  const predicateRelative = path.posix.join(OUTPUT_DIR, PREDICATE_NAME);
  const bundleRelative = path.posix.join(OUTPUT_DIR, BUNDLE_NAME);

  const predicate: EvidencePredicate = {
    buildDefinition: {
      buildType: "https://example.invalid/aeh/s7-deterministic-fixture",
      externalParameters: { project: "s7-provenance-fixture", artifact: ARTIFACT },
      internalParameters: {
        aehBuildIdentity: getBuildIdentity(),
        aehCandidate: { operationId: candidate.operationId, candidateId: candidate.candidateId, revision: candidate.revision, sourceDigest: candidate.sourceDigest, identityDigest: candidate.identityDigest },
        aehSupplyChainPolicyDigest: provenancePolicyDigest({ version: 1, project: { name: "s7-provenance-fixture" }, provenance: policy }),
        artifactSha256: await digestFile(artifactFile),
        sbomArtifactSha256: await digestFile(artifactFile),
        sbomSha256: await digestFile(sbomFile)
      },
      resolvedDependencies: []
    },
    runDetails: { builder: { id: BUILDER_ID }, metadata: { invocationId: "fixture-invocation", startedOn: "2026-09-24T00:00:00.000Z", finishedOn: "2026-09-24T00:01:00.000Z" } }
  };
  const manifest: EvidenceManifest = {
    version: 2,
    candidate,
    subject: { path: ARTIFACT, sha256: await digestFile(artifactFile) },
    buildIdentity: getBuildIdentity(),
    policyDigest: provenancePolicyDigest({ version: 1, project: { name: "s7-provenance-fixture" }, provenance: policy }),
    attestations: { statement: statementRelative, predicate: predicateRelative, bundle: bundleRelative },
    generatedAt: "2026-09-24T00:00:00.000Z",
    taskId: "S7-FIXTURE",
    lineage: { operationId: candidate.operationId, required: [acceptedEvidenceRelative], members: [acceptedEvidenceRelative] },
    entries: [
      { path: ARTIFACT, sha256: await digestFile(artifactFile), kind: "final-artifact" },
      { path: sbomRelative, sha256: await digestFile(sbomFile), kind: "sbom" },
      { path: acceptedEvidenceRelative, sha256: acceptedEvidenceDigest, kind: "validation-report" }
    ]
  };
  const statement: EvidenceStatement = { _type: "https://in-toto.io/Statement/v1", subject: [], predicateType: "https://slsa.dev/provenance/v1", predicate };
  const bundle: FixtureSignatureBundle = { fixture: FAKE_SIGNING_BOUNDARY, provider: FAKE_PROVIDER_STATE, statementSha256: "", keySha256: "", signature: "s7-deterministic-fixture-signature" };

  const fixture: EvidenceFixture = {
    root,
    binDir,
    policy,
    config: { version: 1, project: { name: "s7-provenance-fixture" }, provenance: policy },
    candidate,
    artifactRelative: ARTIFACT,
    artifactFile,
    sbomRelative,
    sbomFile,
    keyRelative: KEY,
    keyFile,
    acceptedEvidenceRelative,
    acceptedEvidenceFile,
    acceptedEvidenceDigest,
    manifestRelative,
    manifestFile: path.join(root, manifestRelative),
    statementRelative,
    statementFile: path.join(root, statementRelative),
    predicateRelative,
    predicateFile: path.join(root, predicateRelative),
    bundleRelative,
    bundleFile: path.join(root, bundleRelative),
    manifest,
    predicate,
    statement,
    bundle
  };
  await persistEvidence(fixture);
  return fixture;
}

async function persistEvidence(fixture: EvidenceFixture, subject?: StatementSubject[]): Promise<void> {
  fixture.manifest.attestations = { statement: fixture.statementRelative, predicate: fixture.predicateRelative, bundle: fixture.bundleRelative };
  await fs.writeFile(fixture.manifestFile, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  const internal = fixture.predicate.buildDefinition.internalParameters;
  internal.artifactManifestSha256 = fixture.manifestDigestOverride ?? await digestFile(fixture.manifestFile);
  internal.artifactSha256 = fixture.manifest.subject.sha256;
  internal.aehCandidate = { operationId: fixture.manifest.candidate.operationId, candidateId: fixture.manifest.candidate.candidateId, revision: fixture.manifest.candidate.revision, sourceDigest: fixture.manifest.candidate.sourceDigest, identityDigest: fixture.manifest.candidate.identityDigest };
  internal.aehSupplyChainPolicyDigest = fixture.manifest.policyDigest;
  if (fixture.manifest.buildIdentity) internal.aehBuildIdentity = fixture.manifest.buildIdentity;
  else delete internal.aehBuildIdentity;
  const sbom = fixture.manifest.entries.find((entry) => entry.kind === "sbom");
  if (sbom) {
    internal.sbomSha256 = sbom.sha256;
    internal.sbomArtifactSha256 = fixture.manifest.subject.sha256;
  } else {
    delete internal.sbomSha256;
    delete internal.sbomArtifactSha256;
  }
  fixture.predicate.buildDefinition.externalParameters.artifact = fixture.manifest.subject.path;
  fixture.statement.subject = subject ?? [{ name: fixture.manifest.subject.path, digest: { sha256: fixture.manifest.subject.sha256 } }];
  await rewriteStatementAndBundle(fixture);
}

async function rewriteStatementAndBundle(fixture: EvidenceFixture): Promise<void> {
  fixture.statement.predicate = fixture.predicate;
  await fs.writeFile(fixture.predicateFile, `${JSON.stringify(fixture.predicate, null, 2)}\n`);
  await fs.writeFile(fixture.statementFile, `${JSON.stringify(fixture.statement, null, 2)}\n`);
  fixture.bundle.statementSha256 = await digestFile(fixture.statementFile);
  fixture.bundle.keySha256 = await digestFile(fixture.keyFile);
  await fs.writeFile(fixture.bundleFile, `${JSON.stringify(fixture.bundle, null, 2)}\n`);
}

async function runGate(fixture: EvidenceFixture, options: { config?: HarnessProjectConfig; candidate?: CandidateRevisionV1; artifactPath?: string } = {}): Promise<{ ok: boolean; failures: string[] }> {
  const previous = process.env.PATH;
  process.env.PATH = `${fixture.binDir}${path.delimiter}${previous ?? ""}`;
  try {
    return await verifySupplyChainGate(fixture.root, options.config ?? fixture.config, { candidate: options.candidate ?? fixture.candidate, artifactPath: options.artifactPath ?? fixture.artifactRelative });
  } finally {
    process.env.PATH = previous;
  }
}

function expectBlocked(result: { ok: boolean; failures: string[] }, pattern: RegExp): void {
  expect(result.ok).toBe(false);
  expect(result.failures.join("\n")).toMatch(pattern);
}

const FAKE_COSIGN_SCRIPT = [
  "#!/usr/bin/env node",
  "const crypto = require('node:crypto');",
  "const fs = require('node:fs');",
  "const args = process.argv.slice(2);",
  "function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }",
  "function flag(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }",
  "try {",
  "  const bundleFile = flag('--bundle');",
  "  const keyFile = flag('--key');",
  "  const statementFile = args[args.length - 1];",
  "  if (args[0] !== 'verify-blob' || !bundleFile || !statementFile || statementFile === bundleFile) process.exit(64);",
  "  const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));",
  "  if (bundle.fixture !== 'deterministic-not-provider-signature' || bundle.provider !== 'NOT_REAL_PROVIDER') process.exit(65);",
  "  if (bundle.statementSha256 !== sha256(statementFile)) process.exit(66);",
  "  if (keyFile) { if (!fs.existsSync(keyFile) || bundle.keySha256 !== sha256(keyFile)) process.exit(67); }",
  "  process.stdout.write('s7-fixture-cosign deterministic fixture verification; not a REAL_PROVIDER signing run\\n');",
  "  process.exit(0);",
  "} catch (error) {",
  "  process.stderr.write(String(error) + '\\n');",
  "  process.exit(68);",
  "}",
  ""
].join("\n");
