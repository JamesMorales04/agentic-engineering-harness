import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(process.env.AEH_S10_PACKED_PACKAGE_ROOT ?? process.argv[2] ?? process.cwd());
const dist = path.join(packageRoot, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const isolation = await import(pathToFileURL(path.join(release, "security/isolation.js")));
const sast = await import(pathToFileURL(path.join(release, "security/sastEvidence.js")));
const external = await import(pathToFileURL(path.join(release, "validators/external.js")));
const contracts = await import(pathToFileURL(path.join(release, "operations/v2Contracts.js")));
const git = await import(pathToFileURL(path.join(release, "core/git.js")));

function resolveTrivy() {
  const configured = process.env.S10_TRIVY_BIN;
  if (configured && configured.trim()) return configured.trim();
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "trivy");
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* next path */ }
  }
  return undefined;
}

const trivy = resolveTrivy();
if (!trivy) {
  console.error(JSON.stringify({ blocker: "SAST_PROVIDER_UNAVAILABLE", message: "trivy is not installed and S10_TRIVY_BIN is not set; the real SAST campaign fails closed instead of skipping." }, null, 2));
  process.exit(2);
}
process.env.PATH = `${path.dirname(trivy)}${path.delimiter}${process.env.PATH ?? ""}`;
const trivyDigest = crypto.createHash("sha256").update(await fs.readFile(trivy)).digest("hex");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s10-real-sast-"));
const credentialsPath = path.join(root, "config", "credentials.ts");
const config = { version: 1, project: { name: "s10-real-sast" }, evidence: { outputDir: ".harness/evidence" }, security: { isolation: { required: true } } };
const contract = { version: 1, task: { id: "S10-SAST-REAL", title: "candidate-bound real SAST" } };
const command = `${trivy} fs --format json --scanners secret,misconfig --skip-db-update --skip-check-update --quiet .`;

async function gitInit() {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "s10@aeh.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "S10 Campaign"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

async function scan(candidate, label) {
  const check = await external.runExternalToolValidator({
    root, config, contract,
    spec: { id: `s10-real-sast-${label}`, adapter: "trivy", command, required: true },
    baseRef: "HEAD", changedFiles: ["config/credentials.ts"], candidate
  });
  const reference = check.details?.sastEvidence;
  const evidence = await sast.requireSastEvidenceV1(root, config, candidate, `s10-real-sast-${label}`);
  return { check, reference, evidence };
}

try {
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "s10-real-sast", version: "1.0.0" }));
  await fs.writeFile(credentialsPath, 'export const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n');
  await gitInit();

  const candidateOne = contracts.createCandidateRevisionV1({ operationId: "OP-S10-REAL", candidateId: "CAND-S10-REAL", revision: 1, sourceDigest: await git.computeWorktreeDigest(root) });
  const first = await scan(candidateOne, "r1");
  const firstRules = [...new Set(first.evidence.findings.map((finding) => finding.rule))].sort();

  await fs.writeFile(credentialsPath, 'export const GITHUB_TOKEN = "";\n');
  await gitInit();
  const candidateTwo = contracts.createCandidateRevisionV1({ operationId: "OP-S10-REAL", candidateId: "CAND-S10-REAL", revision: 2, sourceDigest: await git.computeWorktreeDigest(root) });
  const second = await scan(candidateTwo, "r2");

  const stale = await sast.verifySastEvidenceV1(root, config, first.evidence, candidateTwo);

  const assertions = {
    firstFailedWithFindings: first.check.status === "FAIL" && first.evidence.findingCount > 0,
    secondPassedClean: second.check.status === "PASS" && second.evidence.findingCount === 0,
    toolVersionRecorded: first.evidence.tool.version === "0.70.0" && second.evidence.tool.version === "0.70.0",
    isolationExercised: first.evidence.isolation?.provider === "bwrap" && first.evidence.isolation?.networkAccess === "none" && first.evidence.isolation?.namespaces.network === false,
    candidateBoundExactly: first.evidence.candidate.identityDigest === candidateOne.identityDigest && second.evidence.candidate.identityDigest === candidateTwo.identityDigest,
    firstEvidenceStaleForRevisionTwo: stale.ok === false && stale.blockers.some((blocker) => blocker.includes("SAST_EVIDENCE_STALE")),
    noFabricatedPass: first.reference?.digest === first.evidence.digest && second.reference?.digest === second.evidence.digest
  };
  const failed = Object.entries(assertions).filter(([, value]) => value !== true).map(([name]) => name);
  const summary = {
    version: 1,
    lane: "REAL_PROVIDER (local OSS Trivy) + SYSTEM_DETERMINISTIC (real rootless bwrap execution)",
    release: releaseId,
    tool: { name: "trivy", version: first.evidence.tool.version, binary: trivy, binarySha256: trivyDigest },
    isolation: { provider: first.evidence.isolation?.provider, providerVersion: first.evidence.isolation?.providerVersion, networkAccess: first.evidence.isolation?.networkAccess, namespaces: first.evidence.isolation?.namespaces, visibleReadOnlyPaths: first.evidence.isolation?.visibleReadOnlyPaths, maskedHostPaths: first.evidence.isolation?.maskedHostPaths, writablePaths: first.evidence.isolation?.writablePaths, environmentAllowlist: first.evidence.isolation?.environmentAllowlist },
    candidates: [
      { candidateId: candidateOne.candidateId, revision: 1, identityDigest: candidateOne.identityDigest, sourceDigest: candidateOne.sourceDigest, scan: { status: first.evidence.status, findingCount: first.evidence.findingCount, rules: firstRules, artifact: first.evidence.artifact, digest: first.evidence.digest, rawArtifactDigest: first.evidence.rawArtifactDigest } },
      { candidateId: candidateTwo.candidateId, revision: 2, identityDigest: candidateTwo.identityDigest, sourceDigest: candidateTwo.sourceDigest, scan: { status: second.evidence.status, findingCount: second.evidence.findingCount, artifact: second.evidence.artifact, digest: second.evidence.digest, rawArtifactDigest: second.evidence.rawArtifactDigest } }
    ],
    staleRevisionCheck: { ok: stale.ok, blockers: stale.blockers },
    assertions,
    result: failed.length ? "FAIL" : "PASS"
  };
  const evidenceDir = path.join(packageRoot, "docs", "evidence", "s10");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "real-sast-campaign.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ result: summary.result, failed, release: releaseId, tool: summary.tool, candidates: summary.candidates.map((entry) => ({ revision: entry.revision, status: entry.scan.status, findings: entry.scan.findingCount })) }, null, 2));
  process.exit(failed.length ? 1 : 0);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
