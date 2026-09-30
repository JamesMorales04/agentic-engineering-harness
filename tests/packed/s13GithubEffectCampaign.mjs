import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";
import {
  EXTERNAL_AUTHORIZATION_ENV,
  assertExternalAuthorizationCoversFrozenPolicyV1,
  assertExternalAuthorizationResourceNamesV1,
  externalAuthorizationDecisionInputV1,
  loadExternalEffectAuthorizationV1
} from "./s13ExternalEffectAuthorization.mjs";

/**
 * S13 GitHub external-effect campaign against an explicitly supplied existing PRIVATE repository.
 *
 * Covers the deterministic product issue snapshot/drift gate and a real controller-authority gated
 * external effect (human-approved git.push). It never creates or deletes a repository. Repository,
 * issue and authorization inputs are mandatory and validated before any `gh` command, any staging
 * directory, or any approval is created.
 *
 * AEH-V2-0114 repair: this campaign no longer mints its own HumanDecision approvals. Every
 * ACTION_AUTHORIZATION approval is derived by the typed loader from an externally supplied user
 * authorization artifact (`S13_GH_AUTHORIZATION_FILE`) that declares the owner, PRIVATE_ONLY
 * scope, the allowed effect kinds and the resource-name namespace. A missing, unreadable,
 * out-of-scope or effect-uncovering artifact fails closed before any external command. The default
 * lane reuses the user-authorized existing issue #1; issue creation is only possible when the
 * external authorization covers `github.issue.create` through the governed gate path.
 *
 * Usage: node tests/packed/s13GithubEffectCampaign.mjs [checkout]
 * Required: S13_GH_REUSE_REPO=OWNER/REPO, S13_GH_AUTHORIZATION_FILE=<external user authorization JSON>, S13_ROUND=<round>.
 * Issue: S13_GH_ISSUE=<existing issue number> (default 1, the user-authorized issue) or
 *        S13_GH_CREATE_ISSUE=1 (governed github.issue.create path, only when the authorization covers it).
 * Optional: S13_GH_SKIP_IMPORT=1 (skip the operation-bound issue import attempt)
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const skipImport = process.env.S13_GH_SKIP_IMPORT === "1";
const account = "JamesMorales04";
const reuseRepo = (process.env.S13_GH_REUSE_REPO ?? "").trim();
if (!reuseRepo) throw new Error("S13_GH_REUSE_REPO is required; an explicit pre-authorized repository target must be supplied before effects.");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reuseRepo)) throw new Error("S13_GH_REUSE_REPO must be an explicit OWNER/REPO value.");
const [repoOwner, repoSlug] = reuseRepo.split("/");
if (repoOwner.toLowerCase() !== account.toLowerCase()) throw new Error(`S13_GH_REUSE_REPO owner must match the authenticated account ${account}.`);
const requestedIssue = (process.env.S13_GH_ISSUE ?? "").trim();
const createIssue = process.env.S13_GH_CREATE_ISSUE === "1";
if (createIssue && requestedIssue) throw new Error("Choose either S13_GH_ISSUE or S13_GH_CREATE_ISSUE=1, not both.");
if (requestedIssue && !/^[1-9][0-9]*$/.test(requestedIssue)) throw new Error("S13_GH_ISSUE must be an existing issue number.");
const reuseIssue = createIssue ? 0 : Number(requestedIssue || "1");
if (!createIssue && (!Number.isSafeInteger(reuseIssue) || reuseIssue < 1)) throw new Error("S13_GH_ISSUE must be an existing issue number.");
const issueSource = createIssue ? "gated-external-authorization" : requestedIssue ? "explicit-existing-issue" : "default-user-authorized-issue";
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const repoName = `${repoOwner}/${repoSlug}`;
const campaignEffects = ["git.push", "github.branch.create", ...(createIssue ? ["github.issue.create"] : [])];
const authorization = await loadExternalEffectAuthorizationV1({
  filePath: process.env[EXTERNAL_AUTHORIZATION_ENV],
  owner: repoOwner,
  effects: campaignEffects,
  resourceNames: [`${repoSlug}`]
});
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-gh-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const repoStamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 120_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

async function trackedDigest() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) { hash.update(`path\0${file}\0`); hash.update(await fs.readFile(path.join(checkout, file))); }
  return { digest: hash.digest("hex"), files: files.length };
}

function sanitizeString(value) {
  return value
    .replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED")
    .replace(/(?:x-access-token:)[^@\s]+/g, "x-access-token:REDACTED");
}
function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  return value;
}
function parsePackFilename(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "[") continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      if (record && typeof record.filename === "string") return record.filename;
    } catch { /* keep scanning */ }
  }
  throw new Error("npm pack did not return a JSON artifact record.");
}

const tokenResult = run("gh", ["auth", "token"]);
if (tokenResult.status !== 0 || !tokenResult.stdout) throw new Error("gh auth token unavailable; cannot run the GitHub effect campaign.");
const ghToken = tokenResult.stdout;
process.env.GH_TOKEN = ghToken;
const authStatus = run("gh", ["auth", "status"]);
if (!authStatus.stdout.includes(`account ${account}`) && !authStatus.stderr.includes(`account ${account}`)) throw new Error(`gh is not authenticated as ${account}.`);

const summary = {
  version: 1, slice: "S13", round, runId, roundLabel: `round-${round}/${runId} (attempt-specific summary and lane artifacts are immutable evidence)`, campaign: "github-effects",
  generatedAt: new Date().toISOString(), checkout, sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  authorization: {
    kind: "USER_EXTERNAL_EFFECT_AUTHORIZATION",
    authorizationId: authorization.authorizationId,
    artifactDigest: authorization.artifactDigest,
    owner: authorization.owner,
    privacy: authorization.privacy,
    allowedEffects: authorization.allowedEffects,
    resourceNamePrefix: authorization.resourceNamePrefix,
    consumedBeforeAnyExternalCommand: true,
    campaignSelfAuthorization: "PROHIBITED"
  },
  repository: { name: repoName, visibility: "private", suppliedAsPreAuthorizedInput: true, createdByCampaign: false, verifiedAt: null },
  issueInput: { requested: requestedIssue || null, source: issueSource, createThroughGovernedGate: createIssue },
  lanes: [], result: "UNKNOWN"
};
const before = await trackedDigest();

async function packedBuildIdentity(fixtureRoot) {
  const packageRoot = path.join(fixtureRoot, "node_modules", "agentic-engineering-harness");
  const dist = path.join(packageRoot, "dist");
  const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
  if (!/^release-[A-Za-z0-9._-]+$/.test(releaseId)) throw new Error("Installed packed artifact has no valid current release id.");
  const identity = JSON.parse(await fs.readFile(path.join(dist, "releases", releaseId, "build-identity.json"), "utf8"));
  if (typeof identity.buildDigest !== "string" || typeof identity.gitSha !== "string" || typeof identity.packageVersion !== "string") throw new Error("Installed packed artifact has incomplete build identity.");
  return { releaseId, buildDigest: identity.buildDigest, gitSha: identity.gitSha, packageVersion: identity.packageVersion };
}

async function createTestIssueThroughGate({ fixtureRoot, release, repository, token, campaignRunId, externalAuthorization }) {
  const state = await import(pathToFileURL(path.join(release, "operations", "state.js")));
  const executionIdentity = await import(pathToFileURL(path.join(release, "architecture", "executionIdentity.js")));
  const decisions = await import(pathToFileURL(path.join(release, "security", "humanDecision.js")));
  const gated = await import(pathToFileURL(path.join(release, "security", "gatedAction.js")));
  const toolGate = await import(pathToFileURL(path.join(release, "security", "toolActionGate.js")));
  const reconciliation = await import(pathToFileURL(path.join(release, "security", "actionReconciliation.js")));
  const digest = await import(pathToFileURL(path.join(release, "core", "digest.js")));
  const operationId = `CHANGE-S13-GH-ISSUE-${campaignRunId}`;
  const now = new Date().toISOString();
  await state.saveOperation(fixtureRoot, {
    version: 2, id: operationId, kind: "change", status: "RUNNING", phase: "delivery", root: fixtureRoot,
    payload: { request: "Create the authorized S13 issue-import certification fixture" }, revision: 1, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  });
  await state.claimControllerEpoch(fixtureRoot, operationId, `packed-controller:${process.pid}`, { pid: process.pid });
  const record = await state.loadOperation(fixtureRoot, operationId);
  const effects = ["github.issue.create"];
  const policy = executionIdentity.compileResolvedOperationPolicy({
    projectId: record.candidateRevision.projectId, operationId,
    operationExecutionRevision: record.operationExecutionRevision,
    candidateRevision: record.candidateRevision.revision,
    candidateDigest: record.candidateRevision.identityDigest,
    controllerEpoch: state.currentControllerEpoch(record),
    intent: "create one explicitly authorized S13 issue-import fixture", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: { githubEnabled: true, paseoEnabled: false, allowedExternalEffects: effects },
    knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: effects,
    humanDecisionRequirements: [{ kind: "ACTION_AUTHORIZATION", action: "github.issue.create" }]
  });
  await state.bindResolvedOperationPolicy(fixtureRoot, operationId, policy);
  const bound = await state.loadOperation(fixtureRoot, operationId);
  const candidate = bound.candidateRevision;
  assertExternalAuthorizationCoversFrozenPolicyV1({ authorization: externalAuthorization, policyAllowedEffects: policy.allowedExternalEffects, effects });
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "change";
  process.env.AEH_CONTROL_ROOT = fixtureRoot;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROLLER_EPOCH = String(state.currentControllerEpoch(bound));

  const marker = `AEH-S13-${campaignRunId}`;
  const title = "Create a minimal greeting fixture with a farewell export and validator";
  const body = [
    "## Starting state",
    "The repository has no application source tree. Create every file in this request from scratch; do not assume an existing greeting implementation or validator.",
    "",
    "## Request",
    "Create a minimal Node.js greeting fixture with a `greet` function and a `FAREWELL` export.",
    "",
    "## Acceptance criteria",
    "- Create `package.json` with `npm test` running `node scripts/validate.mjs` and no new dependencies.",
    "- Create `src/greeting.mjs`; `greet('AEH')` returns `Hello, AEH!` and `FAREWELL` equals `Goodbye`.",
    "- Create `scripts/validate.mjs` to assert both greeting exports and exit nonzero on failure.",
    "- `npm test` exits successfully from the repository root.",
    "",
    "## Scope",
    "- `package.json` (new)",
    "- `src/greeting.mjs` (new)",
    "- `scripts/validate.mjs` (new)",
    "",
    `Campaign marker: ${marker}`
  ].join("\n");
  const payload = { repository, title, body, marker };
  const ledger = new decisions.HumanDecisionLedgerV2(path.join(fixtureRoot, ".harness", "security", "human-decisions.json"));
  const humanDecision = await ledger.record(externalAuthorizationDecisionInputV1({
    authorization: externalAuthorization,
    action: "github.issue.create",
    effectDigest: digest.sha256Canonical(payload),
    binding: {
      operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision,
      policyDigest: bound.resolvedOperationPolicy.digest, controllerEpoch: state.currentControllerEpoch(bound)
    }
  }));
  const requestBase = {
    root: fixtureRoot, operationId, participantId: toolGate.controllerActorId(operationId), candidate,
    actionKey: `github:issue:create:${campaignRunId}`, payload,
    authority: { kind: "controller-authority", operationId, controllerEpoch: state.currentControllerEpoch(bound) }
  };
  let created;
  const result = await gated.executeGatedAction({
    root: fixtureRoot,
    request: { ...requestBase, action: "github.issue.create", now: new Date() },
    execute: async () => {
      const response = run("gh", ["issue", "create", "--repo", repository, "--title", title, "--body", body], {
        cwd: fixtureRoot, env: { ...process.env, GH_TOKEN: token }, timeoutMs: 120_000
      });
      if (response.status !== 0) throw new Error(`authorized issue creation failed: ${response.stderr || response.stdout}`);
      const url = response.stdout.split(/\r?\n/).find((line) => line.includes("/issues/")) ?? "";
      const number = Number((url.match(/\/issues\/(\d+)/) ?? [])[1]);
      if (!number) throw new Error(`created issue number could not be parsed from '${response.stdout}'`);
      created = { number, url, exitCode: response.status };
      return { outcome: "SUCCEEDED", evidence: created };
    },
    reconcile: (intent) => reconciliation.reconcileToolAction(fixtureRoot, intent, payload, { token })
  });
  const reconciledIssue = result.reconciliation?.evidence?.issueNumber;
  const issueNumber = created?.number ?? (Number.isSafeInteger(reconciledIssue) ? reconciledIssue : 0);
  const issueUrl = created?.url ?? result.reconciliation?.evidence?.issueUrl;
  return {
    number: issueNumber,
    url: issueUrl ?? null,
    title,
    body,
    marker,
    action: "github.issue.create",
    operationId,
    actionStatus: result.status,
    detail: result.detail,
    humanDecision,
    intent: result.intent,
    receipt: result.receipt ?? null,
    reconciliation: result.reconciliation ?? null
  };
}

try {
  const view = run("gh", ["repo", "view", repoName, "--json", "nameWithOwner,visibility,createdAt,url"], { timeoutMs: 60_000 });
  if (view.status !== 0) throw new Error(`pre-authorized repository verification failed: ${view.stderr || view.stdout}`);
  const repo = JSON.parse(view.stdout);
  if (String(repo.nameWithOwner ?? "").toLowerCase() !== repoName.toLowerCase()) throw new Error("GitHub repository identity does not match S13_GH_REUSE_REPO.");
  if (String(repo.visibility ?? "").toUpperCase() !== "PRIVATE") throw new Error("S13_GH_REUSE_REPO must identify an existing private repository.");
  summary.repository.createdAt = repo.createdAt;
  summary.repository.url = repo.url;
  summary.repository.visibility = repo.visibility;
  summary.repository.verifiedAt = new Date().toISOString();

  const cloneRoot = path.join(staging, "clone");
  const cloned = run("gh", ["repo", "clone", repoName, cloneRoot], { timeoutMs: 180_000 });
  if (cloned.status !== 0) throw new Error(`repository clone failed: ${cloned.stderr || cloned.stdout}`);

  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const artifactPath = path.join(packDir, parsePackFilename(packed.stdout));
  summary.candidate = { artifactDigest: crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex") };
  const installed = run("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", cloneRoot, artifactPath], { timeoutMs: 600_000, cwd: cloneRoot });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr || installed.stdout}`);
  const candidateBinding = { packedArtifact: path.basename(artifactPath), packedArtifactDigest: summary.candidate.artifactDigest, packedBuild: await packedBuildIdentity(cloneRoot), sourceCommit: summary.sourceCommit };
  summary.candidate = { ...summary.candidate, ...candidateBinding };
  const binary = path.join(cloneRoot, "node_modules", "agentic-engineering-harness", "dist", "main.js");
  const env = { ...process.env, GH_TOKEN: ghToken };
  for (const key of Object.keys(env)) if (key.startsWith("AEH_")) delete env[key];
  delete env.PASEO_AGENT_ID;

  for (const [command, args] of [["git", ["config", "user.email", "s13-gh@aeh.invalid"]], ["git", ["config", "user.name", "S13 GitHub Campaign"]]]) run(command, args, { cwd: cloneRoot });
  const init = run(process.execPath, [binary, "init", "."], { cwd: cloneRoot, env, timeoutMs: 300_000 });
  if (init.status !== 0) throw new Error(`fixture init failed: ${init.stderr || init.stdout}`);
  const projectConfig = YAML.parse(await fs.readFile(path.join(cloneRoot, ".harness", "project.yaml"), "utf8"));
  projectConfig.project = { ...(projectConfig.project ?? {}), name: "s13-github-effects" };
  projectConfig.delivery = { ...(projectConfig.delivery ?? {}), github: { ...(projectConfig.delivery?.github ?? {}), enabled: true, tokenEnv: "GH_TOKEN", repository: repoName, finalizeOnAcceptance: true, pullRequestDraft: true } };
  projectConfig.workflow = { ...(projectConfig.workflow ?? {}), issueIntake: { ...(projectConfig.workflow?.issueIntake ?? {}), enabled: true, verifyDriftOnRun: true, requireOpen: true } };
  await fs.writeFile(path.join(cloneRoot, ".harness", "project.yaml"), YAML.stringify(projectConfig));
  const baselineCommit = run("/bin/bash", ["-lc", "git add -A && git commit -q -m 'AEH certification fixture'"], { cwd: cloneRoot });
  if (baselineCommit.status !== 0) throw new Error(`fixture baseline commit failed: ${baselineCommit.stderr || baselineCommit.stdout}`);

  const fixtureDist = path.join(cloneRoot, "node_modules", "agentic-engineering-harness", "dist");
  const installedReleaseId = (await fs.readFile(path.join(fixtureDist, "current"), "utf8")).trim();
  const installedRelease = path.join(fixtureDist, "releases", installedReleaseId);
  let issueNumber = reuseIssue;
  let issueCreation = null;
  if (createIssue) {
    issueCreation = await createTestIssueThroughGate({ fixtureRoot: cloneRoot, release: installedRelease, repository: repoName, token: ghToken, campaignRunId: runId, externalAuthorization: authorization });
    issueNumber = issueCreation.number;
    summary.issue = { number: issueNumber || null, url: issueCreation.url, created: issueNumber > 0, reused: false, source: issueSource, creation: issueCreation };
    for (const key of ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH"]) delete process.env[key];
  } else {
    summary.issue = { number: issueNumber, url: `https://github.com/${repoName}/issues/${issueNumber}`, created: false, reused: true, source: issueSource };
  }

  // Lane: issue-driven (deterministic snapshot + drift gate over the real issue).
  const issueLane = {
    version: 1, slice: "S13", round, runId, capability: "issue-driven", harnessRevisions, candidateBinding, repository: repoName, issueNumber, issueCreation,
    externalAuthorization: createIssue ? { authorizationId: authorization.authorizationId, artifactDigest: authorization.artifactDigest, coveredEffect: "github.issue.create" } : null,
    startedAt: new Date().toISOString(), checks: []
  };
  try {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error(`authorized issue creation did not reconcile to a confirmed issue: ${issueCreation?.actionStatus ?? "missing action"}/${issueCreation?.receipt?.outcome ?? "no successful receipt"}`);
    const inspected = run(process.execPath, [binary, "issue", "inspect", String(issueNumber), "."], { cwd: cloneRoot, env, timeoutMs: 180_000 });
    const contentSha = /contentSha256=([a-f0-9]{64})/.exec(inspected.stdout)?.[1];
    issueLane.inspect = { exitCode: inspected.status, snapshotSha256: contentSha ?? null, stdout: inspected.stdout.slice(0, 1_500) };
    const intake = await import(pathToFileURL(path.join(installedRelease, "issues", "intake.js")));
    const configMod = await import(pathToFileURL(path.join(installedRelease, "core", "config.js")));
    const config = await configMod.loadProjectConfig(cloneRoot);
    const snapshot = await intake.inspectGithubIssue(cloneRoot, config, issueNumber);
    const snapshotPath = path.posix.join(config.workflow?.issueIntake?.snapshotDir ?? ".harness/issues", `GH-${issueNumber}.json`);
    const contract = { version: 1, task: { id: `GH-${issueNumber}`, title: snapshot.snapshot.title }, git: { baseRef: "master" }, scope: { allowed: ["**"] }, routing: { intent: "implement", domains: [], risk: "medium", route: "DIRECT", assurance: "STANDARD" }, constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false }, issue: { provider: "github", repository: snapshot.snapshot.repository, number: snapshot.snapshot.number, url: snapshot.snapshot.url, state: snapshot.snapshot.state, fetchedAt: snapshot.snapshot.fetchedAt, updatedAt: snapshot.snapshot.updatedAt, contentSha256: snapshot.snapshot.contentSha256, snapshotPath } };
    const driftClean = await intake.verifyGithubIssueDrift(cloneRoot, config, contract);
    const staleDigest = contract.issue.contentSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    const staleContract = { ...contract, issue: { ...contract.issue, contentSha256: staleDigest } };
    const driftStaleSnapshot = await intake.verifyGithubIssueDrift(cloneRoot, config, staleContract);
    issueLane.drift = { cleanSnapshot: driftClean, staleSnapshot: { ok: driftStaleSnapshot.ok, message: driftStaleSnapshot.message }, mutation: "none; compares the live issue with an intentionally stale frozen content digest" };
    issueLane.checks = [
      { id: "issue.snapshot", ok: inspected.status === 0 && Boolean(contentSha) && driftClean.ok, message: `frozen snapshot ${contentSha?.slice(0, 12) ?? "missing"} matches live issue #${issueNumber}` },
      { id: "issue.drift-gate", ok: driftStaleSnapshot.ok === false && /ISSUE_DRIFT/.test(driftStaleSnapshot.message), message: driftStaleSnapshot.message.slice(0, 200) }
    ];
    if (issueCreation) {
      const issueAuthorizationBound = issueCreation.humanDecision?.actorId === `human:external-authorization:${authorization.authorizationId}`
        && issueCreation.humanDecision?.reason.includes(authorization.artifactDigest);
      issueLane.checks.push({ id: "issue.external-authorization", ok: issueAuthorizationBound, message: `gated issue creation approval derived from external authorization ${authorization.authorizationId}` });
    }
    if (!skipImport) {
      const imported = run(process.execPath, [binary, "issue", "import", String(issueNumber), "."], { cwd: cloneRoot, env, timeoutMs: Number(process.env.S13_GH_IMPORT_TIMEOUT_MS ?? "900000") });
      issueLane.operationImport = { exitCode: imported.status, stdout: imported.stdout.slice(0, 1_200), stderr: imported.stderr.slice(0, 1_200) };
      issueLane.checks.push({ id: "issue.operation-import", ok: imported.status === 0, message: imported.status === 0 ? "operation-bound issue import completed" : `issue import blocked: ${(imported.stderr || imported.stdout).split("\n")[0]?.slice(0, 200)}` });
    } else {
      issueLane.operationImport = { skipped: true };
      issueLane.checks.push({ id: "issue.operation-import", ok: false, skipped: true, message: "operation-bound issue import was explicitly skipped" });
    }
    issueLane.result = skipImport && issueLane.checks.filter((entry) => entry.id !== "issue.operation-import").every((entry) => entry.ok)
      ? "PARTIAL"
      : issueLane.checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
  } catch (error) {
    issueLane.error = String(error?.stack ?? error);
    issueLane.result = "FAIL";
  }
  issueLane.finishedAt = new Date().toISOString();
  summary.lanes.push({ capability: "issue-driven", result: issueLane.result, checks: issueLane.checks, artifact: `docs/evidence/s13/github-lanes/round-${round}/${runId}/issue-driven.json` });
  await fs.mkdir(path.join(staging, "lanes"), { recursive: true });
  await fs.writeFile(path.join(staging, "lanes", "issue-driven.json"), `${sanitizeEvidence(JSON.stringify(issueLane, null, 2))}\n`);

  // Lane: authority (real human decision + real gated external effect).
  const authorityLane = { version: 1, slice: "S13", round, runId, capability: "authority", harnessRevisions, candidateBinding, repository: repoName, startedAt: new Date().toISOString(), checks: [] };
  try {
    const fixtureRelease = path.join(cloneRoot, "node_modules", "agentic-engineering-harness", "dist");
    const current = (await fs.readFile(path.join(fixtureRelease, "current"), "utf8")).trim();
    const release = path.join(fixtureRelease, "releases", current);
    const state = await import(pathToFileURL(path.join(release, "operations", "state.js")));
    const executionIdentity = await import(pathToFileURL(path.join(release, "architecture", "executionIdentity.js")));
    const decisions = await import(pathToFileURL(path.join(release, "security", "humanDecision.js")));
    const gated = await import(pathToFileURL(path.join(release, "security", "gatedAction.js")));
    const toolGate = await import(pathToFileURL(path.join(release, "security", "toolActionGate.js")));
    const operationId = "CHANGE-S13-GH-AUTHORITY";
    const now = new Date().toISOString();
    await state.saveOperation(cloneRoot, {
      version: 2, id: operationId, kind: "change", status: "RUNNING", phase: "delivery", root: cloneRoot,
      payload: { request: "publish authority certification branch" }, revision: 1, operationExecutionRevision: 1,
      createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    });
    await state.claimControllerEpoch(cloneRoot, operationId, `packed-controller:${process.pid}`, { pid: process.pid });
    const record = await state.loadOperation(cloneRoot, operationId);
    const effects = ["git.push", "github.branch.create"];
    const policy = executionIdentity.compileResolvedOperationPolicy({
      projectId: record.candidateRevision.projectId, operationId,
      operationExecutionRevision: record.operationExecutionRevision,
      candidateRevision: record.candidateRevision.revision,
      candidateDigest: record.candidateRevision.identityDigest,
      controllerEpoch: state.currentControllerEpoch(record),
      intent: "publish authority certification branch", route: "DIRECT", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
      deliveryPolicy: { githubEnabled: true, paseoEnabled: false, allowedExternalEffects: effects },
      knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: effects,
      humanDecisionRequirements: [{ kind: "ACTION_AUTHORIZATION", action: "git.push" }]
    });
    await state.bindResolvedOperationPolicy(cloneRoot, operationId, policy);
    const bound = await state.loadOperation(cloneRoot, operationId);
    const candidate = bound.candidateRevision;
    assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects: policy.allowedExternalEffects, effects });
    const branch = `aeh-s13-authority-${repoStamp}`;
    assertExternalAuthorizationResourceNamesV1({ authorization, resourceNames: [branch] });
    await fs.writeFile(path.join(cloneRoot, `authority-${repoStamp}.txt`), `S13 authority certification ${new Date().toISOString()}\n`);
    run("/bin/bash", ["-lc", `git checkout -q -b ${branch} && git add -A && git commit -q -m 'S13 authority certification commit'`], { cwd: cloneRoot });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "change";
    process.env.AEH_CONTROL_ROOT = cloneRoot;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROLLER_EPOCH = String(state.currentControllerEpoch(bound));
    const payload = { branch, commit: run("git", ["rev-parse", "HEAD"], { cwd: cloneRoot }).stdout, repository: repoName };
    const requestBase = { root: cloneRoot, operationId, participantId: toolGate.controllerActorId(operationId), candidate, actionKey: `github:push:${branch}`, payload };
    let deniedStatus = "UNKNOWN";
    try {
      const denied = await gated.executeGatedAction({
        root: cloneRoot,
        request: { ...requestBase, action: "git.push", authority: { kind: "controller-authority", operationId, controllerEpoch: state.currentControllerEpoch(bound) } },
        execute: async () => ({ outcome: "FAILED", evidence: { reason: "must not execute without human authorization" } }),
        reconcile: async () => ({ outcome: "UNKNOWN", detail: "no effect was authorized" })
      });
      deniedStatus = denied.status;
      authorityLane.humanGate = { status: denied.status, detail: denied.detail.slice(0, 200) };
    } catch (error) {
      deniedStatus = /TOOL_ACTION_HUMAN_DECISION_REQUIRED/.test(String(error?.message ?? error)) ? "HUMAN_REQUIRED" : "ERROR";
      authorityLane.humanGate = { status: deniedStatus, detail: sanitizeString(String(error?.message ?? error)).slice(0, 200) };
    }
    const ledger = new decisions.HumanDecisionLedgerV2(path.join(cloneRoot, ".harness", "security", "human-decisions.json"));
    const { sha256Canonical } = await import(pathToFileURL(path.join(release, "core", "digest.js")));
    const effectDigest = sha256Canonical(payload);
    const humanDecision = await ledger.record(externalAuthorizationDecisionInputV1({
      authorization,
      action: "git.push",
      effectDigest,
      binding: {
        operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision,
        policyDigest: bound.resolvedOperationPolicy.digest, controllerEpoch: state.currentControllerEpoch(bound)
      }
    }));
    const executed = await gated.executeGatedAction({
      root: cloneRoot,
      request: { ...requestBase, action: "git.push", authority: { kind: "controller-authority", operationId, controllerEpoch: state.currentControllerEpoch(bound) }, now: new Date() },
      execute: async () => {
        const pushed = run("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: cloneRoot, env: { ...process.env, GH_TOKEN: ghToken }, timeoutMs: 180_000 });
        return { outcome: pushed.status === 0 ? "SUCCEEDED" : "FAILED", evidence: { exitCode: pushed.status, stderr: sanitizeString(pushed.stderr).slice(0, 500), branch } };
      },
      reconcile: async () => {
        const remote = run("git", ["ls-remote", "--heads", "origin", branch], { cwd: cloneRoot, env: { ...process.env, GH_TOKEN: ghToken }, timeoutMs: 120_000 });
        return { outcome: remote.stdout.trim() ? "SUCCEEDED" : "UNKNOWN", detail: remote.stdout.trim() ? "remote branch exists" : "remote branch missing", evidence: { branch } };
      }
    });
    authorityLane.externalAuthorization = {
      authorizationId: authorization.authorizationId,
      artifactDigest: authorization.artifactDigest,
      coveredEffects: ["git.push", "github.branch.create"],
      consumedBeforeAnyExternalCommand: true
    };
    authorityLane.humanDecision = humanDecision;
    authorityLane.gatedAction = { status: executed.status, action: executed.intent?.action ?? "git.push", intent: executed.intent, receipt: executed.receipt ?? null, reconciliation: executed.reconciliation ?? null, reconciliationStrategy: `git ls-remote --heads origin ${branch}`, detail: executed.detail.slice(0, 200) };
    const remoteRef = run("gh", ["api", `repos/${repoName}/git/ref/heads/${branch}`, "--jq", ".ref,.object.sha"], { cwd: cloneRoot, env: { ...process.env, GH_TOKEN: ghToken }, timeoutMs: 120_000 });
    authorityLane.remoteRef = { exitCode: remoteRef.status, stdout: remoteRef.stdout.slice(0, 300) };
    const authorizationBound = humanDecision.actorId === `human:external-authorization:${authorization.authorizationId}`
      && humanDecision.reason.includes(authorization.artifactDigest)
      && humanDecision.purpose?.effectDigest === effectDigest;
    authorityLane.checks = [
      { id: "authority.external-authorization", ok: authorizationBound, message: `approval derived from external authorization ${authorization.authorizationId} (sha256 ${authorization.artifactDigest.slice(0, 12)}) bound to the exact effect digest` },
      { id: "authority.human-gate", ok: deniedStatus === "HUMAN_REQUIRED", message: `unapproved external effect status=${deniedStatus}` },
      { id: "authority.approved-effect", ok: executed.status === "EXECUTED" && executed.receipt?.outcome === "SUCCEEDED", message: `approved effect status=${executed.status}/${executed.receipt?.outcome ?? "no-receipt"}` },
      { id: "authority.real-github-ref", ok: remoteRef.status === 0 && remoteRef.stdout.includes(branch), message: `real remote branch ${branch} observed on ${repoName}` }
    ];
    authorityLane.result = authorityLane.checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
  } catch (error) {
    authorityLane.error = String(error?.stack ?? error);
    authorityLane.result = "FAIL";
  }
  authorityLane.finishedAt = new Date().toISOString();
  summary.lanes.push({ capability: "authority", result: authorityLane.result, checks: authorityLane.checks, artifact: `docs/evidence/s13/github-lanes/round-${round}/${runId}/authority.json` });
  await fs.writeFile(path.join(staging, "lanes", "authority.json"), `${sanitizeEvidence(JSON.stringify(authorityLane, null, 2))}\n`);

  // Lane: delivery (accepted candidate -> authorized delivery intent -> ActionIntent ->
  // ToolActionGate -> real GitHub effect -> ActionReceipt -> reconciliation -> durable terminal
  // state). The external authorization covers git.push and github.branch.create but not
  // github.pull-request.create, so the frozen delivery policy requests exactly the authorized
  // effects (`pullRequests: false`) and no pull request is ever attempted.
  const deliveryLane = { version: 1, slice: "S13", round, runId, capability: "delivery", harnessRevisions, candidateBinding, repository: repoName, issueNumber: reuseIssue, startedAt: new Date().toISOString(), checks: [] };
  try {
    const fixtureRelease = path.join(cloneRoot, "node_modules", "agentic-engineering-harness", "dist");
    const current = (await fs.readFile(path.join(fixtureRelease, "current"), "utf8")).trim();
    const release = path.join(fixtureRelease, "releases", current);
    const state = await import(pathToFileURL(path.join(release, "operations", "state.js")));
    const executionIdentity = await import(pathToFileURL(path.join(release, "architecture", "executionIdentity.js")));
    const v2 = await import(pathToFileURL(path.join(release, "operations", "v2Contracts.js")));
    const configMod = await import(pathToFileURL(path.join(release, "core", "config.js")));
    const contractMod = await import(pathToFileURL(path.join(release, "core", "contract.js")));
    const sealMod = await import(pathToFileURL(path.join(release, "core", "seal.js")));
    const gitMod = await import(pathToFileURL(path.join(release, "core", "git.js")));
    const digest = await import(pathToFileURL(path.join(release, "core", "digest.js")));
    const acceptance = await import(pathToFileURL(path.join(release, "architecture", "acceptanceOracle.js")));
    const deliveryMod = await import(pathToFileURL(path.join(release, "delivery", "finalize.js")));
    const handoff = await import(pathToFileURL(path.join(release, "delivery", "handoff.js")));
    const decisions = await import(pathToFileURL(path.join(release, "security", "humanDecision.js")));
    const intake = await import(pathToFileURL(path.join(release, "issues", "intake.js")));

    // A dedicated clean clone: the delivery repo must contain exactly the accepted candidate
    // change, not the packed-candidate install tree of the first clone.
    const deliveryRoot = path.join(staging, "delivery-clone");
    const clonedDelivery = run("gh", ["repo", "clone", repoName, deliveryRoot], { timeoutMs: 300_000, env: { ...process.env, GH_TOKEN: ghToken } });
    if (clonedDelivery.status !== 0) throw new Error(`delivery clone failed: ${clonedDelivery.stderr || clonedDelivery.stdout}`);
    for (const [command, args] of [["git", ["config", "user.email", "s13-gh@aeh.invalid"]], ["git", ["config", "user.name", "S13 GitHub Campaign"]]]) run(command, args, { cwd: deliveryRoot });
    const baseBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: deliveryRoot }).stdout.trim();
    // The accepted candidate commits on its own local branch; the authorized delivery branch is
    // created by the product handoff and receives the candidate via the gated push refspec.
    const candidateBranch = `aeh-s13-delivery-candidate-${runId}`;
    const switched = run("git", ["checkout", "-q", "-b", candidateBranch], { cwd: deliveryRoot });
    if (switched.status !== 0) throw new Error(`delivery candidate branch creation failed: ${switched.stderr || switched.stdout}`);

    const config = await configMod.loadProjectConfig(deliveryRoot);
    config.delivery = { ...(config.delivery ?? {}), github: { ...(config.delivery?.github ?? {}), enabled: true, tokenEnv: "GH_TOKEN", repository: repoName, finalizeOnAcceptance: true, pullRequests: false, branchPattern: "aeh-s13-delivery-{issue}-{slug}" } };
    const snapshot = await intake.inspectGithubIssue(deliveryRoot, config, reuseIssue);
    const taskId = `GH-${reuseIssue}`;
    const { contract } = await contractMod.createRoutedContract(deliveryRoot, config, taskId, {
      title: `S13 delivery certification change ${runId}`,
      request: "Deliver the accepted certification candidate to the authorized issue-linked branch.",
      scope: ["**"],
      acceptance: ["The accepted candidate is pushed to its authorized issue-linked branch."],
      routeDecision: { route: "DIRECT", assurance: "STANDARD", mechanism: "DETERMINISTIC", reasons: ["S13 delivery certification fixture"], routeEvidence: [] }
    });
    contract.issue = { provider: "github", repository: repoName, number: reuseIssue, url: `https://github.com/${repoName}/issues/${reuseIssue}`, state: snapshot.snapshot.state, fetchedAt: snapshot.snapshot.fetchedAt, updatedAt: snapshot.snapshot.updatedAt, contentSha256: snapshot.snapshot.contentSha256, snapshotPath: path.posix.join(config.workflow?.issueIntake?.snapshotDir ?? ".harness/issues", `GH-${reuseIssue}.json`) };
    contract.git = { baseRef: baseBranch, originatingBranch: baseBranch };
    await fs.writeFile(path.join(deliveryRoot, ".harness", "contracts", `${taskId}.yaml`), YAML.stringify(contract));
    await sealMod.sealTask(deliveryRoot, config, contract);
    await handoff.seedDeliveryRecordFromIssue(deliveryRoot, config, contract, { repository: repoName, issueNumber: reuseIssue, issueUrl: `https://github.com/${repoName}/issues/${reuseIssue}` });

    const operationId = `CHANGE-S13-GH-DELIVERY-${runId}`;
    const now = new Date().toISOString();
    await state.saveOperation(deliveryRoot, {
      version: 2, id: operationId, kind: "change", status: "RUNNING", phase: "delivery", root: deliveryRoot,
      payload: { request: "S13 delivery certification", taskId }, revision: 1, operationExecutionRevision: 1,
      createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    });
    await state.claimControllerEpoch(deliveryRoot, operationId, `packed-controller:${process.pid}`, { pid: process.pid });
    const initial = await state.loadOperation(deliveryRoot, operationId);
    const changePath = `s13-delivery-${runId}.txt`;
    await fs.writeFile(path.join(deliveryRoot, changePath), `S13 delivery certification candidate ${runId} ${new Date().toISOString()}\n`);
    const sourceDigest = await gitMod.computeWorktreeDigest(deliveryRoot);
    const candidate = v2.createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r2`, projectId: initial.candidateRevision.projectId, taskId, revision: 2, parentCandidateId: initial.candidateRevision.candidateId, sourceDigest, worktree: deliveryRoot, createdAt: new Date().toISOString() });
    await state.bindOperationCandidate(deliveryRoot, operationId, candidate);
    const effects = ["git.push", "github.branch.create"];
    const boundBeforePolicy = await state.loadOperation(deliveryRoot, operationId);
    const policy = executionIdentity.compileResolvedOperationPolicy({
      projectId: candidate.projectId, operationId,
      operationExecutionRevision: boundBeforePolicy.operationExecutionRevision,
      candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest,
      controllerEpoch: state.currentControllerEpoch(boundBeforePolicy),
      intent: "S13 delivery certification", route: "DIRECT", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
      deliveryPolicy: { githubEnabled: true, paseoEnabled: false, allowedExternalEffects: effects },
      knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: effects,
      humanDecisionRequirements: [{ kind: "ACTION_AUTHORIZATION", action: "git.push" }]
    });
    await state.bindResolvedOperationPolicy(deliveryRoot, operationId, policy);
    const bound = await state.loadOperation(deliveryRoot, operationId);
    assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects: policy.allowedExternalEffects, effects });
    const branch = handoff.renderPattern(config.delivery.github.branchPattern, contract, reuseIssue);
    assertExternalAuthorizationResourceNamesV1({ authorization, resourceNames: [branch] });
    deliveryLane.frozenDeliveryPolicy = { route: "DIRECT", allowedExternalEffects: effects, pullRequests: false, branch };

    const identity = acceptance.currentObjectiveIdentityV1(bound);
    const evidenceBase = { assertionId: "ASSERT-DELIVERY", identity, strength: "ELEVATED" };
    // R17-F3: the frozen delivery row requires the [delivery-record, provenance] evidence tokens.
    // Evaluate the canonical S7 supply-chain gate against the bound candidate and record its
    // explicit policy determination (the fixture requests no provenance artifact, so the gate is
    // evaluated truthfully with an empty artifact path and its result is bound to the lane).
    const provenanceMod = await import(pathToFileURL(path.join(release, "provenance", "generate.js")));
    const provenancePolicy = { required: config.provenance?.required === true, artifact: config.provenance?.artifact ?? null, signingRequired: config.provenance?.signing?.required === true, verificationRequired: config.provenance?.verification?.required === true };
    const supplyChain = await provenanceMod.verifySupplyChainGate(deliveryRoot, config, { candidate: bound.candidateRevision, artifactPath: config.provenance?.artifact ?? "" });
    const evidence = [
      { version: 1, id: "validation:REQ-DELIVERY:ASSERT-DELIVERY", ...evidenceBase, kind: "VALIDATION", status: "PASS", provenance: { sourceId: "REQ-DELIVERY", digest: digest.sha256Canonical("delivery-validation") } },
      { version: 1, id: "review:reviewer:s13-delivery:architecture:ASSERT-DELIVERY", ...evidenceBase, kind: "REVIEW", status: "PASS", dimension: "architecture", reviewerIdentity: "reviewer:s13-delivery", provider: "s13-delivery-campaign", provenance: { sourceId: "session:s13-delivery", digest: digest.sha256Canonical("delivery-review"), executionBindingDigest: digest.sha256Canonical("delivery-review-binding") } }
    ];
    const requirement = { version: 1, id: "verification:ASSERT-DELIVERY", assertionId: "ASSERT-DELIVERY", statement: "delivery candidate is ready", minimumAssurance: "STANDARD", validationRequirementIds: ["REQ-DELIVERY"], reviewDimensions: ["architecture"], leadRequired: false };
    const bundleBody = { version: 1, identity, candidate: bound.candidateRevision, impactDigest: digest.sha256Canonical("delivery-impact"), compilationDigest: digest.sha256Canonical("delivery-compilation"), requirements: [requirement], evidence };
    const bundle = { ...bundleBody, digest: digest.sha256Canonical(bundleBody) };
    const disposition = acceptance.evaluateAcceptanceOracleV1(bundle, { minimumAssurance: "ELEVATED", minimumIndependentReviewers: 1, providerDiversity: false, requiredDimensions: ["architecture"] });
    if (disposition.disposition !== "ACCEPTED") throw new Error(`delivery fixture acceptance oracle did not accept: ${disposition.blockers.map((blocker) => blocker.code).join(", ")}`);
    const acceptanceArtifact = await acceptance.persistAcceptanceOracleArtifactV1(state.resolveOperationStateRoot(deliveryRoot), bundle, disposition);

    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "change";
    process.env.AEH_CONTROL_ROOT = deliveryRoot;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    process.env.AEH_CONTROLLER_EPOCH = String(state.currentControllerEpoch(bound));

    let deniedStatus = "UNKNOWN";
    try {
      await deliveryMod.finalizeAcceptedIssue(deliveryRoot, config, contract, { candidate: bound.candidateRevision });
      deniedStatus = "UNEXPECTEDLY_ALLOWED";
    } catch (error) {
      deniedStatus = /TOOL_ACTION_HUMAN_DECISION_REQUIRED/.test(String(error?.message ?? error)) ? "HUMAN_REQUIRED" : `ERROR:${String(error?.message ?? error).slice(0, 160)}`;
    }
    deliveryLane.humanGate = { status: deniedStatus };
    const commitSha = run("git", ["rev-parse", "HEAD"], { cwd: deliveryRoot }).stdout.trim();
    const pushPayload = { remote: "origin", ref: branch, expectedCommit: commitSha };
    const ledger = new decisions.HumanDecisionLedgerV2(path.join(deliveryRoot, ".harness", "security", "human-decisions.json"));
    const humanDecision = await ledger.record(externalAuthorizationDecisionInputV1({
      authorization,
      action: "git.push",
      effectDigest: digest.sha256Canonical(pushPayload),
      binding: { operationId, candidate: bound.candidateRevision, operationExecutionRevision: bound.operationExecutionRevision, policyDigest: bound.resolvedOperationPolicy.digest, controllerEpoch: state.currentControllerEpoch(bound) }
    }));
    const finalized = await deliveryMod.finalizeAcceptedIssue(deliveryRoot, config, contract, { candidate: bound.candidateRevision });
    const deliveryRecord = await handoff.loadDeliveryRecord(deliveryRoot, config, taskId);
    const deliveryRecordDigest = deliveryRecord ? digest.sha256Canonical(deliveryRecord) : null;
    const remoteRef = run("gh", ["api", `repos/${repoName}/git/ref/heads/${branch}`, "--jq", ".object.sha"], { cwd: deliveryRoot, env: { ...process.env, GH_TOKEN: ghToken }, timeoutMs: 120_000 });
    const openPrs = run("gh", ["api", `repos/${repoName}/pulls?state=open&head=${encodeURIComponent(`${repoOwner}:${branch}`)}`, "--jq", "length"], { cwd: deliveryRoot, env: { ...process.env, GH_TOKEN: ghToken }, timeoutMs: 120_000 });
    const localHead = run("git", ["rev-parse", "HEAD"], { cwd: deliveryRoot }).stdout.trim();
    const drift = await intake.verifyGithubIssueDrift(deliveryRoot, config, contract);
    const actionDir = path.join(deliveryRoot, ".harness", "security", "tool-actions", digest.sha256Utf8(operationId).slice(0, 32));
    const actionFiles = await fs.readdir(actionDir).catch(() => []);
    const receipts = [];
    for (const file of actionFiles.filter((entry) => entry.endsWith(".receipt.json"))) {
      try { receipts.push(JSON.parse(await fs.readFile(path.join(actionDir, file), "utf8"))); } catch { /* bounded */ }
    }
    const intents = actionFiles.filter((entry) => entry.endsWith(".intent.json"));
    const receiptActions = receipts.map((receipt) => receipt.action).sort();
    const pushOnly = !receiptActions.includes("github.pull-request.create") && !actionFiles.some((file) => file.includes("pull-request"));

    deliveryLane.acceptedCandidate = { operationId, candidateId: candidate.candidateId, revision: candidate.revision, sourceDigest: candidate.sourceDigest, identityDigest: candidate.identityDigest, acceptanceArtifact, acceptanceDisposition: disposition.disposition, acceptanceDispositionDigest: disposition.digest };
    deliveryLane.externalAuthorization = { authorizationId: authorization.authorizationId, artifactDigest: authorization.artifactDigest, coveredEffects: authorization.allowedEffects, exactEffectDigest: digest.sha256Canonical(pushPayload) };
    deliveryLane.humanDecision = humanDecision;
    deliveryLane.finalized = { status: finalized.status, committed: finalized.committed, commitSha: finalized.commitSha ?? null, pushed: finalized.pushed, pullRequest: finalized.pullRequest ?? null, message: finalized.message };
    deliveryLane.gatedActions = { intents: intents.length, receiptActions, branchDisposition: receiptActions.includes("github.branch.create") ? "created" : "reused" };
    deliveryLane.reconciliation = { remoteRefExitCode: remoteRef.status, remoteRefSha: remoteRef.stdout.trim(), localHead, openPullRequests: openPrs.status === 0 ? Number(openPrs.stdout.trim() || "0") : null };
    deliveryLane.deliveryRecord = { taskId, digest: deliveryRecordDigest, branch: deliveryRecord?.github?.branch ?? null, issueNumber: deliveryRecord?.github?.issueNumber ?? null, repository: deliveryRecord?.github?.repository ?? null, status: deliveryRecord?.status ?? null, finalizedAt: deliveryRecord?.updatedAt ?? null };
    deliveryLane.provenance = { policy: provenancePolicy, gate: { ok: supplyChain.ok === true, failures: supplyChain.failures ?? [] }, note: "S7 supply-chain gate evaluated against the bound accepted candidate; the fixture requests no provenance artifact, so the explicit policy determination is recorded rather than a fabricated manifest (R17-F3)." };
    deliveryLane.issueDrift = { ok: drift.ok, message: drift.message.slice(0, 200), issueCreated: false, issueEdited: false };
    const pushReceipt = receipts.find((receipt) => receipt.action === "git.push");
    deliveryLane.checks = [
      { id: "delivery.accepted-candidate", ok: candidate.revision >= 2 && disposition.disposition === "ACCEPTED" && Boolean(acceptanceArtifact), message: `candidate r${candidate.revision} with persisted accepted AcceptanceOracle (${disposition.coveredAssertionIds.length} assertions)` },
      { id: "delivery.external-authorization", ok: humanDecision.actorId === `human:external-authorization:${authorization.authorizationId}` && humanDecision.reason.includes(authorization.artifactDigest) && humanDecision.purpose?.effectDigest === digest.sha256Canonical(pushPayload), message: `approval derived from external authorization ${authorization.authorizationId} bound to the exact git.push effect digest` },
      { id: "delivery.human-gate", ok: deniedStatus === "HUMAN_REQUIRED", message: `unapproved delivery push status=${deniedStatus}` },
      { id: "delivery.real-effect", ok: finalized.status === "FINALIZED" && finalized.pushed === true && pushReceipt?.outcome === "SUCCEEDED" && remoteRef.status === 0 && remoteRef.stdout.trim() === localHead, message: `finalized=${finalized.status} pushed=${finalized.pushed} remote ${branch}@${remoteRef.stdout.trim().slice(0, 12) || "missing"}` },
      { id: "delivery.push-only", ok: pushOnly && (deliveryLane.reconciliation.openPullRequests === 0), message: `no pull-request intent/receipt and ${deliveryLane.reconciliation.openPullRequests ?? "unobserved"} open pull request(s) for ${branch}` },
      { id: "delivery.receipts", ok: intents.length >= 3 && ["git.commit", "git.push", "github.branch.create"].every((action) => receiptActions.includes(action)), message: `${intents.length} intent(s); receipts: ${receiptActions.join(", ")}` },
      { id: "delivery.issue-untouched", ok: drift.ok === true, message: `authorized issue #${reuseIssue} unchanged: ${drift.message.slice(0, 120)}` },
      { id: "delivery.delivery-record", ok: Boolean(deliveryRecord) && deliveryRecord.github?.issueNumber === reuseIssue && typeof deliveryRecord.github?.branch === "string" && typeof deliveryRecordDigest === "string", message: `durable delivery record ${taskId} issue=#${deliveryRecord?.github?.issueNumber ?? "missing"} branch=${deliveryRecord?.github?.branch ?? "missing"} digest=${(deliveryRecordDigest ?? "missing").slice(0, 16)}` },
      { id: "delivery.provenance", ok: supplyChain.ok === true && provenancePolicy.required === false, message: `S7 supply-chain gate ok=${supplyChain.ok} artifactPath=${config.provenance?.artifact ?? "<none>"} required=${provenancePolicy.required}; explicit no-artifact policy determination recorded`, evidence: { policy: provenancePolicy, failures: supplyChain.failures ?? [] } }
    ];
    deliveryLane.result = deliveryLane.checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
  } catch (error) {
    deliveryLane.error = String(error?.stack ?? error);
    deliveryLane.result = "FAIL";
  }
  deliveryLane.finishedAt = new Date().toISOString();
  summary.lanes.push({ capability: "delivery", result: deliveryLane.result, checks: deliveryLane.checks, artifact: `docs/evidence/s13/github-lanes/round-${round}/${runId}/delivery.json` });
  await fs.writeFile(path.join(staging, "lanes", "delivery.json"), `${sanitizeEvidence(JSON.stringify(deliveryLane, null, 2))}\n`);
} finally {
  delete process.env.GH_TOKEN;
  for (const key of ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH"]) delete process.env[key];
}

const after = await trackedDigest();
summary.checkoutProof = { trackedDigestBefore: before.digest, trackedDigestAfter: after.digest, trackedFiles: before.files, checkoutUntouched: before.digest === after.digest, postRunTrackedDocEditWindow: { opensAfter: new Date().toISOString(), note: "R17-F8: tracked documentation/evidence writes after this timestamp are expected; compare source digests only within a run window." }, note: "Tracked digest captured before packing and after the GitHub effect lanes; no candidate executes in this checkout." };
summary.result = summary.lanes.some((lane) => lane.result === "FAIL") ? "SLICE_BLOCKED" : summary.lanes.some((lane) => lane.result === "BLOCKED" || lane.result === "PARTIAL") ? "SLICE_BLOCKED" : "PASS";
const roundLaneRoot = path.join(evidenceRoot, `github-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
for (const entry of await fs.readdir(path.join(staging, "lanes"))) await fs.copyFile(path.join(staging, "lanes", entry), path.join(roundLaneRoot, entry));
const summaryPath = path.join(evidenceRoot, `s13-github-effects-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const digest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, repository: summary.repository, lanes: summary.lanes, immutableSummaryDigest: digest, evidence: path.relative(checkout, summaryPath) }, null, 2));
await fs.rm(staging, { recursive: true, force: true });
process.exit(summary.result === "SLICE_BLOCKED" || !summary.checkoutProof.checkoutUntouched ? 1 : 0);
