import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * Closure resource-stability campaign (AEH-V2-0130 / AEH-V2-0135).
 *
 * Each iteration runs a real governed operation in a shared isolated TMPDIR with `S13_GOV_KEEP=1`
 * (the S13 lane performs NO archiving), then requires the PRODUCT to have reconciled its owned
 * resources at terminalization: durable `resource-reconciliation.json` receipt with
 * `cleanupComplete: true`, exact operation/resource identity binding, and a shared-root census
 * back at baseline. This campaign never archives, stops or kills anything: campaign-side PID/glob
 * cleanup is impossible by construction and is not the PASS mechanism.
 *
 * Usage: S13_ROUND=25 S13_RUN_ID=closure-resource-1 S13_RESOURCE_ITERATIONS=2 \
 *        S13_RESOURCE_LANE=change-direct S13_RESOURCE_TIMEOUT_SECONDS=1500 \
 *        node tests/packed/closureResourceStabilityCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "25");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `closure-resource-${Date.now()}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const iterations = Number(process.env.S13_RESOURCE_ITERATIONS ?? "2");
if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 4) throw new Error("S13_RESOURCE_ITERATIONS must be an integer from 2 through 4.");
const lane = (process.env.S13_RESOURCE_LANE ?? "change-direct").trim();
const laneTimeoutSeconds = Number(process.env.S13_RESOURCE_TIMEOUT_SECONDS ?? "1500");
if (!Number.isSafeInteger(laneTimeoutSeconds) || laneTimeoutSeconds < 1 || laneTimeoutSeconds > 1800) throw new Error("S13_RESOURCE_TIMEOUT_SECONDS must be an integer from 1 through 1800.");
const keepRoot = process.env.S13_RESOURCE_KEEP === "1";

const evidenceRoot = path.join(checkout, "docs", "evidence", "closure");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-closure-resource-"));
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function paseoList(kind) {
  const listed = run("paseo", [kind, "ls", "--json"], { timeoutMs: 60_000 });
  try { const parsed = JSON.parse(listed.stdout); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function ownedWorkspaces() {
  return paseoList("workspace").filter((workspace) => String(workspace.cwd ?? "").startsWith(root));
}

function ownedAgents() {
  return paseoList("agent").filter((agent) => String(agent.cwd ?? "").startsWith(root));
}

function ownedProcesses() {
  const owned = [];
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { entries = []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cwd = "";
    let cmdline = "";
    try { cwd = readlinkSync(path.join("/proc", entry, "cwd")); } catch { /* exited */ }
    try { cmdline = readFileSync(path.join("/proc", entry, "cmdline"), "utf8").replace(/\0/g, " "); } catch { /* exited */ }
    if (cwd.startsWith(root) || cmdline.includes(root)) owned.push({ pid: Number(entry), cwd, cmdline: cmdline.slice(0, 300) });
  }
  return owned;
}

function census() {
  const workspaces = ownedWorkspaces();
  const agents = ownedAgents();
  const processes = ownedProcesses();
  return {
    workspaces: workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId, project: workspace.project ?? null, cwd: workspace.cwd ?? null })),
    agents: agents.map((agent) => ({ id: agent.id, status: agent.status, name: agent.name ?? null, cwd: agent.cwd ?? null })),
    processes: processes.map((process) => ({ pid: process.pid, cmdline: process.cmdline })),
    counts: {
      workspaces: workspaces.length,
      agents: agents.length,
      processes: processes.length
    }
  };
}

async function findFixtureRoot(operationId, laneArtifact) {
  if (typeof laneArtifact?.fixtureRoot === "string") return laneArtifact.fixtureRoot;
  const entries = await fs.readdir(root).catch(() => []);
  for (const entry of entries) {
    if (!entry.startsWith("aeh-s13-gov-")) continue;
    const workRoot = path.join(root, entry, "work");
    for (const work of await fs.readdir(workRoot).catch(() => [])) {
      const candidate = path.join(workRoot, work);
      if (await fs.stat(path.join(candidate, ".harness", "operations", `${operationId}.json`)).then(() => true).catch(() => false)) return candidate;
    }
  }
  return undefined;
}

async function readReceipt(fixtureRoot, operationId) {
  try { return JSON.parse(await fs.readFile(path.join(fixtureRoot, ".harness", "operations", operationId, "resource-reconciliation.json"), "utf8")); }
  catch { return undefined; }
}

async function waitForProductReconciliation(fixtureRoot, operationId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recordPath = path.join(fixtureRoot, ".harness", "operations", `${operationId}.json`);
    let record;
    try { record = JSON.parse(await fs.readFile(recordPath, "utf8")); } catch { record = undefined; }
    const receipt = await readReceipt(fixtureRoot, operationId);
    if (receipt?.cleanupComplete === true) {
      return { record: { status: record?.status ?? null, phase: record?.phase ?? null }, receipt };
    }
    if (Date.now() >= deadline) return { record: record ? { status: record.status, phase: record.phase } : undefined, receipt };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function waitForBaseline(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = census();
  while (Date.now() < deadline) {
    if (snapshot.counts.workspaces === 0 && snapshot.counts.agents === 0 && snapshot.counts.processes === 0) return { returned: true, snapshot };
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    snapshot = census();
  }
  return { returned: snapshot.counts.workspaces === 0 && snapshot.counts.agents === 0 && snapshot.counts.processes === 0, snapshot };
}

const startedAt = new Date().toISOString();
const baseline = census();
const iterationRecords = [];
let candidateBuildDigest = null;

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const childRunId = `${runId}-i${iteration}`;
  console.log(`closure resource-stability iteration ${iteration}/${iterations}: ${childRunId} lane=${lane}`);
  const before = census();
  const startedAtIteration = new Date().toISOString();
  const child = run(process.execPath, ["tests/packed/s13GovernedOperationCampaign.mjs", checkout], {
    cwd: checkout,
    timeoutMs: (laneTimeoutSeconds + 900) * 1000,
    env: {
      ...process.env,
      TMPDIR: root,
      S13_ROUND: String(round),
      S13_RUN_ID: childRunId,
      S13_GOV_LANES: lane,
      S13_GOV_TIMEOUT_SECONDS: String(laneTimeoutSeconds),
      S13_GOV_KEEP: "1"
    }
  });
  const laneArtifactPath = path.join(checkout, "docs", "evidence", "s13", "governed-lanes", `round-${round}`, childRunId, `${lane}.json`);
  let laneArtifact;
  try { laneArtifact = JSON.parse(await fs.readFile(laneArtifactPath, "utf8")); } catch { laneArtifact = undefined; }
  const operationId = laneArtifact?.operation?.id ?? laneArtifact?.terminalRecord?.id ?? laneArtifact?.start?.operationId ?? null;
  const operationTerminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(laneArtifact?.terminalRecord?.status);
  if (laneArtifact?.candidateBinding?.packedBuild?.buildDigest) candidateBuildDigest ??= laneArtifact.candidateBinding.packedBuild.buildDigest;

  const record = {
    iteration,
    childRunId,
    childExitCode: child.status,
    startedAtIteration,
    finishedAtIteration: new Date().toISOString(),
    before: before.counts,
    lane: {
      result: laneArtifact?.result ?? null,
      terminal: laneArtifact?.terminalRecord?.status ?? null,
      bounded: laneArtifact?.terminal?.bounded ?? null,
      durationMs: laneArtifact?.durationMs ?? null,
      artifact: path.relative(checkout, laneArtifactPath),
      candidateBuildDigest: laneArtifact?.candidateBinding?.packedBuild?.buildDigest ?? null
    },
    operationId,
    operationTerminal,
    fixtureRoot: null,
    productReconciliation: null,
    baselineAfter: null,
    campaignSideCleanup: "NONE",
    preserved: false,
    preservedResources: null,
    errors: []
  };

  if (!operationTerminal) {
    record.preserved = true;
    record.preservedResources = census();
    iterationRecords.push(record);
    break;
  }

  const fixtureRoot = await findFixtureRoot(operationId, laneArtifact);
  record.fixtureRoot = fixtureRoot ?? null;
  if (!fixtureRoot || !operationId) {
    record.errors.push(`fixture root or operation id unavailable (operationId=${operationId})`);
    iterationRecords.push(record);
    break;
  }
  const { record: durableRecord, receipt } = await waitForProductReconciliation(fixtureRoot, operationId, 240_000);
  record.durableOperation = durableRecord ?? null;
  const receiptDigest = receipt ? crypto.createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex") : null;
  const reconciledWorkspaces = (receipt?.dispositions ?? []).filter((item) => item.kind === "paseo-workspace" && item.outcome === "reconciled");
  const reconciledResources = (receipt?.dispositions ?? []).filter((item) => item.outcome === "reconciled");
  const alreadyReconciled = (receipt?.dispositions ?? []).filter((item) => item.alreadyReconciled === true);
  record.productReconciliation = receipt ? {
    receipt: `${path.relative(root, path.join(fixtureRoot, ".harness", "operations", operationId, "resource-reconciliation.json"))}`,
    receiptSha256: receiptDigest,
    operationId: receipt.operationId,
    operationStatus: receipt.operationStatus,
    cleanupComplete: receipt.cleanupComplete === true,
    candidateDigest: receipt.candidateDigest ?? null,
    controllerEpoch: receipt.controllerEpoch ?? null,
    classification: receipt.classification,
    dispositionCounts: {
      total: (receipt.dispositions ?? []).length,
      reconciled: reconciledResources.length,
      alreadyReconciled: alreadyReconciled.length,
      failed: (receipt.errors ?? []).length
    },
    reconciledWorkspaces: reconciledWorkspaces.map((item) => ({ identity: item.identity, action: item.action })),
    reconciledIdentities: reconciledResources.map((item) => ({ kind: item.kind, identity: item.identity })),
    errors: receipt.errors ?? []
  } : {
    receipt: null,
    cleanupComplete: false,
    errors: ["product resource reconciliation receipt missing after 240s poll"]
  };

  const activeWorkspaceIds = new Set(paseoList("workspace").map((workspace) => workspace.workspaceId));
  record.receiptWorkspacesArchived = reconciledWorkspaces.every((item) => !activeWorkspaceIds.has(item.identity));
  const baselineAfter = await waitForBaseline(180_000);
  record.baselineAfter = baselineAfter.snapshot.counts;
  record.baselineReturned = baselineAfter.returned;
  record.residueDetail = baselineAfter.snapshot;
  iterationRecords.push(record);
}

const final = census();
const productOwnedPass = iterationRecords.every((record) => record.operationTerminal
  && record.lane.terminal === "SUCCEEDED"
  && record.lane.result === "PASS"
  && record.productReconciliation?.cleanupComplete === true
  && record.productReconciliation?.receiptSha256
  && record.receiptWorkspacesArchived !== false
  && record.baselineReturned === true);
const postBaselines = iterationRecords.map((record) => record.baselineAfter ?? { workspaces: 0, agents: 0, processes: 0 });
const growth = (series) => series.length > 1 && series[series.length - 1] > series[0];
const postReconciliationNoGrowth = !(growth(postBaselines.map((entry) => entry.workspaces)) || growth(postBaselines.map((entry) => entry.agents)) || growth(postBaselines.map((entry) => entry.processes)));
const checks = [];
for (const record of iterationRecords) {
  checks.push({ id: `closure.resource.iteration-${record.iteration}.terminal`, ok: record.lane.terminal === "SUCCEEDED" && record.lane.result === "PASS", message: `lane=${record.lane.result} terminal=${record.lane.terminal}` });
  if (!record.operationTerminal) continue;
  checks.push({ id: `closure.resource.iteration-${record.iteration}.product-receipt`, ok: record.productReconciliation?.cleanupComplete === true && typeof record.productReconciliation?.receiptSha256 === "string", message: JSON.stringify({ reconciliation: record.productReconciliation?.dispositionCounts ?? null, errors: record.productReconciliation?.errors ?? [] }) });
  checks.push({ id: `closure.resource.iteration-${record.iteration}.receipt-binds-operation`, ok: record.productReconciliation?.operationId === record.operationId, message: `receiptOperation=${record.productReconciliation?.operationId ?? "missing"} laneOperation=${record.operationId ?? "missing"}` });
  checks.push({ id: `closure.resource.iteration-${record.iteration}.owned-workspaces-archived`, ok: record.receiptWorkspacesArchived !== false, message: `reconciledWorkspaces=${JSON.stringify(record.productReconciliation?.reconciledWorkspaces ?? [])}` });
  checks.push({ id: `closure.resource.iteration-${record.iteration}.baseline-returned`, ok: record.baselineReturned === true, message: `after=${JSON.stringify(record.baselineAfter)}` });
  checks.push({ id: `closure.resource.iteration-${record.iteration}.no-campaign-cleanup`, ok: record.campaignSideCleanup === "NONE", message: "campaign never archives/stops/kills owned resources" });
}
checks.push({ id: "closure.resource.no-post-reconciliation-growth", ok: postReconciliationNoGrowth, message: `baselines=${JSON.stringify(postBaselines)}` });
const result = checks.every((check) => check.ok) ? "PASS" : "FAIL";

const summary = {
  version: 1,
  slice: "closure",
  round,
  runId,
  campaign: "resource-stability-product",
  amendment: "CAMPAIGN RESOURCE-LIFECYCLE AMENDMENT (2026-09-29) / AEH-V2-0130 / AEH-V2-0135",
  generatedAt: new Date().toISOString(),
  startedAt,
  checkout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  sharedRoot: root,
  lane,
  iterationCount: iterations,
  iterations: iterationRecords,
  candidateBuildDigest,
  baseline,
  final,
  productReconciliation: {
    applied: productOwnedPass,
    campaignSideCleanup: "NONE",
    requiredArchitecture: [
      "durable operation ownership -> durable provider/resource ownership",
      "terminal/recovery reconciliation classifying live-owned / terminal-orphan / unknown",
      "safe release/archive/stop provable from terminal operation records",
      "policy-driven concurrency/resource backpressure (no machine-specific memory constant in Core)"
    ]
  },
  trend: {
    postReconciliationBaselineByIteration: postBaselines,
    postReconciliationNoGrowth
  },
  reconciliation: {
    baselineReturned: iterationRecords.filter((record) => record.operationTerminal).every((record) => record.baselineReturned === true),
    preservedIntact: iterationRecords.every((record) => !record.preserved || Boolean(record.preservedResources)),
    productOwned: productOwnedPass,
    campaignSideCleanup: "NONE"
  },
  classification: {
    aehV2_0130: result === "PASS" ? "CLOSED_BY_PRODUCT" : "OPEN_PRODUCT_DEFECT_EVIDENCED",
    aehV2_0135: result === "PASS" ? "CLOSED_BY_PRODUCT" : "OPEN_PRODUCT_DEFECT_EVIDENCED"
  },
  checks,
  result
};
await fs.mkdir(evidenceRoot, { recursive: true });
const summaryPath = path.join(evidenceRoot, "resource-stability-product.json");
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result, classification: summary.classification, iterations: iterationRecords.map((record) => ({ iteration: record.iteration, terminal: record.lane.terminal, productCleanupComplete: record.productReconciliation?.cleanupComplete ?? null, baselineAfter: record.baselineAfter, receipt: record.productReconciliation?.receiptSha256 ?? null })), productReconciliation: summary.reconciliation, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
if (!keepRoot) await fs.rm(root, { recursive: true, force: true });
process.exit(result === "PASS" ? 0 : 1);
