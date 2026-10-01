import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * S13 real Paseo session lifecycle campaign (cancel + recovery).
 *
 * Uses the freshly packed candidate's own production lifecycle functions against REAL Paseo
 * provider sessions owned by real durable operations. No deterministic Paseo stubs and no
 * scripted provider boundary are used: the lease owner materializes a real provider session,
 * the cancellation path observes and stops the exact real session, and restart takeover
 * inspects/stops the exact prior real session before resuming.
 *
 * Usage: node tests/packed/s13RealPaseoLifecycleCampaign.mjs [checkout]
 */

if (process.argv[2] === "--owner") {
  await runOwnerMode();
  process.exit(90);
}

const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const checkout = path.resolve(process.argv[2] ?? process.cwd());
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-lifecycle-"));
const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const laneRoot = path.join(staging, "lanes");
await fs.mkdir(laneRoot, { recursive: true });
const dist = path.join(checkout, "dist");
const releaseId = (await fs.readFile(path.join(dist, "current"), "utf8")).trim();
const release = path.join(dist, "releases", releaseId);
const certify = await import(pathToFileURL(path.join(release, "certification", "index.js")));
const buildIdentity = (await import(pathToFileURL(path.join(release, "build", "identity.js")))).getBuildIdentity();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error ? String(result.error) : undefined };
}

async function trackedDigest() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) { hash.update(`path\0${file}\0`); hash.update(await fs.readFile(path.join(checkout, file))); }
  return { digest: hash.digest("hex"), files: files.length };
}

function sanitizeString(value) {
  return value.replace(/gho_[A-Za-z0-9]+/g, "gho_REDACTED").replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_REDACTED");
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
      if (record && typeof record.filename === "string" && record.filename.endsWith(".tgz")) return record.filename;
    } catch { /* keep scanning */ }
  }
  throw new Error("npm pack did not return a JSON artifact record.");
}

function laneEnvironment() {
  const env = { ...process.env };
  for (const key of ["AEH_DETERMINISTIC_PASEO_RUNTIME", "AEH_DETERMINISTIC_PASEO", "AEH_MANAGED_AGENT", "AEH_INTERACTIVE_LEAD", "AEH_ORCHESTRATION_ALLOWED", "AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN", "AEH_ALLOW_NESTED_OPERATION", "PASEO_AGENT_ID", "PASEO_SESSION_ID"]) delete env[key];
  return env;
}

async function packAndInstall() {
  const packDir = path.join(staging, "pack");
  await fs.mkdir(packDir, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { timeoutMs: 600_000, cwd: checkout });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const filename = parsePackFilename(packed.stdout);
  const artifactPath = path.join(packDir, filename);
  const artifactDigest = crypto.createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
  return { artifactPath, artifactDigest, filename };
}

async function prepareFixture(name, candidate) {
  const root = path.join(staging, `fixture-${name}`);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: `s13-life-${name}`, version: "1.0.0", private: true }, null, 2)}\n`);
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n\n# BEGIN Agentic Engineering Harness generated state\n.harness/*\n!.harness/project.yaml\n!.harness/toolchain.yaml\n!.harness/provider-versions.json\n!.harness/agents.source.jsonc\n!.harness/otel-collector.yaml\n.config/mise/conf.d/aeh.toml\n# END Agentic Engineering Harness generated state\n");
  for (const [command, args] of [["git", ["init", "-q", "-b", "master"]], ["git", ["config", "core.fsmonitor", "false"]], ["git", ["config", "user.email", "s13-life@aeh.invalid"]], ["git", ["config", "user.name", "S13 Lifecycle"]], ["git", ["add", "-A"]], ["git", ["commit", "-q", "-m", "fixture baseline"]]]) {
    const result = run(command, args, { cwd: root });
    if (result.status !== 0) throw new Error(`fixture setup ${command} failed: ${result.stderr || result.stdout}`);
  }
  const installed = run("npm", ["install", "--ignore-scripts", "--no-save", "--prefix", root, candidate.artifactPath], { timeoutMs: 600_000, cwd: root });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr || installed.stdout}`);
  const initialized = run(process.execPath, [path.join(root, "node_modules", "agentic-engineering-harness", "dist", "main.js"), "init", "."], { cwd: root, env: laneEnvironment(), timeoutMs: 300_000 });
  if (initialized.status !== 0) throw new Error(`fixture init failed: ${initialized.stderr || initialized.stdout}`);
  const committed = run("/bin/bash", ["-lc", "git add -A && git commit -q -m 'fixture init'"], { cwd: root });
  if (committed.status !== 0) throw new Error(`fixture commit failed: ${committed.stderr || committed.stdout}`);
  return { root, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout };
}

function packedRelease(root) {
  const fixtureDist = path.join(root, "node_modules", "agentic-engineering-harness", "dist");
  const current = run("cat", [path.join(fixtureDist, "current")]).stdout;
  return path.join(fixtureDist, "releases", current);
}

async function runOwnerMode() {
  const root = path.resolve(process.argv[3]);
  const operationId = process.argv[4];
  const tag = process.argv[5];
  const fixtureRelease = packedRelease(root);
  const state = await import(pathToFileURL(path.join(fixtureRelease, "operations/state.js")));
  const executionIdentity = await import(pathToFileURL(path.join(fixtureRelease, "architecture/executionIdentity.js")));
  const runtime = await import(pathToFileURL(path.join(fixtureRelease, "runtime/index.js")));
  const paseo = await import(pathToFileURL(path.join(fixtureRelease, "paseo/runtime.js")));
  const now = new Date().toISOString();
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "audit";
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  await state.saveOperation(root, {
    version: 2, id: operationId, kind: "audit", status: "RUNNING", phase: "reviewing", root,
    payload: { request: `packed S13 real lifecycle ${tag}` }, revision: 1, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  });
  await state.claimControllerEpoch(root, operationId, `packed-controller:${process.pid}`, { pid: process.pid });
  await state.bindOperationLead(root, operationId, "packed-lifecycle-lead", "packed-s13-lifecycle");
  const current = await state.loadOperation(root, operationId);
  const policy = executionIdentity.compileResolvedOperationPolicy({
    projectId: current.candidateRevision.projectId, operationId,
    operationExecutionRevision: current.operationExecutionRevision,
    candidateRevision: current.candidateRevision.revision,
    candidateDigest: current.candidateRevision.identityDigest,
    controllerEpoch: state.currentControllerEpoch(current),
    intent: `packed S13 real lifecycle ${tag}`, route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
  });
  await state.bindResolvedOperationPolicy(root, operationId, policy);
  const session = await paseo.materializeManagedPaseoAgent(root, {
    cwd: root,
    title: `aeh-s13-lifecycle-${tag}`,
    provider: "opencode",
    model: "opencode-go/mimo-v2.6-flash",
    labels: { "aeh.kind": "lifecycle-cert", "aeh.role": "lifecycle-owner", "aeh.operation": operationId, "aeh.lead.agentId": "packed-lifecycle-lead", "aeh.lead.generation": "1" },
    waitForFinish: false
  });
  if (!session.id) { console.error("materialize failed", session.stderr); process.exit(92); }
  const hold = setInterval(() => {}, 1000);
  await runtime.runWithOperationProviderLease({
    root, provider: "opencode", workspaceId: root, operationId,
    leadAgentId: "packed-lifecycle-lead", leadGeneration: 1, sessionId: session.id,
    renewEveryMs: 1000,
    inspect: async (sessionId) => ({ status: (await paseo.inspectManagedPaseoAgent(root, sessionId))?.status }),
    stop: async (sessionId) => { await paseo.stopManagedPaseoAgent(root, sessionId); }
  }, async () => new Promise(() => {}));
  clearInterval(hold);
  process.exit(91);
}

async function readRuntimeSnapshot(root) {
  const fixtureRelease = packedRelease(root);
  const runtime = await import(pathToFileURL(path.join(fixtureRelease, "runtime/index.js")));
  return runtime.readManagedRuntimeSnapshot(root).catch(() => undefined);
}

async function waitForLease(root, sessionId, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await readRuntimeSnapshot(root);
    const lease = snapshot?.providerLeases?.find((item) => item.lifecycle?.sessionId === sessionId);
    if (lease) return lease;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`owner exited before durable acquire: ${child.exitCode}/${child.signalCode}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for durable lease ${sessionId}`);
}

function inspectAgentReceipt(agentId) {
  const inspected = run("paseo", ["agent", "inspect", agentId, "--json"], { timeoutMs: 30_000 });
  try { return JSON.parse(inspected.stdout); } catch { return { agentId, exitCode: inspected.status, raw: inspected.stdout.slice(0, 500) }; }
}

function stopAgent(agentId) { return run("paseo", ["agent", "delete", agentId], { timeoutMs: 60_000 }); }

const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

const summary = {
  version: 1, slice: "S13", round, runId, campaign: "real-paseo-lifecycle",
  generatedAt: new Date().toISOString(), checkout, sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  harnessBuildIdentity: buildIdentity, candidate: null, lanes: [], result: "UNKNOWN"
};
const before = await trackedDigest();
const candidate = await packAndInstall();
summary.candidate = { artifact: candidate.filename, artifactDigest: candidate.artifactDigest };

async function cancelJourney() {
  const lane = { version: 1, slice: "S13", round, runId, capability: "cancel", provider: "opencode/opencode-go/mimo-v2.6-flash", harnessRevisions, startedAt: new Date().toISOString(), checks: [] };
  const fixture = await prepareFixture("cancel", candidate);
  const fixtureRelease = packedRelease(fixture.root);
  const sessionId = { value: undefined };
  lane.candidateBinding = { packedArtifactDigest: candidate.artifactDigest, fixtureCommit: fixture.commit };
  const operationId = "AUDIT-S13-REAL-CANCEL";
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--owner", fixture.root, operationId, "cancel"], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...laneEnvironment() }
  });
  let childStdout = "";
  child.stdout.on("data", (chunk) => { childStdout += String(chunk); });
  child.stderr.on("data", (chunk) => { childStdout += String(chunk); });
  let lease;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const snapshot = await readRuntimeSnapshot(fixture.root);
      const found = snapshot?.providerLeases?.find((item) => item.lifecycle?.operationId === operationId);
      if (found?.lifecycle?.sessionId) { lease = found; sessionId.value = found.lifecycle.sessionId; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!lease || !sessionId.value) throw new Error(`real lifecycle lease was not acquired: ${childStdout.slice(-800)}`);
    lane.leaseAcquired = { leaseId: lease.leaseId, provider: lease.provider, lifecycle: lease.lifecycle };
    lane.sessionBeforeStop = inspectAgentReceipt(sessionId.value);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    lane.ownerTerminated = { signal: child.signalCode, exitCode: child.exitCode };
    const state = await import(pathToFileURL(path.join(fixtureRelease, "operations/state.js")));
    const executionIdentity = await import(pathToFileURL(path.join(fixtureRelease, "architecture/executionIdentity.js")));
    const decisions = await import(pathToFileURL(path.join(fixtureRelease, "security/humanDecision.js")));
    const controller = await import(pathToFileURL(path.join(fixtureRelease, "operations/controller.js")));
    let current = await state.loadOperation(fixture.root, operationId);
    lane.operationAfterOwnerCrash = { status: current.status, controllerEpoch: state.currentControllerEpoch(current) };
    const nextOwner = await state.claimControllerEpoch(fixture.root, operationId, `packed-controller:restart:${process.pid}`, { pid: process.pid });
    lane.controllerEpochAfterRestart = state.currentControllerEpoch(nextOwner);
    const policy = executionIdentity.compileResolvedOperationPolicy({
      projectId: nextOwner.candidateRevision.projectId, operationId,
      operationExecutionRevision: nextOwner.operationExecutionRevision,
      candidateRevision: nextOwner.candidateRevision.revision,
      candidateDigest: nextOwner.candidateRevision.identityDigest,
      controllerEpoch: state.currentControllerEpoch(nextOwner),
      intent: "packed S13 real cancellation", route: "DIRECT", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
      deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
    });
    await state.bindResolvedOperationPolicy(fixture.root, operationId, policy);
    const decisionLedger = new decisions.HumanDecisionLedgerV2(path.join(fixture.root, ".harness", "security", "human-decisions.json"));
    current = await state.loadOperation(fixture.root, operationId);
    await decisionLedger.record({
      operationId, candidate: current.candidateRevision,
      operationExecutionRevision: current.operationExecutionRevision,
      policyDigest: current.resolvedOperationPolicy.digest,
      controllerEpoch: state.currentControllerEpoch(current),
      purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" }, kind: "CANCEL", actorId: "human:s13-real",
      reason: "packed S13 real Paseo cancellation", createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000)
    });
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = fixture.root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    const cancelled = await controller.cancelOperation(fixture.root, operationId, {
      humanActorId: "human:s13-real",
      trace: async () => undefined,
      notifyCompletion: async () => undefined
    });
    lane.operationTerminal = { status: cancelled.status, phase: cancelled.phase };
    lane.sessionAfterStop = inspectAgentReceipt(sessionId.value);
    const finalSnapshot = await readRuntimeSnapshot(fixture.root);
    lane.leasesAfterCancel = finalSnapshot?.providerLeases?.length ?? null;
    const checks = [
      { id: "cancel.real-session-lease", ok: Boolean(lease.lifecycle?.sessionId) && lease.provider === "opencode", message: `durable lease bound real provider session ${lease.lifecycle?.sessionId}` },
      { id: "cancel.restart-newer-epoch", ok: lane.controllerEpochAfterRestart === 2, message: `controller epoch advanced to ${lane.controllerEpochAfterRestart}` },
      { id: "cancel.terminal-state", ok: cancelled.status === "CANCELLED", message: `terminal status=${cancelled.status}` },
      { id: "cancel.exact-session-stopped", ok: ["stopped", "idle", "closed"].includes(String(lane.sessionAfterStop?.Status ?? lane.sessionAfterStop?.status)), message: `real session status after cancel=${lane.sessionAfterStop?.Status ?? lane.sessionAfterStop?.status}` },
      { id: "cancel.lease-drained", ok: lane.leasesAfterCancel === 0, message: `provider leases after cancellation=${lane.leasesAfterCancel}` }
    ];
    lane.checks = checks;
    lane.result = checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
    lane.rowResult = { cancel: lane.result };
  } catch (error) {
    lane.error = String(error?.stack ?? error);
    lane.result = "FAIL";
  }
  lane.finishedAt = new Date().toISOString();
  if (sessionId.value) stopAgent(sessionId.value);
  await fs.writeFile(path.join(laneRoot, "cancel.json"), `${sanitizeEvidence(JSON.stringify(lane, null, 2))}\n`);
  return lane;
}

async function recoveryJourney() {
  const lane = { version: 1, slice: "S13", round, runId, capability: "recovery", provider: "opencode/opencode-go/mimo-v2.6-flash", harnessRevisions, startedAt: new Date().toISOString(), checks: [] };
  const fixture = await prepareFixture("recovery", candidate);
  const fixtureRelease = packedRelease(fixture.root);
  lane.candidateBinding = { packedArtifactDigest: candidate.artifactDigest, fixtureCommit: fixture.commit };
  const operationId = "AUDIT-S13-REAL-RECOVERY";
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--owner", fixture.root, operationId, "recovery"], { stdio: ["ignore", "pipe", "pipe"], env: { ...laneEnvironment() } });
  let childStdout = "";
  child.stdout.on("data", (chunk) => { childStdout += String(chunk); });
  child.stderr.on("data", (chunk) => { childStdout += String(chunk); });
  let sessionId;
  try {
    const deadline = Date.now() + 120_000;
    let lease;
    while (Date.now() < deadline) {
      const snapshot = await readRuntimeSnapshot(fixture.root);
      lease = snapshot?.providerLeases?.find((item) => item.lifecycle?.operationId === operationId);
      if (lease?.lifecycle?.sessionId) { sessionId = lease.lifecycle.sessionId; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!sessionId) throw new Error(`real lifecycle lease was not acquired: ${childStdout.slice(-800)}`);
    lane.leaseAcquired = { leaseId: lease.leaseId, provider: lease.provider, lifecycle: lease.lifecycle };
    lane.sessionBeforeTakeover = inspectAgentReceipt(sessionId);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    lane.ownerTerminated = { signal: child.signalCode, exitCode: child.exitCode };
    const state = await import(pathToFileURL(path.join(fixtureRelease, "operations/state.js")));
    const executionIdentity = await import(pathToFileURL(path.join(fixtureRelease, "architecture/executionIdentity.js")));
    const runtime = await import(pathToFileURL(path.join(fixtureRelease, "runtime/index.js")));
    const paseo = await import(pathToFileURL(path.join(fixtureRelease, "paseo/runtime.js")));
    let current = await state.loadOperation(fixture.root, operationId);
    lane.operationAfterOwnerCrash = { status: current.status, controllerEpoch: state.currentControllerEpoch(current), candidateDigest: current.candidateRevision.identityDigest };
    const nextOwner = await state.claimControllerEpoch(fixture.root, operationId, `packed-controller:restart:${process.pid}`, { pid: process.pid });
    lane.controllerEpochAfterRestart = state.currentControllerEpoch(nextOwner);
    const policy = executionIdentity.compileResolvedOperationPolicy({
      projectId: nextOwner.candidateRevision.projectId, operationId,
      operationExecutionRevision: nextOwner.operationExecutionRevision,
      candidateRevision: nextOwner.candidateRevision.revision,
      candidateDigest: nextOwner.candidateRevision.identityDigest,
      controllerEpoch: state.currentControllerEpoch(nextOwner),
      intent: "packed S13 real recovery", route: "DIRECT", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
      deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
    });
    await state.bindResolvedOperationPolicy(fixture.root, operationId, policy);
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = fixture.root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    const inspections = [];
    const stops = [];
    const resumed = await runtime.runWithOperationProviderLease({
      root: fixture.root, provider: "opencode", workspaceId: fixture.root, operationId,
      leadAgentId: "packed-lifecycle-lead", leadGeneration: 1, sessionId,
      renewEveryMs: 60_000,
      inspect: async (id) => { inspections.push(id); return { status: (await paseo.inspectManagedPaseoAgent(fixture.root, id))?.status }; },
      stop: async (id) => { stops.push(id); await paseo.stopManagedPaseoAgent(fixture.root, id); }
    }, async () => ({ value: "resumed-after-real-takeover", sessionId }));
    const snapshot = await readRuntimeSnapshot(fixture.root);
    lane.takeover = { resumed, inspections, stops, leasesAfterResume: snapshot?.providerLeases?.length ?? null };
    lane.sessionAfterTakeover = inspectAgentReceipt(sessionId);
    lane.operationStatePreserved = { status: (await state.loadOperation(fixture.root, operationId)).status, candidateDigest: (await state.loadOperation(fixture.root, operationId)).candidateRevision.identityDigest };
    const checks = [
      { id: "recovery.real-session-lease", ok: Boolean(sessionId) && lane.leaseAcquired.provider === "opencode", message: `durable lease bound real provider session ${sessionId}` },
      { id: "recovery.preserved-operation", ok: lane.operationAfterOwnerCrash.status === "RUNNING" && lane.operationAfterOwnerCrash.candidateDigest === lane.operationStatePreserved.candidateDigest, message: "operation identity and candidate preserved across controller crash" },
      { id: "recovery.takeover-newer-epoch", ok: lane.controllerEpochAfterRestart === 2, message: `controller epoch advanced to ${lane.controllerEpochAfterRestart}` },
      { id: "recovery.exact-session-takeover", ok: inspections.length >= 1 && inspections.every((id) => id === sessionId) && (stops.includes(sessionId) || ["idle", "stopped", "completed"].includes(String(lane.sessionBeforeTakeover?.Status ?? lane.sessionBeforeTakeover?.status ?? "").toLowerCase())), message: `takeover inspected the exact prior real session ${sessionId} (${inspections.length} inspection(s)); stop issued=${stops.includes(sessionId)}; observed prior status=${lane.sessionBeforeTakeover?.Status ?? lane.sessionBeforeTakeover?.status}` },
      { id: "recovery.resume", ok: resumed === "resumed-after-real-takeover", message: "bounded provider work resumed after observed takeover" },
      { id: "recovery.lease-drained", ok: lane.takeover.leasesAfterResume === 0, message: `provider leases after resume=${lane.takeover.leasesAfterResume}` }
    ];
    lane.checks = checks;
    lane.result = checks.every((entry) => entry.ok) ? "PASS" : "FAIL";
    lane.rowResult = { recovery: lane.result };
  } catch (error) {
    lane.error = String(error?.stack ?? error);
    lane.result = "FAIL";
  }
  lane.finishedAt = new Date().toISOString();
  if (sessionId) stopAgent(sessionId);
  await fs.writeFile(path.join(laneRoot, "recovery.json"), `${sanitizeEvidence(JSON.stringify(lane, null, 2))}\n`);
  return lane;
}

for (const journey of [cancelJourney, recoveryJourney]) {
  console.log(`S13 lifecycle journey: ${journey.name}`);
  const lane = await journey();
  summary.lanes.push({ capability: lane.capability, result: lane.result, sessions: lane.leaseAcquired?.lifecycle?.sessionId ?? null, rowResult: lane.rowResult ?? null, error: lane.error ?? null, artifact: `docs/evidence/s13/lifecycle-lanes/round-${round}/${runId}/${lane.capability}.json` });
  console.log(JSON.stringify(summary.lanes.at(-1)));
}

const after = await trackedDigest();
summary.checkoutProof = { trackedDigestBefore: before.digest, trackedDigestAfter: after.digest, trackedFiles: before.files, checkoutUntouched: before.digest === after.digest, postRunTrackedDocEditWindow: { opensAfter: new Date().toISOString(), note: "R17-F8: tracked documentation/evidence writes after this timestamp are expected; compare source digests only within a run window." }, note: "Tracked digest captured before packing and after all real lifecycle journeys; all provider sessions run against disposable /tmp fixtures." };
summary.result = summary.lanes.some((lane) => lane.result !== "PASS") ? "SLICE_BLOCKED" : "PASS";
const roundLaneRoot = path.join(evidenceRoot, `lifecycle-lanes/round-${round}`, runId);
await fs.mkdir(roundLaneRoot, { recursive: true });
for (const entry of await fs.readdir(laneRoot)) await fs.copyFile(path.join(laneRoot, entry), path.join(roundLaneRoot, entry));
const summaryPath = path.join(evidenceRoot, `s13-real-paseo-lifecycle-round-${round}-${runId}.json`);
await fs.writeFile(summaryPath, `${sanitizeEvidence(JSON.stringify(summary, null, 2))}\n`);
const digest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, lanes: summary.lanes, immutableSummaryDigest: digest, evidence: path.relative(checkout, summaryPath) }, null, 2));
process.exit(summary.lanes.some((lane) => lane.result !== "PASS") || !summary.checkoutProof.checkoutUntouched ? 1 : 0);
