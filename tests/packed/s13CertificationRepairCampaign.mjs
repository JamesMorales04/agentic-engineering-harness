import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * S13 round-18 `certification-repair` packed campaign.
 *
 * One bounded REAL_PROVIDER execution of the frozen certification matrix row:
 *   deterministic oracle failure (persisted failure packet) -> real Codex repair actor ->
 *   oracle re-check -> ACCEPTED, with the candidate tree identity unchanged (the repaired
 *   artifact is an ignored fixture path, so the frozen tree digest stays stable).
 *
 * Usage: S13_ROUND=18 S13_RUN_ID=<id> node tests/packed/s13CertificationRepairCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");

const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const certify = await import(pathToFileURL(path.join(release, "certification", "index.js")));
const gitModule = await import(pathToFileURL(path.join(release, "core", "git.js")));
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-certrepair-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const laneRoot = path.join(staging, "lanes");
await fs.mkdir(laneRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error ? String(result.error) : undefined };
}

function sanitizeString(value) {
  return String(value)
    .replace(/#pair=[^\s"'\\]+/g, "#pair=REDACTED")
    .replace(/controlCenterPairing=[^\s"'\\]+/g, "controlCenterPairing=REDACTED")
    .replace(/([?&](?:token|code|nonce|csrf)=)[^\s"'\\&]+/gi, "$1REDACTED")
    .replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED");
}

function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  return value;
}

async function trackedDigest() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(`path\0${file}\0`);
    hash.update(await fs.readFile(path.join(checkout, file)));
  }
  return { digest: hash.digest("hex"), files: files.length };
}

function parsePackFilename(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "[") continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      if (record && typeof record.filename === "string" && record.filename.endsWith(".tgz") && path.basename(record.filename) === record.filename) return record.filename;
    } catch { /* keep scanning */ }
  }
  throw new Error("npm pack did not return a JSON artifact record.");
}

async function packedBuildIdentity(fixtureRoot) {
  const packageRoot = path.join(fixtureRoot, "node_modules", "agentic-engineering-harness");
  const packageDist = path.join(packageRoot, "dist");
  const current = (await fs.readFile(path.join(packageDist, "current"), "utf8").catch(() => "")).trim();
  if (!/^release-[A-Za-z0-9._-]+$/.test(current)) return {};
  try {
    const raw = JSON.parse(await fs.readFile(path.join(packageDist, "releases", current, "build-identity.json"), "utf8"));
    return { packedBuildRelease: current, packedBuildDigest: raw.buildDigest, packedBuildGitSha: raw.gitSha };
  } catch { return {}; }
}

// -------------------------------------------------------------------------------------------------
// Disposable fixture (ignored .harness/answer.txt is the repaired artifact, so the frozen tree
// digest of the candidate cannot change during the repair turn).
// -------------------------------------------------------------------------------------------------

async function writeFixtureSource() {
  const source = path.join(staging, "fixture-source");
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.mkdir(path.join(source, ".harness"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), `${JSON.stringify({ name: "s13-certification-repair-fixture", version: "1.0.0", private: true, scripts: { oracle: "node scripts/oracle.mjs" } }, null, 2)}\n`);
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n.harness/\ndist/\n");
  await fs.writeFile(path.join(source, ".harness", "answer.txt"), "pending\n");
  await fs.writeFile(path.join(source, "scripts", "oracle.mjs"), [
    "import fs from \"node:fs\";",
    "const value = fs.existsSync(\".harness/answer.txt\") ? fs.readFileSync(\".harness/answer.txt\", \"utf8\").trim() : \"\";",
    "if (value !== \"42\") {",
    "  console.error(`ORACLE_FAILED: .harness/answer.txt=${JSON.stringify(value)}`);",
    "  process.exit(1);",
    "}",
    "console.log(\"ORACLE_PASS\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(source, "README.md"), "# S13 certification-repair fixture\n\nThe deterministic oracle requires `.harness/answer.txt` to contain exactly `42`.\n");
  return source;
}

async function prepareFixture(artifactPath) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-certrepair-fixture-"));
  await fs.cp(await writeFixtureSource(), fixtureRoot, { recursive: true, force: true });
  for (const [command, args] of [["git", ["init", "-q", "-b", "master"]], ["git", ["config", "core.fsmonitor", "false"]], ["git", ["config", "user.email", "s13-certrepair@aeh.invalid"]], ["git", ["config", "user.name", "S13 Certification Repair"]], ["git", ["add", "-A"]], ["git", ["commit", "-q", "-m", "certification repair fixture baseline"]]]) {
    const result = run(command, args, { cwd: fixtureRoot });
    if (result.status !== 0) throw new Error(`fixture setup failed (${command}): ${result.stderr || result.stdout}`);
  }
  const artifact = path.join(fixtureRoot, ".aeh-candidate.tgz");
  await fs.copyFile(artifactPath, artifact);
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
  const candidate = {
    version: 1,
    id: path.basename(artifactPath, ".tgz"),
    root: fixtureRoot,
    artifactPath: artifact,
    baseRef: "packed-checkout",
    sourceDigest: artifactDigest,
    packedArtifactDigest: artifactDigest,
    treeDigest: await gitModule.computeWorktreeDigest(fixtureRoot),
    metadata: { packaging: "npm-pack-ignore-scripts", ...(await packedBuildIdentity(fixtureRoot)) }
  };
  return { fixtureRoot, candidate };
}

function makeOracle({ capabilityJourneyEvidence, failurePacketRef }) {
  return {
    id: `s13-certification-repair:${runId}`,
    independent: true,
    async evaluate({ candidate, actor, attempt }) {
      const result = run(process.execPath, ["scripts/oracle.mjs"], { cwd: candidate.root, timeoutMs: 120_000 });
      const answerPassed = result.status === 0 && /ORACLE_PASS/.test(result.stdout);
      const actorEvidence = actor?.executionEvidence?.started === true && actor?.structuredOutput !== undefined && actor?.status === "COMPLETED" && actor?.exitCode === 0;
      const failurePacket = failurePacketRef?.();
      const recheck = answerPassed && Number(attempt) >= 1;
      const checks = [
        { id: "fixture.answer", status: answerPassed ? "PASS" : "FAIL", required: true, message: answerPassed ? "Deterministic fixture oracle passed." : `Deterministic fixture oracle failed (exit ${result.status}).`, evidence: { exitCode: result.status, stdout: result.stdout.slice(-1_000), stderr: result.stderr.slice(-1_000) } },
        { id: "model.evidence", status: actorEvidence ? "PASS" : "FAIL", required: true, message: actorEvidence ? "Oracle verified a started real provider receipt." : "Oracle did not verify a started real provider receipt.", evidence: { actorProvider: actor?.provider ?? null, actorStatus: actor?.status ?? null, actorExitCode: actor?.exitCode ?? null, structuredOutput: actor?.structuredOutput !== undefined, started: actor?.executionEvidence?.started === true, capabilityJourneyEvidence } },
        { id: "failure-packet", status: failurePacket ? "PASS" : "FAIL", required: true, message: failurePacket ? `Canonical deterministic failure packet present (${failurePacket.certificationId} attempt=${failurePacket.repairAttempt}).` : "No canonical failure packet was produced before this certification attempt.", evidence: failurePacket ? { certificationId: failurePacket.certificationId, reason: failurePacket.reason, repairAttempt: failurePacket.repairAttempt, failures: failurePacket.failures.map((failure) => failure.id) } : undefined },
        { id: "oracle-recheck", status: recheck ? "PASS" : "FAIL", required: true, message: recheck ? `Oracle re-check on repair attempt ${attempt} passed.` : "Oracle re-check requires a completed repair attempt.", evidence: { attempt: Number(attempt) || 0, answer: result.stdout.trim().slice(-200) } }
      ];
      return certify.createCertificationOracleResult({ oracleId: `s13-certification-repair:${runId}`, checks, evidence: { command: "node scripts/oracle.mjs", capabilityJourneyEvidence, failurePacket: Boolean(failurePacket), recheck } });
    }
  };
}

function actorRequest(fixtureRoot) {
  return {
    version: 1,
    requestId: `s13-certrepair-actor-${Date.now()}`,
    role: "actor",
    prompt: "Inspect .harness/answer.txt in this disposable fixture and reply with its current content. Do not modify any file.",
    cwd: path.resolve(fixtureRoot),
    command: "codex",
    args: [],
    timeoutMs: 8 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    allowNetwork: true,
    environmentAllowlist: [],
    credentialEnvAllowlist: []
  };
}

function repairRequest(fixtureRoot) {
  return {
    version: 1,
    requestId: `s13-certrepair-repair-${Date.now()}`,
    role: "repair",
    prompt: "This disposable certification fixture fails its deterministic oracle because .harness/answer.txt does not contain the required value. Write exactly 42 (a single line containing the two characters 4 and 2, no extra text) into .harness/answer.txt using the available file tooling. Do not modify any other file, script or requirement; you cannot accept or certify anything.",
    cwd: path.resolve(fixtureRoot),
    command: "codex",
    args: [],
    timeoutMs: 8 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    allowNetwork: true,
    environmentAllowlist: [],
    credentialEnvAllowlist: []
  };
}

// -------------------------------------------------------------------------------------------------
// Campaign
// -------------------------------------------------------------------------------------------------

const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));
const before = await trackedDigest();
const summary = {
  version: 1,
  slice: "S13",
  round,
  runId,
  campaign: "certification-repair",
  generatedAt: new Date().toISOString(),
  checkout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  harnessBuildIdentity: buildIdentity,
  lanes: [],
  result: "UNKNOWN"
};

const laneEvidence = { version: 1, slice: "S13", round, runId, capability: "certification-repair", providerPath: "FULL_OPERATION_REAL_CERTIFICATION", harnessRevisions, startedAt: new Date().toISOString(), candidate: null };
try {
  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const filename = parsePackFilename(packed.stdout);
  const artifactPath = path.join(packDir, filename);
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
  const { fixtureRoot, candidate } = await prepareFixture(artifactPath);
  laneEvidence.candidate = { id: candidate.id, root: fixtureRoot, artifactDigest, treeDigest: candidate.treeDigest, packedBuild: candidate.metadata };

  const provider = new certify.CodexAgentProvider({ model: "gpt-6-luna", reasoningEffort: "low" });

  // 1) Deterministic failure run: repair disabled, no actor. The oracle fails against the frozen
  //    candidate and the report persists the canonical CertificationFailurePacket.
  const failurePolicy = certify.defaultCertificationPolicy({ id: "s13-certification-repair-failure", repair: { enabled: false, maxAttempts: 0, humanOnExhaustion: false }, security: { ...certify.defaultCertificationPolicy().security, allowNetwork: true } });
  const failureCore = new certify.CertificationCore(makeOracle({ capabilityJourneyEvidence: "failure-run" }), provider);
  const failureReport = await failureCore.certify({ candidate, policy: failurePolicy, capability: "certification-repair" });
  laneEvidence.failureRun = {
    certificationId: failureReport.certificationId,
    state: failureReport.state,
    accepted: failureReport.accepted,
    oracle: { status: failureReport.oracle.status, checks: failureReport.oracle.checks.map((check) => ({ id: check.id, status: check.status, message: check.message })), failures: failureReport.oracle.failures },
    failurePacket: failureReport.failurePacket ?? null,
    attempts: failureReport.attempts
  };

  // 2) Real-provider repair run: a real Codex actor turn records model execution evidence, the
  //    deterministic oracle fails, one bounded real Codex repair turn repairs the ignored
  //    artifact, and the oracle re-check accepts the same candidate identity.
  const repairPolicy = certify.defaultCertificationPolicy({ id: "s13-certification-repair-repair", budget: { maxAttempts: 4, maxDurationMs: 30 * 60_000, maxOutputBytes: 4 * 1024 * 1024, requireUsageForTokenBudget: true }, repair: { enabled: true, maxAttempts: 1, humanOnExhaustion: true }, security: { ...certify.defaultCertificationPolicy().security, allowNetwork: true } });
  const repairCore = new certify.CertificationCore(makeOracle({ capabilityJourneyEvidence: "repair-run", failurePacketRef: () => failureReport.failurePacket }), provider);
  const repairReport = await repairCore.certify({
    candidate,
    policy: repairPolicy,
    actor: actorRequest(fixtureRoot),
    repair: { create: (_attempt, _failures, root) => repairRequest(root?.root ?? fixtureRoot) },
    capability: "certification-repair",
    requireModelE2E: true,
    requireModelEvidence: true
  });
  const repairedAnswer = (await fs.readFile(path.join(fixtureRoot, ".harness", "answer.txt"), "utf8").catch(() => "")).trim();
  const observedTreeDigest = await gitModule.computeWorktreeDigest(fixtureRoot);
  const providerResults = repairReport.providerResults.map((result) => ({
    role: result.role,
    provider: result.provider,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    usage: result.usage,
    executionEvidence: result.executionEvidence ?? null,
    commandExecutions: certify.actorCommandExecutions(result).map((execution) => ({ command: execution.command.slice(0, 300), exitCode: execution.exitCode, output: execution.output.slice(-500) }))
  }));
  laneEvidence.repairRun = {
    certificationId: repairReport.certificationId,
    state: repairReport.state,
    accepted: repairReport.accepted,
    assurance: repairReport.assurance,
    oracle: { status: repairReport.oracle.status, checks: repairReport.oracle.checks.map((check) => ({ id: check.id, status: check.status, message: check.message })), failures: repairReport.oracle.failures },
    attempts: repairReport.attempts,
    repairAttempts: repairReport.attempts.filter((attempt) => attempt.role === "repair").length,
    providerResults,
    candidateTreeStable: observedTreeDigest === candidate.treeDigest,
    repairedAnswer,
    failurePacketAbsentBecauseAccepted: repairReport.failurePacket === undefined
  };
  laneEvidence.checks = [
    { id: "certification-repair.failure-packet", ok: failureReport.failurePacket?.version === 1 && failureReport.failurePacket?.deterministic === true && (failureReport.failurePacket?.failures?.length ?? 0) >= 1, message: `failure packet persisted reason=${failureReport.failurePacket?.reason ?? "missing"} failures=${(failureReport.failurePacket?.failures ?? []).map((failure) => failure.id).join(",") || "none"}` },
    { id: "certification-repair.oracle-recheck", ok: repairReport.accepted === true && repairReport.state === "ACCEPTED" && repairReport.oracle.status === "PASS" && repairedAnswer === "42" && observedTreeDigest === candidate.treeDigest, message: `state=${repairReport.state} oracle=${repairReport.oracle.status} repaired=${JSON.stringify(repairedAnswer)} repairTurns=${laneEvidence.repairRun.repairAttempts} treeStable=${observedTreeDigest === candidate.treeDigest}` },
    { id: "certification-repair.real-repair-provider", ok: providerResults.some((result) => result.role === "repair" && result.executionEvidence?.started === true && result.status === "COMPLETED"), message: `${providerResults.filter((result) => result.role === "repair").length} real repair provider receipt(s)` },
    { id: "certification-repair.cannot-self-accept", ok: failureReport.accepted === false && repairReport.assurance !== "INSUFFICIENT", message: `failed run accepted=${failureReport.accepted}; repaired run accepted by deterministic oracle only` }
  ];
  laneEvidence.result = laneEvidence.checks.every((check) => check.ok) ? "PASS" : "FAIL";
} catch (error) {
  laneEvidence.result = "FAIL";
  laneEvidence.error = String(error?.stack ?? error);
}

laneEvidence.finishedAt = new Date().toISOString();
laneEvidence.durationMs = Date.parse(laneEvidence.finishedAt) - Date.parse(laneEvidence.startedAt);
const after = await trackedDigest();
laneEvidence.checkoutProof = {
  trackedDigestBefore: before.digest,
  trackedDigestAfter: after.digest,
  trackedFiles: before.files,
  checkoutUntouched: before.digest === after.digest,
  postRunTrackedDocEditWindow: { opensAfterLaneFinish: true, note: "S13 tracked documentation/evidence is edited after lane execution; the recorded digest is the source-tree digest at lane end (R11-F6)." }
};
await fs.writeFile(path.join(laneRoot, "certification-repair.json"), `${sanitizeEvidence(JSON.stringify(laneEvidence, null, 2))}\n`);
summary.lanes.push({ capability: "certification-repair", result: laneEvidence.result, state: laneEvidence.repairRun?.state ?? null, accepted: laneEvidence.repairRun?.accepted ?? false, checks: laneEvidence.checks ?? null, error: laneEvidence.error ?? null, artifact: `docs/evidence/s13/certification-repair-lanes/round-${round}/${runId}/certification-repair.json` });
summary.result = laneEvidence.result === "PASS" ? "PASS" : "SLICE_BLOCKED";

const roundLaneRoot = path.join(evidenceRoot, `certification-repair-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
for (const entry of await fs.readdir(laneRoot)) await fs.copyFile(path.join(laneRoot, entry), path.join(roundLaneRoot, entry));
const summaryPath = path.join(evidenceRoot, `s13-certification-repair-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
await fs.rm(staging, { recursive: true, force: true });
process.exit(summary.result === "PASS" && summary.lanes[0].checkoutUntouched !== false && laneEvidence.checkoutProof.checkoutUntouched ? 0 : 1);
