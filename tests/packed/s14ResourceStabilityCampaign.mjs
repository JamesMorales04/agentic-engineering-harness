import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { kill } from "node:process";
import { fileURLToPath } from "node:url";
import { harnessRevisionV1 } from "./s13CampaignHarnessRevision.mjs";

/**
 * S14 bounded repeated-operation resource-stability campaign (AEH-V2-0130, CAMPAIGN RESOURCE-LIFECYCLE
 * AMENDMENT). Each iteration runs a real governed operation in a shared isolated TMPDIR without
 * harness-side archiving (`S13_GOV_KEEP=1`), measures the raw terminal-owned residue, then applies
 * the durable terminality-gated reconciliation discipline and verifies the baseline returns.
 *
 * Assertions:
 *   T1 every iteration reached a durable terminal state (a non-terminal iteration is preserved and
 *      stops the measured series, never reconciled),
 *   T2 raw terminal-owned residue per iteration is within the declared per-operation ceiling,
 *   T3 reconciliation returns the shared root to baseline (0 owned workspaces/agents/processes),
 *   T4 post-reconciliation baseline does not grow monotonically across iterations,
 *   T5 no resource of a preserved non-terminal iteration is archived or terminated (AEH-V2-0112).
 *
 * Usage: S13_ROUND=14 S13_RUN_ID=s14-resource-1 S13_RESOURCE_ITERATIONS=2 \
 *        node tests/packed/s14ResourceStabilityCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "14");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const iterations = Number(process.env.S13_RESOURCE_ITERATIONS ?? "2");
if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 4) throw new Error("S13_RESOURCE_ITERATIONS must be an integer from 2 through 4.");
const lane = (process.env.S13_RESOURCE_LANE ?? "change-direct").trim();
const laneTimeoutSeconds = Number(process.env.S13_RESOURCE_TIMEOUT_SECONDS ?? "1500");
if (!Number.isSafeInteger(laneTimeoutSeconds) || laneTimeoutSeconds < 1 || laneTimeoutSeconds > 1800) throw new Error("S13_RESOURCE_TIMEOUT_SECONDS must be an integer from 1 through 1800.");
const keepRoot = process.env.S13_RESOURCE_KEEP === "1";
const RAW_RESIDUE_CEILING = { workspaces: 12, agents: 12, processes: 96 };

const evidenceRoot = path.join(checkout, "docs", "evidence", "s14");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s14-resource-"));
const harnessRevisions = await harnessRevisionV1(fileURLToPath(import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, cwd: options.cwd ?? checkout, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function paseoList(kind) {
  const listed = run("paseo", [kind, "ls", "--json"], { timeoutMs: 60_000 });
  try {
    const parsed = JSON.parse(listed.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
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
    try { cwd = readlinkSync(path.join("/proc", entry, "cwd")); } catch { /* kernel thread or exited */ }
    try { cmdline = readFileSync(path.join("/proc", entry, "cmdline"), "utf8").replace(/\0/g, " "); } catch { /* exited */ }
    if (cwd.startsWith(root) || cmdline.includes(root)) owned.push({ pid: Number(entry), cwd, cmdline: cmdline.slice(0, 300) });
  }
  return owned;
}

function ownedSnapshot() {
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
      runningAgents: agents.filter((agent) => agent.status === "running").length,
      idleAgents: agents.filter((agent) => agent.status === "idle").length,
      processes: processes.length
    }
  };
}

function terminateOwnedProcesses(processes) {
  const terminated = [];
  for (const process of processes) {
    try { kill(process.pid, "SIGTERM"); terminated.push(process.pid); } catch { /* already exited */ }
  }
  return terminated;
}

async function reconcile(preserveNonTerminal) {
  const snapshot = ownedSnapshot();
  const isPreserved = (kind, id) => Boolean(preserveNonTerminal?.[kind]?.some((entry) => (kind === "workspaces" ? entry.workspaceId : kind === "agents" ? entry.id : entry.pid) === id));
  const preserved = { workspaces: [], agents: [], processes: [] };
  const archivedWorkspaces = [];
  for (const workspace of snapshot.workspaces) {
    if (isPreserved("workspaces", workspace.workspaceId)) { preserved.workspaces.push(workspace.workspaceId); continue; }
    const attempts = [];
    let archived = { status: null, stderr: "" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      archived = run("paseo", ["workspace", "archive", workspace.workspaceId], { timeoutMs: 120_000 });
      attempts.push({ attempt, exitCode: archived.status, stderr: archived.stderr.slice(0, 200) });
      if (archived.status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
    archivedWorkspaces.push({ workspaceId: workspace.workspaceId, exitCode: archived.status, attempts, cwd: workspace.cwd });
  }
  const archivedAgents = [];
  for (const agent of snapshot.agents) {
    if (isPreserved("agents", agent.id)) { preserved.agents.push(agent.id); continue; }
    const attempts = [];
    let archived = { status: null, stderr: "" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      archived = run("paseo", ["agent", "archive", agent.id], { timeoutMs: 120_000 });
      attempts.push({ attempt, exitCode: archived.status, stderr: archived.stderr.slice(0, 200) });
      if (archived.status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
    archivedAgents.push({ id: agent.id, status: agent.status, exitCode: archived.status, attempts });
  }
  const archivableProcesses = snapshot.processes.filter((process) => !isPreserved("processes", process.pid));
  preserved.processes = snapshot.processes.filter((process) => isPreserved("processes", process.pid)).map((process) => process.pid);
  const terminated = terminateOwnedProcesses(archivableProcesses);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const remaining = ownedSnapshot();
  for (const process of remaining.processes.filter((entry) => !preserved.processes.includes(entry.pid))) {
    try { kill(process.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const afterKill = ownedSnapshot();
  const remainingArchivable = {
    workspaces: afterKill.workspaces.filter((workspace) => !preserved.workspaces.includes(workspace.workspaceId)).length,
    agents: afterKill.agents.filter((agent) => !preserved.agents.includes(agent.id)).length,
    processes: afterKill.processes.filter((process) => !preserved.processes.includes(process.pid)).length
  };
  const preservedIntact = afterKill.workspaces.filter((workspace) => preserved.workspaces.includes(workspace.workspaceId)).length === preserved.workspaces.length
    && afterKill.agents.filter((agent) => preserved.agents.includes(agent.id)).length === preserved.agents.length
    && afterKill.processes.filter((process) => preserved.processes.includes(process.pid)).length === preserved.processes.length;
  return {
    archivedWorkspaces,
    archivedAgents,
    terminatedPids: terminated,
    preservedNonTerminal: preserved,
    preservedCount: preserved.workspaces.length + preserved.agents.length + preserved.processes.length,
    preservedIntact,
    remainingArchivable,
    remainingAfterArchive: remainingArchivable,
    baselineReturned: remainingArchivable.workspaces === 0 && remainingArchivable.agents === 0 && remainingArchivable.processes === 0,
    remainingDetail: afterKill
  };
}

const startedAt = new Date().toISOString();
const baseline = ownedSnapshot();
const iterationRecords = [];
let candidateBuildDigest = null;

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const childRunId = `${runId}-i${iteration}`;
  console.log(`s14 resource-stability iteration ${iteration}/${iterations}: ${childRunId} lane=${lane}`);
  const before = ownedSnapshot();
  const startedAtIteration = new Date().toISOString();
  const child = run(process.execPath, ["tests/packed/s13GovernedOperationCampaign.mjs", checkout], {
    cwd: checkout,
    timeoutMs: (laneTimeoutSeconds + 600) * 1000,
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
  const operationTerminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(laneArtifact?.terminalRecord?.status);
  if (laneArtifact?.candidateBinding?.packedBuild?.buildDigest) candidateBuildDigest ??= laneArtifact.candidateBinding.packedBuild.buildDigest;
  const raw = ownedSnapshot();
  const createdWorkspaces = raw.workspaces.filter((workspace) => !before.workspaces.some((entry) => entry.workspaceId === workspace.workspaceId));
  const createdAgents = raw.agents.filter((agent) => !before.agents.some((entry) => entry.id === agent.id));
  const createdProcesses = raw.processes.filter((process) => !before.processes.some((entry) => entry.pid === process.pid));
  const record = {
    iteration,
    childRunId,
    childExitCode: child.status,
    lane: {
      result: laneArtifact?.result ?? null,
      terminal: laneArtifact?.terminalRecord?.status ?? null,
      bounded: laneArtifact?.terminal?.bounded ?? null,
      durationMs: laneArtifact?.durationMs ?? null,
      artifact: path.relative(checkout, laneArtifactPath),
      candidateBuildDigest: laneArtifact?.candidateBinding?.packedBuild?.buildDigest ?? null
    },
    operationTerminal,
    startedAtIteration,
    finishedAtIteration: new Date().toISOString(),
    before: before.counts,
    rawResidue: { workspaces: raw.counts.workspaces, agents: raw.counts.agents, processes: raw.counts.processes, runningAgents: raw.counts.runningAgents },
    createdWorkspaces: createdWorkspaces.map((workspace) => workspace.workspaceId),
    createdAgents: createdAgents.map((agent) => ({ id: agent.id, status: agent.status })),
    createdProcesses: createdProcesses.map((process) => process.pid),
    rawDetail: raw,
    reconciliation: null,
    baselineAfter: null
  };
  if (!operationTerminal) {
    record.preserved = true;
    record.preservedResources = {
      workspaces: createdWorkspaces.map((workspace) => ({ workspaceId: workspace.workspaceId })),
      agents: createdAgents.map((agent) => ({ id: agent.id })),
      processes: createdProcesses.map((pid) => ({ pid }))
    };
    iterationRecords.push(record);
    break;
  }
  const reconciliation = await reconcile(undefined);
  record.reconciliation = reconciliation;
  record.baselineAfter = reconciliation.remainingAfterArchive;
  iterationRecords.push(record);
}

const final = ownedSnapshot();
const postReconciliationBaseline = iterationRecords.map((record) => record.baselineAfter ?? { workspaces: record.rawResidue.workspaces, agents: record.rawResidue.agents, processes: record.rawResidue.processes });
const growth = (series) => series.length > 1 && series[series.length - 1] > series[0];
const postReconciliationNoGrowth = !(growth(postReconciliationBaseline.map((entry) => entry.workspaces)) || growth(postReconciliationBaseline.map((entry) => entry.agents)) || growth(postReconciliationBaseline.map((entry) => entry.processes)));
const checks = [];
for (const record of iterationRecords) {
  checks.push({ id: `s14.resource.iteration-${record.iteration}.terminal`, ok: record.operationTerminal, message: `lane=${record.lane.result} terminal=${record.lane.terminal}` });
  if (!record.operationTerminal) continue;
  checks.push({ id: `s14.resource.iteration-${record.iteration}.raw-bounded`, ok: record.rawResidue.workspaces <= RAW_RESIDUE_CEILING.workspaces && record.rawResidue.agents <= RAW_RESIDUE_CEILING.agents && record.rawResidue.processes <= RAW_RESIDUE_CEILING.processes, message: `raw workspaces=${record.rawResidue.workspaces} agents=${record.rawResidue.agents} processes=${record.rawResidue.processes} ceiling=${JSON.stringify(RAW_RESIDUE_CEILING)}` });
  checks.push({ id: `s14.resource.iteration-${record.iteration}.baseline-returned`, ok: record.reconciliation?.baselineReturned === true, message: `remaining=${JSON.stringify(record.baselineAfter)}` });
  checks.push({ id: `s14.resource.iteration-${record.iteration}.terminal-only`, ok: record.reconciliation?.preservedIntact === true, message: `preserved=${record.reconciliation?.preservedCount ?? 0} intact=${record.reconciliation?.preservedIntact ?? false}` });
}
checks.push({ id: "s14.resource.no-post-reconciliation-growth", ok: postReconciliationNoGrowth, message: `baselines=${JSON.stringify(postReconciliationBaseline)}` });
const rawAccumulation = iterationRecords.filter((record) => record.operationTerminal).some((record) => record.rawResidue.workspaces > 0 || record.rawResidue.agents > 0 || record.rawResidue.processes > 0);
const reconciliationRequired = iterationRecords.some((record) => record.operationTerminal && record.reconciliation && (record.reconciliation.archivedWorkspaces.length > 0 || record.reconciliation.archivedAgents.length > 0 || record.reconciliation.terminatedPids.length > 0));
const result = checks.every((check) => check.ok) ? "PASS" : "FAIL";
const classification = {
  aehV2_0130: rawAccumulation ? "OPEN_PRODUCT_DEFECT_EVIDENCED" : "CLOSED_BY_PRODUCT",
  evidence: iterationRecords.filter((record) => record.operationTerminal).map((record) => ({ iteration: record.iteration, rawResidue: record.rawResidue, reconciled: Boolean(record.reconciliation?.baselineReturned) })),
  requiredArchitecture: [
    "durable operation ownership -> durable provider/resource ownership",
    "terminal/recovery reconciliation classifying live-owned / terminal-orphan / unknown",
    "safe release/archive provable from terminal operation records",
    "policy-driven concurrency/resource backpressure (no machine-specific memory constant in Core)"
  ],
  note: rawAccumulation
    ? "Terminal operations leave owned workspaces/agents/processes that only campaign-side terminality-gated reconciliation reclaims; the product-side durable reconciliation required by AEH-V2-0130 is not implemented."
    : "No terminal-owned residue was observed without the product reconciliation path."
};

const summary = {
  version: 1,
  slice: "S14",
  round,
  runId,
  campaign: "resource-stability",
  amendment: "CAMPAIGN RESOURCE-LIFECYCLE AMENDMENT (2026-09-29) / AEH-V2-0130",
  generatedAt: new Date().toISOString(),
  startedAt,
  checkout,
  sourceCommit: run("git", ["rev-parse", "HEAD"]).stdout,
  harnessRevisions,
  sharedRoot: root,
  lane,
  iterationCount: iterations,
  iterations: iterationRecords,
  ceilings: { rawResidue: RAW_RESIDUE_CEILING, postReconciliationBaseline: { workspaces: 0, agents: 0, processes: 0 } },
  candidateBuildDigest,
  baseline,
  final,
  trend: {
    rawWorkspacesByIteration: iterationRecords.map((record) => record.rawResidue.workspaces),
    rawAgentsByIteration: iterationRecords.map((record) => record.rawResidue.agents),
    rawProcessesByIteration: iterationRecords.map((record) => record.rawResidue.processes),
    postReconciliationBaselineByIteration: postReconciliationBaseline,
    postReconciliationNoGrowth
  },
  reconciliation: {
    baselineReturned: iterationRecords.filter((record) => record.operationTerminal).every((record) => record.reconciliation?.baselineReturned === true),
    preservedIntact: iterationRecords.filter((record) => record.reconciliation).every((record) => record.reconciliation.preservedIntact === true),
    reconciliationPerformed: reconciliationRequired,
    perIteration: iterationRecords.map((record) => ({ iteration: record.iteration, archivedWorkspaces: record.reconciliation?.archivedWorkspaces.length ?? null, archivedAgents: record.reconciliation?.archivedAgents.length ?? null, terminatedProcesses: record.reconciliation?.terminatedPids.length ?? null }))
  },
  classification,
  checks,
  result
};
const summaryPath = path.join(evidenceRoot, "resource-stability-campaign.json");
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result, classification: classification.aehV2_0130, iterations: iterationRecords.map((record) => ({ iteration: record.iteration, terminal: record.lane.terminal, rawResidue: record.rawResidue, baselineAfter: record.baselineAfter })), reconciliation: summary.reconciliation, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
if (!keepRoot) await fs.rm(root, { recursive: true, force: true });
process.exit(0);
