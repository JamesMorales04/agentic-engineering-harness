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
 * S13 round-20 bounded repeated-operation resource-stability campaign (AEH-V2-0130).
 *
 * Runs a bounded governed operation (default `change-direct`) several times in a shared,
 * isolated TMPDIR without harness-side archiving (`S13_GOV_KEEP=1`), and measures the resources
 * the operations leave behind at the Paseo/runtime boundary:
 *
 *   - campaign-owned Paseo workspaces (cwd under the shared root),
 *   - campaign-owned Paseo agent/session records (cwd under the shared root) by status,
 *   - fixture provider/MCP child processes (cwd or cmdline under the shared root).
 *
 * Trend assertions required by the CAMPAIGN RESOURCE-LIFECYCLE AMENDMENT (2026-09-29):
 *   T1 every terminal operation leaves no running/idle owned session record for its own root,
 *   T2 every terminal operation leaves no fixture provider/MCP child process,
 *   T3 owned workspace/session residue per completed operation is within the declared ceiling,
 *   T4 no monotonic growth of owned workspaces/agents/processes across iterations,
 *   T5 harness reconciliation after measured iterations returns the shared root to baseline
 *      (archive terminal-owned workspaces/agents, terminate orphan processes) and never
 *      archives a resource whose owning operation is not terminal.
 *
 * A failing trend is truthful evidence of AEH-V2-0130, not a harness error. The harness is the
 * verification half of the required architecture; product-side durable ownership/reconciliation
 * must make T1/T3 pass without the harness safety net.
 *
 * Usage: S13_ROUND=20 S13_RUN_ID=r20-resource-1 S13_RESOURCE_ITERATIONS=2 \
 *        node tests/packed/s13ResourceStabilityCampaign.mjs [checkout]
 */

const checkout = path.resolve(process.argv[2] ?? process.cwd());
const round = Number(process.env.S13_ROUND ?? "0");
if (!Number.isSafeInteger(round) || round < 1) throw new Error("S13_ROUND must be a positive integer.");
const runId = (process.env.S13_RUN_ID ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`).trim();
if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("S13_RUN_ID must contain only letters, digits, and hyphens.");
const iterations = Number(process.env.S13_RESOURCE_ITERATIONS ?? "2");
if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 4) throw new Error("S13_RESOURCE_ITERATIONS must be an integer from 2 through 4.");
const lane = (process.env.S13_RESOURCE_LANE ?? "change-direct").trim();
const laneTimeoutSeconds = Number(process.env.S13_RESOURCE_TIMEOUT_SECONDS ?? "1500");
if (!Number.isSafeInteger(laneTimeoutSeconds) || laneTimeoutSeconds < 1 || laneTimeoutSeconds > 1800) throw new Error("S13_RESOURCE_TIMEOUT_SECONDS must be an integer from 1 through 1800.");
const keepRoot = process.env.S13_RESOURCE_KEEP === "1";
const harvest = process.env.S13_RESOURCE_HARVEST === "1";
const PER_OPERATION_WORKSPACE_CEILING = 0;
const PER_OPERATION_AGENT_RESIDUE_CEILING = 0;
const PER_OPERATION_PROCESS_CEILING = 0;

const evidenceRoot = path.join(checkout, "docs", "evidence", "s13");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s13-resource-"));
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
  const procRoot = "/proc";
  let entries = [];
  try { entries = readdirSync(procRoot); } catch { entries = []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cwd = "";
    let cmdline = "";
    try { cwd = readlinkSync(path.join(procRoot, entry, "cwd")); } catch { /* kernel thread or exited */ }
    try { cmdline = readFileSync(path.join(procRoot, entry, "cmdline"), "utf8").replace(/\0/g, " "); } catch { /* exited */ }
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

/**
 * Reconcile the shared root. Per CAMPAIGN RESOURCE-LIFECYCLE AMENDMENT rule 6 / AEH-V2-0112, only
 * resources whose owning operation is proven terminal may be reclaimed; resources of a preserved
 * non-terminal iteration are left untouched and reported (R20-F1). The caller supplies the
 * resource set of the final iteration when its operation was not terminal.
 */
async function reconcile(preserveNonTerminal) {
  const snapshot = ownedSnapshot();
  const isPreserved = (kind, id) => Boolean(preserveNonTerminal?.[kind]?.some((entry) => (kind === "workspaces" ? entry.workspaceId : kind === "agents" ? entry.id : entry.pid) === id));
  const preserved = { workspaces: [], agents: [], processes: [] };
  const archivedWorkspaces = [];
  for (const workspace of snapshot.workspaces) {
    if (isPreserved("workspaces", workspace.workspaceId)) { preserved.workspaces.push(workspace.workspaceId); continue; }
    const archived = run("paseo", ["workspace", "archive", workspace.workspaceId], { timeoutMs: 60_000 });
    archivedWorkspaces.push({ workspaceId: workspace.workspaceId, exitCode: archived.status, cwd: workspace.cwd });
  }
  const archivedAgents = [];
  for (const agent of snapshot.agents) {
    if (isPreserved("agents", agent.id)) { preserved.agents.push(agent.id); continue; }
    const archived = run("paseo", ["agent", "archive", agent.id], { timeoutMs: 60_000 });
    archivedAgents.push({ id: agent.id, status: agent.status, exitCode: archived.status });
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
  // A terminated/archived preserved resource is itself a violation: prove every preserved id survives.
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
    remainingAfterArchive: { workspaces: remainingArchivable.workspaces, agents: remainingArchivable.agents, processes: remainingArchivable.processes },
    baselineReturned: remainingArchivable.workspaces === 0 && remainingArchivable.agents === 0 && remainingArchivable.processes === 0,
    remainingDetail: afterKill
  };
}

const startedAt = new Date().toISOString();
const baseline = ownedSnapshot();
const iterationRecords = [];

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const childRunId = `${runId}-i${iteration}`;
  console.log(`resource-stability iteration ${iteration}/${iterations}: ${childRunId} lane=${lane}`);
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
  const laneArtifactPath = path.join(evidenceRoot, "governed-lanes", `round-${round}`, childRunId, `${lane}.json`);
  let laneArtifact;
  try { laneArtifact = JSON.parse(await fs.readFile(laneArtifactPath, "utf8")); } catch { laneArtifact = undefined; }
  const after = ownedSnapshot();
  const operationTerminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(laneArtifact?.terminalRecord?.status);
  const createdWorkspaces = after.workspaces.filter((workspace) => !before.workspaces.some((entry) => entry.workspaceId === workspace.workspaceId));
  const createdAgents = after.agents.filter((agent) => !before.agents.some((entry) => entry.id === agent.id));
  iterationRecords.push({
    iteration,
    childRunId,
    childExitCode: child.status,
    lane: { result: laneArtifact?.result ?? null, terminal: laneArtifact?.terminalRecord?.status ?? null, bounded: laneArtifact?.terminal?.bounded ?? null, durationMs: laneArtifact?.durationMs ?? null, artifact: path.relative(checkout, laneArtifactPath) },
    operationTerminal,
    startedAtIteration,
    finishedAtIteration: new Date().toISOString(),
    before: before.counts,
    after: after.counts,
    createdWorkspaces: createdWorkspaces.map((workspace) => workspace.workspaceId),
    createdAgents: createdAgents.map((agent) => ({ id: agent.id, status: agent.status })),
    createdProcesses: after.processes.filter((process) => !before.processes.some((entry) => entry.pid === process.pid)).map((process) => process.pid),
    afterDetail: after
  });
  if (!operationTerminal) {
    // The amendment forbids archiving while terminality is unproven; preserve and stop measuring.
    iterationRecords.at(-1).preserved = true;
    break;
  }
}

const final = ownedSnapshot();
const trend = {
  ownedWorkspacesByIteration: iterationRecords.map((record) => record.after.workspaces),
  ownedAgentsByIteration: iterationRecords.map((record) => record.after.agents),
  ownedProcessesByIteration: iterationRecords.map((record) => record.after.processes),
  monotonicGrowth: (series) => series.length > 1 && series[series.length - 1] > series[0]
};
const checks = [];
for (const record of iterationRecords) {
  checks.push({ id: `resource-stability.iteration-${record.iteration}-terminal`, ok: record.operationTerminal, message: `lane=${record.lane.result} terminal=${record.lane.terminal}` });
  if (!record.operationTerminal) continue;
  checks.push({ id: `resource-stability.iteration-${record.iteration}-sessions-quiescent`, ok: record.afterDetail.counts.runningAgents === 0, message: `runningAgents=${record.afterDetail.counts.runningAgents} idleAgents=${record.afterDetail.counts.idleAgents}` });
  checks.push({ id: `resource-stability.iteration-${record.iteration}-processes-reaped`, ok: record.afterDetail.counts.processes <= PER_OPERATION_PROCESS_CEILING, message: `fixtureProcesses=${record.afterDetail.counts.processes}` });
  checks.push({ id: `resource-stability.iteration-${record.iteration}-workspace-residue`, ok: record.createdWorkspaces.length <= PER_OPERATION_WORKSPACE_CEILING, message: `createdWorkspaces=${record.createdWorkspaces.length} ceiling=${PER_OPERATION_WORKSPACE_CEILING}` });
  checks.push({ id: `resource-stability.iteration-${record.iteration}-agent-residue`, ok: record.createdAgents.length <= PER_OPERATION_AGENT_RESIDUE_CEILING, message: `createdAgents=${record.createdAgents.length} ceiling=${PER_OPERATION_AGENT_RESIDUE_CEILING}` });
}
checks.push({ id: "resource-stability.no-monotonic-growth", ok: !(trend.monotonicGrowth(trend.ownedWorkspacesByIteration) || trend.monotonicGrowth(trend.ownedAgentsByIteration) || trend.monotonicGrowth(trend.ownedProcessesByIteration)), message: `workspaces=${JSON.stringify(trend.ownedWorkspacesByIteration)} agents=${JSON.stringify(trend.ownedAgentsByIteration)} processes=${JSON.stringify(trend.ownedProcessesByIteration)}` });

const preservedNonTerminal = iterationRecords.at(-1)?.preserved ? {
  workspaces: iterationRecords.at(-1).createdWorkspaces.map((workspaceId) => ({ workspaceId })),
  agents: iterationRecords.at(-1).createdAgents.map((agent) => ({ id: agent.id })),
  processes: iterationRecords.at(-1).createdProcesses.map((pid) => ({ pid }))
} : undefined;
let reconciliation = null;
if (harvest || !keepRoot) reconciliation = await reconcile(preservedNonTerminal);
if (reconciliation) {
  checks.push({ id: "resource-stability.baseline-returned", ok: reconciliation.baselineReturned, message: `remainingWorkspaces=${reconciliation.remainingAfterArchive.workspaces} remainingAgents=${reconciliation.remainingAfterArchive.agents} remainingProcesses=${reconciliation.remainingAfterArchive.processes}` });
  checks.push({ id: "resource-stability.reconciliation-terminal-only", ok: reconciliation.preservedIntact, message: `preservedNonTerminal=${reconciliation.preservedCount} intact=${reconciliation.preservedIntact} (no non-terminal-owned resource archived or terminated; AEH-V2-0112)` });
}
const reconciliationComplete = Boolean(reconciliation?.baselineReturned && reconciliation?.preservedIntact);
if (!keepRoot && reconciliationComplete && !reconciliation?.preservedCount) await fs.rm(root, { recursive: true, force: true });
else if (!keepRoot && reconciliation?.preservedCount) console.log(`shared root preserved (non-terminal resources): ${root}`);
if (reconciliation) reconciliation.rootRemoved = !keepRoot && reconciliationComplete && !reconciliation.preservedCount;

const summary = {
  version: 1,
  slice: "S13",
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
  iterations,
  ceilings: { workspaces: PER_OPERATION_WORKSPACE_CEILING, agents: PER_OPERATION_AGENT_RESIDUE_CEILING, processes: PER_OPERATION_PROCESS_CEILING },
  baseline,
  iterationRecords,
  final,
  trend: { ownedWorkspacesByIteration: trend.ownedWorkspacesByIteration, ownedAgentsByIteration: trend.ownedAgentsByIteration, ownedProcessesByIteration: trend.ownedProcessesByIteration },
  checks,
  reconciliation,
  result: checks.every((check) => check.ok) ? "PASS" : "FAIL"
};
summary.stabilityVerdict = summary.result === "PASS"
  ? "RESOURCE_STABLE"
  : "RESOURCE_ACCUMULATION_OBSERVED (AEH-V2-0130 evidence; required architecture is not yet implemented)";
const summaryPath = path.join(evidenceRoot, `s13-resource-stability-round-${round}-${runId}.json`);
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
const summaryDigest = crypto.createHash("sha256").update(await fs.readFile(summaryPath)).digest("hex");
console.log(JSON.stringify({ result: summary.result, verdict: summary.stabilityVerdict, iterations: iterationRecords.map((record) => ({ iteration: record.iteration, terminal: record.lane.terminal, counts: record.after, createdWorkspaces: record.createdWorkspaces.length, createdAgents: record.createdAgents.length, createdProcesses: record.createdProcesses.length })), reconciliation: reconciliation ? { baselineReturned: reconciliation.baselineReturned, remaining: reconciliation.remainingAfterArchive } : null, immutableSummaryDigest: summaryDigest, evidence: path.relative(checkout, summaryPath) }, null, 2));
if (keepRoot) console.log(`sharedRoot kept: ${root}`);
process.exit(0);
