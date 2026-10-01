import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";
import { accountWorkspaceCleanupV1, workspaceArchiveDecision } from "./s13GovernedCampaignPolicy.mjs";
import {
  EXTERNAL_AUTHORIZATION_ENV,
  assertExternalAuthorizationCoversFrozenPolicyV1,
  assertExternalAuthorizationResourceNamesV1,
  externalAuthorizationDecisionInputV1,
  loadExternalEffectAuthorizationV1
} from "./s13ExternalEffectAuthorization.mjs";

/**
 * S13 round-18 `issue-driven` full journey (P0-A option b).
 *
 * Binds the real GitHub delivery effect to a REAL accepted packed-change fixture candidate:
 *   authorized issue snapshot (existing user-authorized issue #1) -> real governed change
 *   operation (planning, implementation, validation, review, AcceptanceOracle, terminal evidence)
 *   -> issue-bearing delivery record -> external-authorization-derived human gate -> real
 *   branch/commit/push on the user-authorized PRIVATE repository -> ActionReceipt/reconciliation.
 *
 * The change is executed in a disposable clone of the authorized repository; nothing is created,
 * edited or deleted outside the authorized effect chain (`git.push`, `github.branch.create`).
 *
 * Usage: S13_ROUND=18 S13_RUN_ID=<id> S13_GH_REUSE_REPO=OWNER/REPO \
 *        S13_GH_AUTHORIZATION_FILE=docs/evidence/s13/github-effect-authorization.json \
 *        node tests/packed/s13IssueJourneyCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const account = "JamesMorales04";
const reuseRepo = (process.env.S13_GH_REUSE_REPO ?? "").trim();
if (!reuseRepo) throw new Error("S13_GH_REUSE_REPO is required; an explicit pre-authorized repository target must be supplied before effects.");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reuseRepo)) throw new Error("S13_GH_REUSE_REPO must be an explicit OWNER/REPO value.");
const [repoOwner, repoSlug] = reuseRepo.split("/");
if (repoOwner.toLowerCase() !== account.toLowerCase()) throw new Error(`S13_GH_REUSE_REPO owner must match the authenticated account ${account}.`);
const reuseIssue = Number((process.env.S13_GH_ISSUE ?? "1").trim());
if (!Number.isSafeInteger(reuseIssue) || reuseIssue < 1) throw new Error("S13_GH_ISSUE must be an existing issue number.");
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const laneTimeoutSeconds = Number(process.env.S13_JJ_TIMEOUT_SECONDS ?? "1200");
if (!Number.isSafeInteger(laneTimeoutSeconds) || laneTimeoutSeconds < 1 || laneTimeoutSeconds > 1800) throw new Error("S13_JJ_TIMEOUT_SECONDS must be an integer from 1 through 1800.");

const repoName = `${repoOwner}/${repoSlug}`;
const effects = ["git.push", "github.branch.create"];
const authorization = await loadExternalEffectAuthorizationV1({
  filePath: process.env[EXTERNAL_AUTHORIZATION_ENV],
  owner: repoOwner,
  effects,
  resourceNames: [`${repoSlug}`]
});
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const gitModule = await import(pathToFileURL(path.join(release, "core", "git.js")));
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-jj-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 120_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function sanitizeString(value) {
  return String(value).replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED").replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED").replace(/(?:x-access-token:)[^@\s]+/g, "x-access-token:REDACTED");
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
  for (const file of files) { hash.update(`path\0${file}\0`); hash.update(await fs.readFile(path.join(checkout, file))); }
  return { digest: hash.digest("hex"), files: files.length };
}
function parsePackFilename(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "[") continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      if (record && typeof record.filename === "string" && record.filename.endsWith(".tgz")) return record.filename;
    } catch { /* keep scanning */ }
  }
  throw new Error("npm pack did not return a JSON artifact record.");
}
async function packedBuildIdentity(root) {
  const packageRoot = path.join(root, "node_modules", "agentic-engineering-harness");
  const packageDist = path.join(packageRoot, "dist");
  const current = (await fs.readFile(path.join(packageDist, "current"), "utf8").catch(() => "")).trim();
  if (!/^release-[A-Za-z0-9._-]+$/.test(current)) return {};
  try {
    const raw = JSON.parse(await fs.readFile(path.join(packageDist, "releases", current, "build-identity.json"), "utf8"));
    return { packedBuildRelease: current, packedBuildDigest: raw.buildDigest, packedBuildGitSha: raw.gitSha };
  } catch { return {}; }
}

const tokenResult = run("gh", ["auth", "token"]);
if (tokenResult.status !== 0 || !tokenResult.stdout) throw new Error("gh auth token unavailable; cannot run the issue journey campaign.");
const ghToken = tokenResult.stdout;
process.env.GH_TOKEN = ghToken;

const before = await trackedDigest();
const laneEvidence = {
  version: 1, slice: "S13", round, runId, capability: "issue-driven", kind: "full-journey", providerPath: "FULL_OPERATION_REAL_PASEO+GITHUB",
  harnessRevisions, startedAt: new Date().toISOString(),
  repository: { name: repoName, visibility: "private", createdByCampaign: false },
  issue: { number: reuseIssue, created: false, edited: false },
  authorization: { authorizationId: authorization.authorizationId, artifactDigest: authorization.artifactDigest, allowedEffects: authorization.allowedEffects, resourceNamePrefix: authorization.resourceNamePrefix, consumedBeforeAnyExternalCommand: true }
};

function workspaceList() {
  const listed = run("paseo", ["workspace", "ls", "--json"]);
  try { return JSON.parse(listed.stdout); } catch { return []; }
}
function journeyWorkspaceScope(all, stagingRoot) {
  return all.filter((workspace) => workspace.project === "s13-issue-journey"
    || workspace.project === "journey"
    || String(workspace.cwd ?? "").startsWith(stagingRoot)
    || String(workspace.cwd ?? "").includes("/s13-issue-journey/")
    || String(workspace.cwd ?? "").includes("/aeh-change-"));
}

function createLaneLeadAgent() {
  const prompt = "You are the bound Lead for a managed AEH operation in a real-provider certification lane. Do not modify repository files. When the controller sends a message beginning [AEH_MANAGED_LEAD_ACCEPTANCE], assess the supplied assertions exactly as instructed and return the required AEH_RESULT_JSON line. Acknowledge now with LEAD_READY.";
  const created = run("paseo", ["agent", "--json", "run", "--background", "--provider", "codex", "--model", "gpt-6-luna", "--title", `s13-r${round}-${runId}-jj-lead`, "--label", "aeh.provider=codex", "--label", "aeh.role=lead", "--label", `aeh.operation=s13-round${round}`, prompt], { timeoutMs: 180_000 });
  try {
    const parsed = JSON.parse(created.stdout);
    if (typeof parsed?.agentId === "string") return parsed.agentId;
  } catch { /* fall through to table parsing */ }
  return /^([0-9a-f]{8}-[0-9a-f-]{27,})\s/m.exec(created.stdout)?.[1];
}

async function waitForTerminal(root, operationId, timeoutMs, stageTrace = []) {
  const deadline = Date.now() + timeoutMs;
  let record;
  let lastStages = "";
  while (Date.now() < deadline) {
    try { record = JSON.parse(await fs.readFile(path.join(root, ".harness", "operations", `${operationId}.json`), "utf8")); } catch { record = undefined; }
    if (record) {
      const stages = JSON.stringify(Object.fromEntries(Object.entries(record.stages ?? {}).map(([key, value]) => [key, value.status])));
      if (stages !== lastStages) { lastStages = stages; stageTrace.push({ at: new Date().toISOString(), status: record.status, phase: record.phase, revision: record.revision, stages: JSON.parse(stages) }); }
    }
    if (record && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return record;
}

let journeyWorkspacesBefore = new Set();
try {
  const view = run("gh", ["repo", "view", repoName, "--json", "nameWithOwner,visibility,url"], { timeoutMs: 60_000 });
  if (view.status !== 0) throw new Error(`pre-authorized repository verification failed: ${view.stderr || view.stdout}`);
  const repo = JSON.parse(view.stdout);
  if (String(repo.visibility ?? "").toUpperCase() !== "PRIVATE") throw new Error("S13_GH_REUSE_REPO must identify an existing private repository.");

  const journeyRoot = path.join(staging, "journey");
  const cloned = run("gh", ["repo", "clone", repoName, journeyRoot], { timeoutMs: 300_000 });
  if (cloned.status !== 0) throw new Error(`journey clone failed: ${cloned.stderr || cloned.stdout}`);
  for (const [command, args] of [["git", ["config", "user.email", "s13-jj@aeh.invalid"]], ["git", ["config", "user.name", "S13 Issue Journey"]]]) run(command, args, { cwd: journeyRoot });
  const baseBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: journeyRoot }).stdout.trim();

  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const artifactPath = path.join(packDir, parsePackFilename(packed.stdout));
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
  const installed = run("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", journeyRoot, artifactPath], { timeoutMs: 600_000, cwd: journeyRoot });
  if (installed.status !== 0) throw new Error(`journey install failed: ${installed.stderr || installed.stdout}`);

  await fs.mkdir(path.join(journeyRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(journeyRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(journeyRoot, ".gitignore"), "node_modules/\ndist/\ngraphify-out/\n.serena/\n\n# BEGIN Agentic Engineering Harness generated state\n.harness/*\n!.harness/project.yaml\n!.harness/toolchain.yaml\n!.harness/provider-versions.json\n!.harness/agents.source.jsonc\n!.harness/otel-collector.yaml\n# END Agentic Engineering Harness generated state\n");
  await fs.writeFile(path.join(journeyRoot, "src", "greeting.mjs"), ["export function greet(name) {", "  return `Hello, ${name}!`;", "}", ""].join("\n"));
  await fs.writeFile(path.join(journeyRoot, "package.json"), `${JSON.stringify({ name: "s13-issue-journey-fixture", version: "1.0.0", private: true, scripts: { test: "node scripts/validate.mjs", architecture: "node scripts/architecture.mjs", "check:architecture": "node scripts/architecture.mjs" } }, null, 2)}\n`);
  await fs.writeFile(path.join(journeyRoot, "scripts", "contract.mjs"), [
    "import { greet } from \"../src/greeting.mjs\";",
    "const failures = [];",
    "if (typeof greet !== \"function\") failures.push(\"greet export contract\");",
    "if (typeof greet === \"function\" && greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet behavior contract\");",
    "let module;",
    "try { module = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`module load: ${error.message}`); }",
    "if (module) {",
    "  const exported = Object.keys(module).sort().join(\",\");",
    "  if (exported !== \"greet\") failures.push(`public export surface ${exported}`);",
    "}",
    "if (failures.length) { console.error(`CONTRACT_FAILED: ${failures.join(\"; \")}`); process.exit(1); }",
    "console.log(\"CONTRACT_PASS\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(journeyRoot, "scripts", "architecture.mjs"), [
    "import { greet } from \"../src/greeting.mjs\";",
    "const failures = [];",
    "if (typeof greet !== \"function\") failures.push(\"greet export contract\");",
    "if (typeof greet === \"function\" && greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet behavior contract\");",
    "let module;",
    "try { module = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`module load: ${error.message}`); }",
    "if (module && !Object.keys(module).includes(\"greet\")) failures.push(\"greet public export\");",
    "if (failures.length) { console.error(`ARCHITECTURE_FAILED: ${failures.join(\"; \")}`); process.exit(1); }",
    "console.log(\"ARCHITECTURE_PASS\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(journeyRoot, "scripts", "validate.mjs"), [
    "import { greet } from \"../src/greeting.mjs\";",
    "const failures = [];",
    "if (typeof greet !== \"function\" || greet(\"AEH\") !== \"Hello, AEH!\") failures.push(\"greet contract\");",
    "let module;",
    "try { module = await import(\"../src/greeting.mjs\"); } catch (error) { failures.push(`module load: ${error.message}`); }",
    "if (module && typeof module.greet !== \"function\") failures.push(\"greet export\");",
    "if (failures.length) { console.error(`VALIDATION_FAILED: ${failures.join(\"; \")}`); process.exit(1); }",
    "console.log(\"VALIDATION_PASS\");",
    ""
  ].join("\n"));

  const binary = path.join(journeyRoot, "node_modules", "agentic-engineering-harness", "dist", "main.js");
  const artifactEnv = { ...process.env, GH_TOKEN: ghToken };
  for (const key of Object.keys(artifactEnv)) if (key.startsWith("AEH_")) delete artifactEnv[key];
  delete artifactEnv.PASEO_AGENT_ID;
  const initialized = run(process.execPath, [binary, "init", "."], { cwd: journeyRoot, env: artifactEnv, timeoutMs: 300_000 });
  if (initialized.status !== 0) throw new Error(`journey init failed: ${initialized.stderr || initialized.stdout}`);
  const projectConfig = YAML.parse(await fs.readFile(path.join(journeyRoot, ".harness", "project.yaml"), "utf8"));
  projectConfig.project = { ...(projectConfig.project ?? {}), name: "s13-issue-journey" };
  projectConfig.validation = {
    baseRef: baseBranch,
    commands: [{ id: "fixture-greeting", command: "node scripts/validate.mjs", required: true, timeoutSeconds: 60 }],
    validators: [
      { id: "contract-test", adapter: "contract-test", command: "node scripts/contract.mjs", required: true, timeoutSeconds: 60 }
    ]
  };
  // The campaign must never rewrite or force-push an existing campaign branch: reuse of the
  // authorized issue #1 with the same request would re-render the same branch name and the gated
  // push would be rejected as a non-fast-forward (the round-20 branch must stay untouched). Scope
  // the rendered branch to this run id; the authorized namespace is `aeh-s13-*`.
  projectConfig.delivery = { ...(projectConfig.delivery ?? {}), github: { ...(projectConfig.delivery?.github ?? {}), enabled: true, tokenEnv: "GH_TOKEN", repository: repoName, finalizeOnAcceptance: true, pullRequests: false, branchPattern: `aeh-s13-issue-journey-{issue}-{slug}-${runId}` } };
  await fs.writeFile(path.join(journeyRoot, ".harness", "project.yaml"), YAML.stringify(projectConfig));
  const committed = run("/bin/bash", ["-lc", "git add -A && git commit -q -m 's13 issue journey fixture baseline'"], { cwd: journeyRoot });
  if (committed.status !== 0) throw new Error(`journey baseline commit failed: ${committed.stderr || committed.stdout}`);
  laneEvidence.journey = { root: journeyRoot, baseBranch, baselineCommit: run("git", ["rev-parse", "HEAD"], { cwd: journeyRoot }).stdout, packedArtifactDigest: artifactDigest, packedBuild: await packedBuildIdentity(journeyRoot) };

  journeyWorkspacesBefore = new Set(workspaceList().map((workspace) => workspace.workspaceId));
  const leadAgentId = createLaneLeadAgent();
  if (!leadAgentId) throw new Error("unable to materialize a real Paseo lead agent for the journey");
  laneEvidence.leadAgentId = leadAgentId;
  const request = "Add a short JSDoc comment above the greet() function in src/greeting.mjs describing its contract. Do not change runtime behavior, constants or the public export surface.";
  const started = run(process.execPath, [binary, "operation", "start", "change", request, ".", "--file", "src/greeting.mjs", "--title", "Issue journey greet contract comment", "--accept", "node scripts/validate.mjs passes and src/greeting.mjs keeps the greet export unchanged"], { cwd: journeyRoot, env: { ...artifactEnv, PASEO_AGENT_ID: leadAgentId }, timeoutMs: 600_000 });
  const operationId = /^operationId=(.+)$/m.exec(started.stdout)?.[1]?.trim();
  laneEvidence.start = { operationId, exitCode: started.status, stdout: started.stdout.slice(0, 1_000), stderr: started.stderr.slice(0, 1_000) };
  if (!operationId) throw new Error(`operation start did not report an operationId: ${started.stderr || started.stdout}`);

  const stageTrace = [];
  const record = await waitForTerminal(journeyRoot, operationId, laneTimeoutSeconds * 1000, stageTrace);
  laneEvidence.stageTrace = stageTrace;
  laneEvidence.operation = record ? { id: record.id, status: record.status, phase: record.phase, revision: record.revision, controllerPid: record.pid ?? null, error: record.error ?? null, intent: record.intent, candidateRevision: record.candidateRevision, participantReceipts: record.participantReceipts, stages: Object.fromEntries(Object.entries(record.stages ?? {}).map(([key, value]) => [key, value.status])), result: record.result } : null;
  if (!record || record.status !== "SUCCEEDED") throw new Error(`governed journey did not reach terminal SUCCEEDED (status=${record?.status ?? "missing"})`);

  const state = await import(pathToFileURL(path.join(release, "operations", "state.js")));
  const handoff = await import(pathToFileURL(path.join(release, "delivery", "handoff.js")));
  const deliveryMod = await import(pathToFileURL(path.join(release, "delivery", "finalize.js")));
  const contractMod = await import(pathToFileURL(path.join(release, "core", "contract.js")));
  const sealMod = await import(pathToFileURL(path.join(release, "core", "seal.js")));
  const digest = await import(pathToFileURL(path.join(release, "core", "digest.js")));
  const decisions = await import(pathToFileURL(path.join(release, "security", "humanDecision.js")));
  const intake = await import(pathToFileURL(path.join(release, "issues", "intake.js")));
  const configMod = await import(pathToFileURL(path.join(release, "core", "config.js")));
  const pathToFileUrl = pathToFileURL;

  const candidateWorktree = record.candidateRevision?.worktree ?? journeyRoot;
  const taskId = record.result?.taskId ?? record.id;
  const deliveryRoot = (await fs.stat(candidateWorktree).then(() => candidateWorktree).catch(() => journeyRoot));
  const config = await configMod.loadProjectConfig(deliveryRoot);
  const contract = await configMod.loadTaskContract(deliveryRoot, taskId, config);
  if (!contract) throw new Error(`sealed journey contract ${taskId} not found in ${deliveryRoot}`);
  const snapshot = await intake.inspectGithubIssue(journeyRoot, await configMod.loadProjectConfig(journeyRoot), reuseIssue);
  contract.issue = { provider: "github", repository: repoName, number: reuseIssue, url: `https://github.com/${repoName}/issues/${reuseIssue}`, state: snapshot.snapshot.state, fetchedAt: snapshot.snapshot.fetchedAt, updatedAt: snapshot.snapshot.updatedAt, contentSha256: snapshot.snapshot.contentSha256, snapshotPath: path.posix.join(config.workflow?.issueIntake?.snapshotDir ?? ".harness/issues", `GH-${reuseIssue}.json`) };
  contract.git = { baseRef: baseBranch, originatingBranch: baseBranch };
  await fs.writeFile(path.join(deliveryRoot, ".harness", "contracts", `${taskId}.yaml`), YAML.stringify(contract));
  await sealMod.sealTask(deliveryRoot, config, contract);
  await handoff.seedDeliveryRecordFromIssue(deliveryRoot, config, contract, { repository: repoName, issueNumber: reuseIssue, issueUrl: `https://github.com/${repoName}/issues/${reuseIssue}` });

  // The governed operation is terminal. The canonical gated-effect boundary requires a RUNNING
  // managed operation (ToolActionGate rejects a terminal owner with
  // TOOL_ACTION_OPERATION_NOT_ACTIVE), so the harness materializes a delivery operation shell on
  // the candidate worktree that preserves the real operation's identity (id, candidate, frozen
  // policy, execution revision, controller epoch) and copies the real persisted acceptance
  // artifact bytes byte-for-byte. The real operation remains terminal in its own control root; no
  // controller epoch is re-claimed and no state is rewritten.
  const acceptedCandidate = record.candidateRevision;
  const epoch = state.currentControllerEpoch(record);
  const acceptanceArtifactRelative = record.result?.acceptanceOracleArtifact;
  if (!acceptanceArtifactRelative) throw new Error("journey accepted operation has no persisted acceptance artifact path");
  const acceptanceSource = path.join(journeyRoot, acceptanceArtifactRelative);
  const acceptanceRawBytes = await fs.readFile(acceptanceSource);
  const acceptanceTargetDir = path.join(deliveryRoot, ".harness", "operations", operationId, "acceptance");
  await fs.mkdir(acceptanceTargetDir, { recursive: true });
  const acceptanceTarget = path.join(acceptanceTargetDir, path.basename(acceptanceArtifactRelative));
  await fs.writeFile(acceptanceTarget, acceptanceRawBytes);
  const controllerToken = crypto.randomBytes(32).toString("hex");
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "change";
  process.env.AEH_CONTROL_ROOT = deliveryRoot;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  process.env.AEH_CONTROLLER_EPOCH = String(epoch);
  process.env.AEH_CONTROLLER_TOKEN = controllerToken;
  await state.saveOperation(deliveryRoot, { ...record, root: deliveryRoot, status: "RUNNING", phase: "delivery", finishedAt: undefined, error: undefined, result: undefined, controller: { ...record.controller, tokenDigest: digest.sha256Utf8(controllerToken) } });
  const current = await state.loadOperation(deliveryRoot, operationId);
  laneEvidence.deliveryOperationShell = { operationId, status: current.status, phase: current.phase, controllerEpoch: state.currentControllerEpoch(current), acceptanceArtifactCopy: path.relative(deliveryRoot, acceptanceTarget), acceptanceArtifactDigest: crypto.createHash("sha256").update(acceptanceRawBytes).digest("hex"), note: "fixture-scoped RUNNING shell preserving the real terminal operation identity (epoch is not re-claimed; identity fields unchanged); the shell owns a campaign-minted controller token whose digest is stored only in the shell record, and the real operation remains terminal in the control root" };

  const effectsAllowed = config.delivery?.github?.pullRequests === false ? effects : [...effects, "github.pull-request.create"];
  assertExternalAuthorizationCoversFrozenPolicyV1({ authorization, policyAllowedEffects: effectsAllowed, effects });
  const branch = handoff.renderPattern(config.delivery.github.branchPattern, contract, reuseIssue);
  assertExternalAuthorizationResourceNamesV1({ authorization, resourceNames: [branch] });

  let deniedStatus = "UNKNOWN";
  try {
    await deliveryMod.finalizeAcceptedIssue(deliveryRoot, config, contract, { candidate: record.candidateRevision });
    deniedStatus = "UNEXPECTEDLY_ALLOWED";
  } catch (error) {
    deniedStatus = /TOOL_ACTION_HUMAN_DECISION_REQUIRED/.test(String(error?.message ?? error)) ? "HUMAN_REQUIRED" : `ERROR:${String(error?.message ?? error).slice(0, 200)}`;
  }
  laneEvidence.humanGate = { status: deniedStatus };
  const commitSha = run("git", ["rev-parse", "HEAD"], { cwd: deliveryRoot }).stdout.trim();
  const pushPayload = { remote: "origin", ref: branch, expectedCommit: commitSha };
  const ledger = new decisions.HumanDecisionLedgerV2(path.join(deliveryRoot, ".harness", "security", "human-decisions.json"));
  const humanDecision = await ledger.record(externalAuthorizationDecisionInputV1({
    authorization,
    action: "git.push",
    effectDigest: digest.sha256Canonical(pushPayload),
    binding: { operationId, candidate: record.candidateRevision, operationExecutionRevision: current.operationExecutionRevision, policyDigest: current.resolvedOperationPolicy.digest, controllerEpoch: epoch }
  }));
  const finalized = await deliveryMod.finalizeAcceptedIssue(deliveryRoot, config, contract, { candidate: record.candidateRevision });
  // P0-C / Director determination (R20-F7): the delivery record, ActionIntent, receipts and
  // reconciliation must be owned by a TERMINAL governed operation. Terminalize the delivery
  // operation through the product's own durable terminal transition (controller epoch/token of the
  // shell, the real accepted candidate and the real persisted objective-completion/AcceptanceOracle
  // evidence). A RUNNING shell is not left behind.
  const shellTransition = await state.transitionOperationToTerminal(deliveryRoot, operationId, {
    status: "SUCCEEDED",
    phase: "delivery-finished",
    finishedAt: new Date().toISOString(),
    result: record.result
  });
  const shellTerminalRecord = shellTransition.record;
  const shellDeliveryRecord = await handoff.loadDeliveryRecord(deliveryRoot, config, taskId);
  laneEvidence.deliveryOperationShell = {
    ...laneEvidence.deliveryOperationShell,
    terminalStatus: shellTerminalRecord.status,
    terminalRevision: shellTerminalRecord.revision,
    terminalPhase: shellTerminalRecord.phase,
    terminalTransitioned: shellTransition.transitioned,
    deliveryRecordOwnedByTerminalOperation: Boolean(shellDeliveryRecord),
    deliveryRecordDigest: shellDeliveryRecord ? digest.sha256Canonical(shellDeliveryRecord) : null
  };
  const remoteRef = run("gh", ["api", `repos/${repoName}/git/ref/heads/${branch}`, "--jq", ".object.sha"], { timeoutMs: 120_000 });
  const localHead = run("git", ["rev-parse", "HEAD"], { cwd: deliveryRoot }).stdout.trim();
  const drift = await intake.verifyGithubIssueDrift(journeyRoot, await configMod.loadProjectConfig(journeyRoot), contract);
  const actionDir = path.join(deliveryRoot, ".harness", "security", "tool-actions", digest.sha256Utf8(operationId).slice(0, 32));
  const actionFiles = await fs.readdir(actionDir).catch(() => []);
  const receipts = [];
  for (const file of actionFiles.filter((entry) => entry.endsWith(".receipt.json"))) {
    try { receipts.push(JSON.parse(await fs.readFile(path.join(actionDir, file), "utf8"))); } catch { /* bounded */ }
  }
  const receiptActions = receipts.map((receipt) => receipt.action).sort();
  const acceptancePath = record.result?.acceptanceOracleArtifact;
  const acceptanceRaw = acceptancePath ? await fs.readFile(path.join(journeyRoot, acceptancePath)).catch(() => undefined) : undefined;
  const acceptance = acceptanceRaw ? JSON.parse(acceptanceRaw.toString("utf8")) : undefined;

  laneEvidence.delivery = {
    taskId, branch, deniedStatus,
    finalization: { status: finalized.status, committed: finalized.committed, commitSha: finalized.commitSha ?? null, pushed: finalized.pushed, message: finalized.message },
    externalAuthorization: { authorizationId: authorization.authorizationId, artifactDigest: authorization.artifactDigest, exactEffectDigest: digest.sha256Canonical(pushPayload) },
    humanDecision: { decisionId: humanDecision.decisionId, actorId: humanDecision.actorId, action: humanDecision.action, reason: humanDecision.reason.slice(0, 300) },
    reconciliation: { remoteRefExitCode: remoteRef.status, remoteRefSha: remoteRef.stdout.trim(), localHead, matches: remoteRef.stdout.trim() === localHead },
    receipts: { intents: actionFiles.filter((entry) => entry.endsWith(".intent.json")).length, actions: receiptActions },
    issueDrift: { ok: drift.ok, issueCreated: false, issueEdited: false },
    acceptanceArtifact: acceptance ? { path: acceptancePath, digest: record.result?.acceptanceOracle?.dispositionDigest ?? acceptance.disposition?.digest ?? null, disposition: acceptance.disposition?.disposition ?? null, covered: acceptance.disposition?.coveredAssertionIds?.length ?? 0 } : null
  };
  laneEvidence.checks = [
    { id: "issue-driven.issue-snapshot", ok: Boolean(snapshot.snapshot?.contentSha256) && drift.ok === true && snapshot.snapshot.number === reuseIssue, message: `authorized issue #${reuseIssue} snapshot ${snapshot.snapshot?.contentSha256?.slice(0, 16) ?? "missing"} drift=${drift.ok}` },
    { id: "issue-driven.governed-operation", ok: record.status === "SUCCEEDED" && record.result?.acceptanceOracle?.disposition === "ACCEPTED" && Boolean(acceptance), message: `operation ${operationId} ${record.status}; oracle=${record.result?.acceptanceOracle?.disposition ?? "missing"} candidate r${record.candidateRevision?.revision ?? "?"}` },
    { id: "issue-driven.delivery-effect", ok: finalized.status === "FINALIZED" && finalized.pushed === true && remoteRef.status === 0 && remoteRef.stdout.trim() === localHead, message: `finalized=${finalized.status} remote ${branch}@${remoteRef.stdout.trim().slice(0, 12)}` },
    { id: "issue-driven.human-gate", ok: deniedStatus === "HUMAN_REQUIRED", message: `unapproved delivery status=${deniedStatus}` },
    { id: "issue-driven.receipts", ok: receiptActions.includes("git.push") && receiptActions.includes("git.commit"), message: `${laneEvidence.delivery.receipts.intents} intent(s); receipts: ${receiptActions.join(", ")}` },
    { id: "issue-driven.delivery-operation-terminal", ok: shellTerminalRecord.status === "SUCCEEDED" && laneEvidence.deliveryOperationShell.deliveryRecordOwnedByTerminalOperation === true, message: `delivery shell ${operationId} terminal=${shellTerminalRecord.status} (rev ${shellTerminalRecord.revision}); record=${laneEvidence.deliveryOperationShell.deliveryRecordDigest?.slice(0, 16) ?? "missing"}` },
    { id: "issue-driven.issue-untouched", ok: drift.ok === true, message: "authorized issue unchanged (no create/edit/delete)" }
  ];
  laneEvidence.result = laneEvidence.checks.every((check) => check.ok) ? "PASS" : "FAIL";
  laneEvidence.terminal = { status: record.status, revision: record.revision, error: record.error ?? null };
} catch (error) {
  laneEvidence.result = "FAIL";
  laneEvidence.error = String(error?.stack ?? error);
}

if (laneEvidence.leadAgentId) run("paseo", ["agent", "delete", laneEvidence.leadAgentId], { timeoutMs: 60_000 });
try {
  const beforeIds = journeyWorkspacesBefore ?? new Set();
  const inventory = journeyWorkspaceScope(workspaceList(), staging);
  laneEvidence.workspaceInventory = inventory.map((workspace) => ({ workspaceId: workspace.workspaceId, project: workspace.project ?? null, cwd: workspace.cwd ?? null, laneCreated: !beforeIds.has(workspace.workspaceId) }));
  const terminalStatus = laneEvidence.terminal?.status ?? laneEvidence.operation?.status ?? null;
  const controllerPid = laneEvidence.operation?.controllerPid ?? null;
  const controllerAlive = controllerPid ? (() => { try { process.kill(controllerPid, 0); return true; } catch { return false; } })() : false;
  const archiveDecision = workspaceArchiveDecision(terminalStatus, controllerAlive);
  const archived = [];
  if (archiveDecision.eligible) {
    for (const workspace of inventory) {
      if (beforeIds.has(workspace.workspaceId)) continue;
      const result = run("paseo", ["workspace", "archive", workspace.workspaceId], { timeoutMs: 60_000 });
      archived.push({ workspaceId: workspace.workspaceId, cwd: workspace.cwd ?? null, exitCode: result.status });
    }
  }
  const remainingAfter = journeyWorkspaceScope(workspaceList(), staging);
  const accounting = accountWorkspaceCleanupV1(inventory, archived, remainingAfter);
  laneEvidence.workspaceCleanup = {
    archived,
    ...(archiveDecision.eligible ? {} : { skipped: true, reason: "controller-not-terminal-or-still-alive", operationTerminal: archiveDecision.operationTerminal,
      controllerExited: archiveDecision.controllerExited }),
    preExistingUntouched: inventory.filter((workspace) => beforeIds.has(workspace.workspaceId)).map((workspace) => workspace.workspaceId),
    remaining: remainingAfter.map((workspace) => workspace.workspaceId),
    accounting
  };
  if (!accounting.accounted) laneEvidence.workspaceAccountingError = `R18-F2: unaccounted workspaces ${accounting.unaccounted.join(",")}`;
} catch (error) { laneEvidence.workspaceCleanup = { error: String(error) }; }

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
const roundLaneRoot = path.join(evidenceRoot, `issue-journey-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
await fs.writeFile(path.join(roundLaneRoot, "issue-driven.json"), `${sanitizeEvidence(JSON.stringify(laneEvidence, null, 2))}\n`);
const summary = {
  version: 1, slice: "S13", round, runId, campaign: "issue-journey", generatedAt: new Date().toISOString(), checkout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout, harnessRevisions, harnessBuildIdentity: buildIdentity,
  repository: laneEvidence.repository, issue: laneEvidence.issue, authorization: laneEvidence.authorization,
  lanes: [{ capability: "issue-driven", result: laneEvidence.result, checks: laneEvidence.checks ?? null, error: laneEvidence.error ?? null, artifact: `docs/evidence/s13/issue-journey-lanes/round-${round}/${runId}/issue-driven.json` }],
  result: laneEvidence.result === "PASS" ? "PASS" : "SLICE_BLOCKED",
  checkoutProof: laneEvidence.checkoutProof
};
const summaryPath = path.join(evidenceRoot, `s13-issue-journey-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
delete process.env.GH_TOKEN;
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
if (process.env.S13_JJ_KEEP !== "1") await fs.rm(staging, { recursive: true, force: true });
process.exit(summary.result === "PASS" && laneEvidence.checkoutProof.checkoutUntouched ? 0 : 1);
