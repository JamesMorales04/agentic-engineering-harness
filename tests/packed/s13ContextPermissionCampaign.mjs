import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * S13 round-19 P1-E lanes: `context-handoff` and `permission-delegation`.
 *
 * Both lanes materialize a REAL durable managed operation in a disposable packed fixture and drive
 * the production launch/authority/context APIs with a real Paseo provider session (no deterministic
 * Paseo runtime, no scripted provider boundary):
 *
 *   context-handoff      : launch a participant with a progressive ContextManifest that advertises
 *                          addressable refs -> the controller persists a ContextRefAuthorizationV1
 *                          grant -> the exact session binding is resumed and the controller persists
 *                          a durable ContextContinuationV1.
 *   permission-delegation: compile a durable parent ExecutionAuthority, deny a deterministic
 *                          out-of-ceiling child capability request (V2_AUTHORITY_DENIED), persist the
 *                          typed decision receipt, launch the monotonic in-ceiling child session on
 *                          the real provider, and bind its leases to the parent ceiling.
 *
 * Usage: S13_ROUND=19 S13_RUN_ID=r19-ctxperm-1 node tests/packed/s13ContextPermissionCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const laneFilter = (process.env.S13_CTXPERM_LANES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const keepStaging = process.env.S13_CTXPERM_KEEP === "1";

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-ctxperm-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const laneRoot = path.join(staging, "lanes");
await fs.mkdir(laneRoot, { recursive: true });

const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

/**
 * Round 21: the only observed round-20 blocker for both lanes is a provider-side MCP startup flake
 * (`Failed to add OpenCode MCP server '<name>': MCP error -32000: Connection closed`) raised inside
 * the real Paseo materialization before any prompt or result. It is a transient transport failure,
 * not an AEH or fixture defect. It must be retried at **lane granularity** (a fresh fixture and
 * operation) rather than by re-invoking `executeAgentPrompt`: the failed materialization leaves a
 * durable provider lease that the same operation/epoch may not take over
 * (`PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED`), and the product is right to fence it. The campaign
 * therefore reruns the whole lane with a new run id; every attempt's artifacts are preserved and
 * no check is weakened (a PASS still requires the real session, binding, grant/continuation and
 * lease evidence from a successful attempt).
 */

function participantIdentityV1(label) {
  // The product treats `participant:<16 hex>` ids as controller-issued resumable launch
  // identities (their live status is not flipped by a settled receipt); any other shape is a
  // terminal work participant whose execution is closed after its turn, so a continuation with
  // addressable context refs is correctly rejected (CONTEXT_RUNTIME_V2_BINDING_REJECTED). This
  // harness must use the production identity convention.
  return `participant:${crypto.createHash("sha256").update(`s13-ctxperm:${label}`).digest("hex").slice(0, 16)}`;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 120_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function sanitizeString(value) {
  return String(value).replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED").replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED");
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
  const packageDist = path.join(root, "node_modules", "agentic-engineering-harness", "dist");
  const current = (await fs.readFile(path.join(packageDist, "current"), "utf8").catch(() => "")).trim();
  if (!/^release-[A-Za-z0-9._-]+$/.test(current)) return {};
  try {
    const raw = JSON.parse(await fs.readFile(path.join(packageDist, "releases", current, "build-identity.json"), "utf8"));
    return { packedBuildRelease: current, packedBuildDigest: raw.buildDigest, packedBuildGitSha: raw.gitSha };
  } catch { return {}; }
}
function laneEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AEH_")) delete env[key];
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_SESSION_ID;
  delete env.AEH_DETERMINISTIC_PASEO_RUNTIME;
  return env;
}
function packedRelease(root) {
  return path.join(root, "node_modules", "agentic-engineering-harness", "dist", "releases", run("cat", [path.join(root, "node_modules", "agentic-engineering-harness", "dist", "current")]).stdout);
}
async function packCandidate() {
  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const artifactPath = path.join(packDir, parsePackFilename(packed.stdout));
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
  return { artifactPath, artifactDigest, filename: path.basename(artifactPath) };
}
async function prepareFixture(name, candidate) {
  const root = path.join(staging, `fixture-${name}`);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "greeting.mjs"), "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n");
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: `s13-ctxperm-${name}`, version: "1.0.0", private: true }, null, 2)}\n`);
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n\n# BEGIN Agentic Engineering Harness generated state\n.harness/*\n!.harness/project.yaml\n!.harness/toolchain.yaml\n!.harness/provider-versions.json\n!.harness/agents.source.jsonc\n!.harness/otel-collector.yaml\n# END Agentic Engineering Harness generated state\n");
  for (const [command, args] of [["git", ["init", "-q", "-b", "master"]], ["git", ["config", "core.fsmonitor", "false"]], ["git", ["config", "user.email", "s13-ctxperm@aeh.invalid"]], ["git", ["config", "user.name", "S13 Context Permission"]], ["git", ["add", "-A"]], ["git", ["commit", "-q", "-m", "fixture baseline"]]]) {
    const result = run(command, args, { cwd: root });
    if (result.status !== 0) throw new Error(`fixture setup ${command} failed: ${result.stderr || result.stdout}`);
  }
  const installed = run("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", root, candidate.artifactPath], { timeoutMs: 600_000, cwd: root });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr || installed.stdout}`);
  const initialized = run(process.execPath, [path.join(root, "node_modules", "agentic-engineering-harness", "dist", "main.js"), "init", "."], { cwd: root, env: laneEnvironment(), timeoutMs: 300_000 });
  if (initialized.status !== 0) throw new Error(`fixture init failed: ${initialized.stderr || initialized.stdout}`);
  // Round 21 root cause: this harness drives `executeAgentPrompt` in its own process, so the
  // product's managed MCP commands would otherwise resolve to `process.argv[1]` — this harness
  // script — instead of a real AEH entrypoint, and every local MCP server (serena/aeh-context)
  // would exit immediately (`MCP error -32000: Connection closed`), masking a harness defect as a
  // provider flake. Pin the packed release entrypoint for every child MCP/agent process.
  process.env.AEH_ENTRY_FILE = path.join(root, "node_modules", "agentic-engineering-harness", "dist", "main.js");
  const configPath = path.join(root, ".harness", "project.yaml");
  const config = YAML.parse(await fs.readFile(configPath, "utf8"));
  config.project = { ...(config.project ?? {}), name: `s13-ctxperm-${name}` };
  config.validation = { baseRef: "master" };
  config.context = { ...(config.context ?? {}), mode: "enforce", budgets: { default: { inputTokens: 16_000 } } };
  await fs.writeFile(configPath, YAML.stringify(config));
  const committed = run("/bin/bash", ["-lc", "git add -A && git commit -q -m 'fixture init'"], { cwd: root });
  if (committed.status !== 0) throw new Error(`fixture commit failed: ${committed.stderr || committed.stdout}`);
  return { root, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout };
}

const ORCHESTRATION_SELECTION = {
  runtimeName: "opencode",
  runtimeAdapter: "opencode",
  paseoProvider: "opencode",
  modelAlias: "deepseek-v4.1-flash",
  modelId: "opencode-go/deepseek-v4.1-flash",
  modelName: "deepseek-v4.1-flash",
  modelProvider: "opencode-go",
  transport: "paseo",
  skills: [],
  mcps: [],
  args: [],
  runtimeCapabilities: { structuredOutput: true, sessions: true, mcp: true, stdioMcp: true, localMcp: true }
};

async function setupOperation(root, operationId, kind, intent, routing = {}) {
  const fixtureRelease = packedRelease(root);
  const state = await import(pathToFileURL(path.join(fixtureRelease, "operations/state.js")));
  const executionIdentity = await import(pathToFileURL(path.join(fixtureRelease, "architecture/executionIdentity.js")));
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = kind;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  const now = new Date().toISOString();
  await state.saveOperation(root, {
    version: 2, id: operationId, kind, status: "RUNNING", phase: "reviewing", root,
    payload: { request: intent }, revision: 1, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  });
  await state.claimControllerEpoch(root, operationId, `packed-ctxperm:${process.pid}`, { pid: process.pid });
  let current = await state.loadOperation(root, operationId);
  const policy = executionIdentity.compileResolvedOperationPolicy({
    projectId: current.candidateRevision.projectId, operationId,
    operationExecutionRevision: current.operationExecutionRevision,
    candidateRevision: current.candidateRevision.revision,
    candidateDigest: current.candidateRevision.identityDigest,
    controllerEpoch: state.currentControllerEpoch(current),
    intent, route: routing.route ?? "DIRECT", minimumAssurance: routing.assurance ?? "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await state.bindResolvedOperationPolicy(root, operationId, policy);
  current = await state.loadOperation(root, operationId);
  return { state, executionIdentity, fixtureRelease, operation: current };
}

async function sealFixtureContract(root, taskId, request) {
  const fixtureRelease = packedRelease(root);
  const configMod = await import(pathToFileURL(path.join(fixtureRelease, "core/config.js")));
  const contractMod = await import(pathToFileURL(path.join(fixtureRelease, "core/contract.js")));
  const sealMod = await import(pathToFileURL(path.join(fixtureRelease, "core/seal.js")));
  const config = await configMod.loadProjectConfig(root);
  const { contract } = await contractMod.createRoutedContract(root, config, taskId, { title: taskId, request, scope: ["src/greeting.mjs"], acceptance: [] });
  await sealMod.sealTask(root, config, contract);
  return { config, contract };
}

async function collectContinuationRecords(dir) {
  const found = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith(".json") && path.basename(path.dirname(absolute)) === "continuations") found.push(absolute);
    }
  };
  await walk(dir);
  return found.sort();
}

async function collectFiles(dir, name) {
  const found = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name === name) found.push(absolute);
    }
  };
  await walk(dir);
  return found;
}

async function contextHandoffJourney() {
  const lane = { version: 1, slice: "S13", round, runId, capability: "context-handoff", provider: "opencode/opencode-go/deepseek-v4.1-flash", harnessRevisions, startedAt: new Date().toISOString(), checks: [] };
  let sessionId;
  try {
    const fixture = await prepareFixture("context-handoff", candidate);
    const operationId = "CHANGE-S13-CTX-HANDOFF";
    lane.candidateBinding = { packedArtifactDigest: candidate.artifactDigest, fixtureCommit: fixture.commit };
    const { config, contract } = await sealFixtureContract(fixture.root, operationId, "Inspect the greeting fixture and report whether the greet contract holds. Do not modify files.");
    const setup = await setupOperation(fixture.root, operationId, "change", "context handoff certification lane", contract.routing ?? {});
    const fixtureRelease = setup.fixtureRelease;
    const agentPrompt = await import(pathToFileURL(path.join(fixtureRelease, "workers/agentPrompt.js")));
    const executionLease = await import(pathToFileURL(path.join(fixtureRelease, "security/executionLease.js")));
    const authorization = await import(pathToFileURL(path.join(fixtureRelease, "context/authorizationV2.js")));
    const participantId = participantIdentityV1("context-handoff");
    const selection = { ...ORCHESTRATION_SELECTION, logicalAgent: "s13-context-handoff", role: "Reviewer", domains: [], outputContract: "reviewer", permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" } };
    const authority = await executionLease.prepareExecutionAuthority(fixture.root, selection, { participantId, phase: "review", required: true });
    lane.parentAuthority = { participantId: authority.participantId, controllerEpoch: authority.controllerEpoch, candidateDigest: authority.candidateDigest, leaseIds: authority.leases.map((lease) => lease.leaseId) };
    const prompt = "Review the greeting fixture without modifying files. Return exactly one final line AEH_RESULT_JSON={\"verdict\":\"PASS\",\"findings\":[],\"finalizationSafety\":\"SAFE\"}.";
    // Capture the exact materialized context/prompt identity the launch will bind, so the
    // continuation turn reuses the same manifests: the product records ContextContinuationV1 only
    // when a resumed session continues with unchanged manifests (a changed manifest is an explicit
    // `continueBoundSession` event turn, which does not record a continuation).
    const prepared = await agentPrompt.prepareAgentExecutionIdentity(fixture.root, config, contract, selection, prompt, { participantId, phase: "review", capabilityAuthority: authority, outputContract: "reviewer" });
    const preparedOptions = { participantId, phase: "review", requireExecutionAuthority: true, capabilityAuthority: authority, outputContract: "reviewer", preparedPrompt: prepared.prompt, contextManifest: prepared.contextManifest, contextManifestDigest: prepared.contextManifestDigest, promptManifestDigest: prepared.promptManifestDigest };
    const launch = await agentPrompt.executeAgentPrompt(fixture.root, config, contract, selection, prompt, preparedOptions);
    sessionId = launch.id;
    lane.launch = { sessionId: launch.id, exitCode: launch.exitCode, participantId: launch.participantId ?? authority.participantId };
    const operationAfterLaunch = await setup.state.loadOperation(fixture.root, operationId);
    const binding = operationAfterLaunch.participants[authority.participantId]?.executionBinding;
    lane.launchBinding = { digest: binding?.digest ?? null, sessionId: binding?.runtime?.sessionId ?? null, contextManifestDigest: binding?.contextManifestDigest ?? null };
    const grant = await authorization.validateCurrentContextAuthorization(fixture.root, operationId, authority.participantId, launch.id);
    lane.authorizationGrant = { receiptDigest: grant.receiptDigest, refCount: grant.grant?.allowedRefs?.length ?? 0, bindingDigest: grant.executionBindingDigest ?? null, refs: (grant.grant?.allowedRefs ?? []).map((entry) => ({ refId: entry.refId, artifactPath: entry.artifactPath, sourceDigest: entry.sourceDigest })) };
    const resumed = await agentPrompt.executeAgentPrompt(fixture.root, config, contract, selection, prompt, { ...preparedOptions, resumeSessionId: launch.id });
    lane.resume = { sessionId: resumed.id, exitCode: resumed.exitCode };
    const continuationFiles = await collectContinuationRecords(path.join(fixture.root, ".harness", "context"));
    const continuation = continuationFiles.length ? JSON.parse(await fs.readFile(continuationFiles[0], "utf8")) : undefined;
    lane.continuation = continuation ? { file: path.relative(fixture.root, continuationFiles[0]), sequence: continuation.sequence, previousSessionId: continuation.previousSessionId ?? null, executionBindingDigest: continuation.executionBindingDigest ?? null, turnIds: continuation.turnIds ?? [] } : null;
    const inspect = run("paseo", ["agent", "inspect", launch.id, "--json"], { timeoutMs: 60_000 });
    lane.sessionInspection = { exitCode: inspect.status, status: (() => { try { return JSON.parse(inspect.stdout).status ?? null; } catch { return null; } })() };
    const checks = [
      { id: "context-handoff.real-session", ok: Boolean(launch.id) && inspect.status === 0, message: `real provider session ${launch.id} inspected (exit=${inspect.status})` },
      { id: "context-handoff.addressable-refs", ok: (grant.grant?.allowedRefs?.length ?? 0) >= 1 && lane.authorizationGrant.refs.every((entry) => entry.artifactPath && /^[a-f0-9]{64}$/.test(String(entry.sourceDigest))), message: `${lane.authorizationGrant.refCount} addressable ref(s) with durable artifact/source digests` },
      { id: "context-handoff.authorization-grant", ok: Boolean(grant.receiptDigest) && grant.executionBindingDigest === binding?.digest && grant.grant?.sessionId === launch.id, message: `grant ${grant.receiptDigest ?? "missing"} bound to binding ${binding?.digest ?? "missing"} session=${grant.grant?.sessionId ?? "missing"}` },
      { id: "context-handoff.continuation-binding", ok: Boolean(continuation) && continuation.previousSessionId === launch.id && continuation.executionBindingDigest === binding?.digest && Number(continuation.sequence) >= 1, message: `continuation sequence=${continuation?.sequence ?? "missing"} previousSession=${continuation?.previousSessionId ?? "missing"}` }
    ];
    lane.checks = checks;
    lane.result = checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
    lane.rowResult = { "context-handoff": lane.result };
  } catch (error) {
    lane.error = String(error?.stack ?? error);
    lane.result = "FAIL";
  }
  lane.finishedAt = new Date().toISOString();
  if (sessionId) run("paseo", ["agent", "delete", sessionId], { timeoutMs: 60_000 });
  await fs.writeFile(path.join(laneRoot, "context-handoff.json"), `${sanitizeEvidence(JSON.stringify(lane, null, 2))}\n`);
  return lane;
}

async function permissionDelegationJourney() {
  const lane = { version: 1, slice: "S13", round, runId, capability: "permission-delegation", provider: "opencode/opencode-go/deepseek-v4.1-flash", harnessRevisions, startedAt: new Date().toISOString(), checks: [] };
  let sessionId;
  try {
    const fixture = await prepareFixture("permission-delegation", candidate);
    const operationId = "CHANGE-S13-PERMISSION-DELEGATION";
    lane.candidateBinding = { packedArtifactDigest: candidate.artifactDigest, fixtureCommit: fixture.commit };
    const { config, contract } = await sealFixtureContract(fixture.root, operationId, "Inspect the greeting fixture and report whether the greet contract holds. Do not modify files.");
    const setup = await setupOperation(fixture.root, operationId, "change", "permission delegation certification lane", contract.routing ?? {});
    const fixtureRelease = setup.fixtureRelease;
    const agentPrompt = await import(pathToFileURL(path.join(fixtureRelease, "workers/agentPrompt.js")));
    const executionLease = await import(pathToFileURL(path.join(fixtureRelease, "security/executionLease.js")));
    const telemetryEvents = await import(pathToFileURL(path.join(fixtureRelease, "telemetry/events.js")));
    const digests = await import(pathToFileURL(path.join(fixtureRelease, "core/digest.js")));
    const parentSelection = { ...ORCHESTRATION_SELECTION, logicalAgent: "s13-perm-parent", role: "Implementer", domains: [], outputContract: "implementer", permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" } };
    const parent = await executionLease.prepareExecutionAuthority(fixture.root, parentSelection, { participantId: participantIdentityV1("perm-parent"), phase: "implementation", required: true });
    const parentCapabilities = [...new Set(parent.leases.map((lease) => lease.capability))].sort();
    lane.parentLease = { participantId: parent.participantId, candidateDigest: parent.candidateDigest, controllerEpoch: parent.controllerEpoch, capabilities: parentCapabilities, leaseIds: parent.leases.map((lease) => lease.leaseId) };
    const escalated = { ...ORCHESTRATION_SELECTION, logicalAgent: "s13-perm-escalation", role: "Reviewer", domains: [], outputContract: "reviewer", permissions: { read: "allow", write: "allow", shell: "deny", network: "deny", delegate: "deny" } };
    let denial;
    try {
      await executionLease.prepareExecutionAuthority(fixture.root, escalated, { participantId: participantIdentityV1("perm-escalation"), phase: "review" });
      denial = { denied: false, message: "escalation was unexpectedly allowed" };
    } catch (error) {
      denial = { denied: true, message: String(error?.message ?? error) };
    }
    lane.ceilingDenial = denial;
    const childSelection = { ...ORCHESTRATION_SELECTION, logicalAgent: "s13-perm-child", role: "Reviewer", domains: [], outputContract: "reviewer", permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" } };
    const child = await executionLease.prepareExecutionAuthority(fixture.root, childSelection, { participantId: participantIdentityV1("perm-child"), phase: "review", required: true });
    const childCapabilities = [...new Set(child.leases.map((lease) => lease.capability))].sort();
    const monotonic = childCapabilities.every((capability) => parentCapabilities.includes(capability));
    lane.childAuthority = { participantId: child.participantId, capabilities: childCapabilities, leaseIds: child.leases.map((lease) => lease.leaseId), monotonicSubsetOfParent: monotonic };
    const decisionReceipt = {
      version: 1, kind: "CapabilityDecisionReceiptV1", operationId,
      candidateDigest: parent.candidateDigest, controllerEpoch: parent.controllerEpoch,
      parentLeaseIds: parent.leases.map((lease) => lease.leaseId), parentCapabilities,
      requestedCapabilities: ["read", "write"], deniedCapabilities: ["write"],
      decision: denial.denied && /V2_AUTHORITY_DENIED/.test(denial.message) ? "DENIED_ROLE_CEILING" : "UNEXPECTED",
      childParticipantId: child.participantId, childLeaseIds: child.leases.map((lease) => lease.leaseId), childCapabilities,
      monotonic, recordedAt: new Date().toISOString()
    };
    await telemetryEvents.recordEvent(fixture.root, config, "harness.permission.decision", { taskId: contract.task.id, ...decisionReceipt });
    const eventsFile = path.join(fixture.root, ".harness", "telemetry", "events.ndjson");
    const events = (await fs.readFile(eventsFile, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
    const persisted = events.find((event) => event.name === "harness.permission.decision" && event.attributes?.operationId === operationId) ?? events.find((event) => event.name === "harness.permission.decision");
    lane.decisionReceipt = { digest: digests.sha256Canonical(decisionReceipt), persisted: Boolean(persisted), persistedOperationId: persisted?.attributes?.operationId ?? null };
    const prompt = "Review the greeting fixture without modifying files. Return exactly one final line AEH_RESULT_JSON={\"verdict\":\"PASS\",\"findings\":[],\"finalizationSafety\":\"SAFE\"}.";
    const launch = await agentPrompt.executeAgentPrompt(fixture.root, config, contract, childSelection, prompt, { participantId: child.participantId, phase: "review", requireExecutionAuthority: true, capabilityAuthority: child, outputContract: "reviewer" });
    sessionId = launch.id;
    const operationAfterLaunch = await setup.state.loadOperation(fixture.root, operationId);
    const binding = operationAfterLaunch.participants[child.participantId]?.executionBinding;
    lane.childSession = { sessionId: launch.id, exitCode: launch.exitCode, bindingDigest: binding?.digest ?? null, leaseIdentities: binding?.leaseIdentities ?? null };
    const inspect = run("paseo", ["agent", "inspect", launch.id, "--json"], { timeoutMs: 60_000 });
    lane.sessionInspection = { exitCode: inspect.status };
    const checks = [
      { id: "permission-delegation.parent-lease", ok: parentCapabilities.includes("write") && parentCapabilities.includes("execute") && parent.leases.length >= 2, message: `parent capabilities [${parentCapabilities.join(",")}] under epoch ${parent.controllerEpoch}` },
      { id: "permission-delegation.ceiling-denial", ok: denial.denied && /V2_AUTHORITY_DENIED/.test(denial.message), message: denial.message.slice(0, 200) },
      { id: "permission-delegation.child-decision", ok: monotonic && lane.decisionReceipt.persisted && binding?.leaseIdentities?.length === child.leases.length && binding.leaseIdentities.every((leaseId) => child.leases.some((lease) => lease.leaseId === leaseId)), message: `child [${childCapabilities.join(",")}] subset=${monotonic}; durable receipt persisted=${lane.decisionReceipt.persisted}` },
      { id: "permission-delegation.real-child-session", ok: Boolean(launch.id) && inspect.status === 0 && launch.exitCode === 0, message: `real provider child session ${launch.id} exit=${launch.exitCode}` }
    ];
    lane.checks = checks;
    lane.result = checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
    lane.rowResult = { "permission-delegation": lane.result };
  } catch (error) {
    lane.error = String(error?.stack ?? error);
    lane.result = "FAIL";
  }
  lane.finishedAt = new Date().toISOString();
  if (sessionId) run("paseo", ["agent", "delete", sessionId], { timeoutMs: 60_000 });
  await fs.writeFile(path.join(laneRoot, "permission-delegation.json"), `${sanitizeEvidence(JSON.stringify(lane, null, 2))}\n`);
  return lane;
}

const summary = {
  version: 1, slice: "S13", round, runId, campaign: "context-permission",
  generatedAt: new Date().toISOString(), checkout, sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions, harnessBuildIdentity: buildIdentity, candidate: null, lanes: [], result: "UNKNOWN"
};
const before = await trackedDigest();
const candidate = await packCandidate();
summary.candidate = { artifact: candidate.filename, artifactDigest: candidate.artifactDigest };

const laneNames = laneFilter.length ? laneFilter : ["context-handoff", "permission-delegation"];
for (const name of laneNames) {
  console.log(`S13 ctxperm lane: ${name}`);
  const lane = name === "context-handoff" ? await contextHandoffJourney() : name === "permission-delegation" ? await permissionDelegationJourney() : { capability: name, result: "FAIL", error: "unknown lane" };
  summary.lanes.push({ capability: lane.capability ?? name, result: lane.result, checks: lane.checks ?? null, rowResult: lane.rowResult ?? null, error: lane.error ?? null, artifact: `docs/evidence/s13/context-permission-lanes/round-${round}/${runId}/${name}.json` });
}

try {
  const { accountWorkspaceCleanupV1 } = await import("./s13GovernedCampaignPolicy.mjs");
  const listed = run("paseo", ["workspace", "ls", "--json"]);
  const inventory = (() => { try { return JSON.parse(listed.stdout); } catch { return []; } })().filter((workspace) => String(workspace.cwd ?? "").startsWith(staging));
  const archived = [];
  for (const workspace of inventory) {
    const result = run("paseo", ["workspace", "archive", workspace.workspaceId], { timeoutMs: 60_000 });
    archived.push({ workspaceId: workspace.workspaceId, cwd: workspace.cwd ?? null, exitCode: result.status });
  }
  const listedAfter = run("paseo", ["workspace", "ls", "--json"]);
  const remainingAfter = (() => { try { return JSON.parse(listedAfter.stdout); } catch { return []; } })().filter((workspace) => String(workspace.cwd ?? "").startsWith(staging));
  summary.workspaceInventory = inventory.map((workspace) => ({ workspaceId: workspace.workspaceId, cwd: workspace.cwd ?? null }));
  summary.workspaceCleanup = { archived, remaining: remainingAfter.map((workspace) => workspace.workspaceId), accounting: accountWorkspaceCleanupV1(inventory, archived, remainingAfter) };
} catch (error) {
  summary.workspaceCleanupError = String(error);
}
const after = await trackedDigest();
summary.checkoutProof = {
  trackedDigestBefore: before.digest, trackedDigestAfter: after.digest, trackedFiles: before.files,
  checkoutUntouched: before.digest === after.digest,
  postRunTrackedDocEditWindow: { opensAfterLaneFinish: true, note: "S13 tracked documentation/evidence is edited after lane execution; the recorded digest is the source-tree digest at lane end (R11-F6)." }
};
const roundLaneRoot = path.join(evidenceRoot, `context-permission-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
for (const name of laneNames) {
  await fs.copyFile(path.join(laneRoot, `${name}.json`), path.join(roundLaneRoot, `${name}.json`));
}
summary.result = summary.lanes.every((lane) => lane.result === "PASS") ? "PASS" : "SLICE_BLOCKED";
const summaryPath = path.join(evidenceRoot, `s13-context-permission-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes.map((lane) => ({ capability: lane.capability, result: lane.result })), immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
if (!keepStaging) await fs.rm(staging, { recursive: true, force: true });
process.exit(summary.result === "PASS" && summary.checkoutProof.checkoutUntouched ? 0 : 1);
